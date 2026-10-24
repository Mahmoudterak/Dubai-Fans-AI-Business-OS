import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { ctxFromSession } from "@dfos/auth";
import { getEnv } from "@dfos/config";
import { getDb, idempotencyKeys } from "@dfos/db";
import { AppError, assertCan, canonicalJson, isAppError, sha256, type Permission } from "@dfos/domain";
import { logger } from "@dfos/observability";
import type { Ctx } from "@dfos/orchestrator";
import { checkRateLimit } from "./rate-limit";
import { getSession, type Session } from "./session";

export interface RouteOptions<B extends z.ZodType | undefined, Q extends z.ZodType | undefined> {
  /** Checked on the server for every call. Hiding buttons in the UI is never relied on. */
  permission?: Permission;
  body?: B;
  query?: Q;
  /** Requests per minute per user for this route. */
  rateLimit?: number;
  /** Honour the Idempotency-Key header (replays the stored response for the same key). */
  idempotent?: boolean;
}

type Infer<T> = T extends z.ZodType ? z.infer<T> : undefined;

interface Handler<B, Q, P> {
  (args: {
    req: NextRequest;
    ctx: Ctx;
    session: Session;
    body: B;
    query: Q;
    params: P;
    requestId: string;
    idempotencyKey?: string;
  }): Promise<unknown>;
}

export class ApiResponse {
  constructor(
    readonly status: number,
    readonly data: unknown,
  ) {}
}
/** Return this from a handler to set a non-200 status (e.g. 201, 202). */
export const respond = (status: number, data: unknown) => new ApiResponse(status, data);

function errorResponse(err: unknown, requestId: string) {
  if (err instanceof z.ZodError) {
    return NextResponse.json(
      { error: { code: "validation_failed", message: "Invalid request", details: err.issues }, requestId },
      { status: 422, headers: { "x-request-id": requestId } },
    );
  }
  if (isAppError(err)) {
    return NextResponse.json(
      { error: { code: err.code, message: err.message, details: err.details }, requestId },
      { status: err.status, headers: { "x-request-id": requestId } },
    );
  }
  logger.error("unhandled api error", { requestId, err });
  return NextResponse.json(
    { error: { code: "internal_error", message: "Unexpected server error" }, requestId },
    { status: 500, headers: { "x-request-id": requestId } },
  );
}

/** False for cross-site form/fetch posts that would ride on the session cookie. */
export function isSameOrigin(req: NextRequest) {
  if (req.method === "GET" || req.method === "HEAD") return true;
  const origin = req.headers.get("origin");
  if (!origin) return true; // non-browser clients (curl, server-to-server) send no Origin
  const allowed = new Set([new URL(getEnv().APP_BASE_URL).origin, req.nextUrl.origin]);
  return allowed.has(origin);
}

function assertSameOrigin(req: NextRequest) {
  if (!isSameOrigin(req)) throw new AppError("forbidden", "Cross-origin request blocked");
}

export const crossOriginBlocked = () =>
  NextResponse.json({ error: { code: "forbidden", message: "Cross-origin request blocked" } }, { status: 403 });

export function route<
  B extends z.ZodType | undefined = undefined,
  Q extends z.ZodType | undefined = undefined,
  P = Record<string, string>,
>(opts: RouteOptions<B, Q>, handler: Handler<Infer<B>, Infer<Q>, P>) {
  return async (req: NextRequest, context: { params: Promise<P> }) => {
    const requestId = req.headers.get("x-request-id") ?? crypto.randomUUID();
    try {
      assertSameOrigin(req);
      const session = await getSession();
      if (!session) throw new AppError("unauthenticated", "Sign in required");
      const ctx = ctxFromSession(getDb(), session.info, requestId);
      if (!ctx) throw new AppError("forbidden", "You are not a member of any organization");
      if (opts.permission && ctx.actor.type === "user") assertCan(ctx.actor.role, opts.permission);

      const limit = opts.rateLimit ?? (req.method === "GET" ? 240 : 60);
      const rl = checkRateLimit(`${session.user.id}:${req.method}:${req.nextUrl.pathname.replace(/[0-9a-f-]{36}/g, ":id")}`, limit, 60_000);
      if (!rl.allowed) throw new AppError("rate_limited", `Too many requests. Retry in ${Math.ceil(rl.retryAfterMs / 1000)}s`);

      const params = (await context.params) ?? ({} as P);
      const query = opts.query ? opts.query.parse(Object.fromEntries(req.nextUrl.searchParams)) : undefined;
      let rawBody: unknown = undefined;
      if (opts.body) {
        const text = await req.text();
        if (text.length > 256_000) throw new AppError("validation_failed", "Request body too large");
        try {
          rawBody = text ? JSON.parse(text) : {};
        } catch {
          throw new AppError("validation_failed", "Body must be JSON");
        }
      }
      const body = opts.body ? opts.body.parse(rawBody) : undefined;

      const idempotencyKey = req.headers.get("idempotency-key") ?? undefined;
      const run = async () =>
        handler({ req, ctx, session, body: body as Infer<B>, query: query as Infer<Q>, params, requestId, idempotencyKey });

      const result =
        opts.idempotent && idempotencyKey
          ? await withIdempotency(ctx, session.user.id, idempotencyKey, req.nextUrl.pathname, rawBody, run)
          : await run();

      const status = result instanceof ApiResponse ? result.status : 200;
      const data = result instanceof ApiResponse ? result.data : result;
      return NextResponse.json({ data, requestId }, { status, headers: { "x-request-id": requestId } });
    } catch (err) {
      return errorResponse(err, requestId);
    }
  };
}

/**
 * Same key + same body → the first response is replayed and the action is not repeated.
 * Same key + different body → 409. A key whose first request is still running → 409.
 */
async function withIdempotency(
  ctx: Ctx,
  userId: string,
  key: string,
  routePath: string,
  body: unknown,
  run: () => Promise<unknown>,
) {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(key)) throw new AppError("validation_failed", "Invalid Idempotency-Key");
  const requestHash = sha256(canonicalJson(body ?? null));
  const db = ctx.db;
  const inserted = await db
    .insert(idempotencyKeys)
    .values({ organizationId: ctx.organizationId, userId, key, route: routePath, requestHash })
    .onConflictDoNothing()
    .returning();
  if (!inserted.length) {
    const [existing] = await db
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.organizationId, ctx.organizationId), eq(idempotencyKeys.key, key), eq(idempotencyKeys.route, routePath)));
    if (!existing || existing.requestHash !== requestHash) {
      throw new AppError("idempotency_conflict", "Idempotency-Key was already used with a different request");
    }
    if (existing.statusCode === null) throw new AppError("idempotency_conflict", "A request with this key is still in progress");
    return new ApiResponse(existing.statusCode, existing.response);
  }
  const row = inserted[0]!;
  try {
    const result = await run();
    const status = result instanceof ApiResponse ? result.status : 200;
    const data = result instanceof ApiResponse ? result.data : result;
    await db.update(idempotencyKeys).set({ statusCode: status, response: JSON.parse(JSON.stringify(data ?? null)) }).where(eq(idempotencyKeys.id, row.id));
    return new ApiResponse(status, data);
  } catch (err) {
    // Failed requests may be retried with the same key.
    await db.delete(idempotencyKeys).where(eq(idempotencyKeys.id, row.id));
    throw err;
  }
}

export const uuidParam = z.uuid();
export function parseId(id: string) {
  const r = uuidParam.safeParse(id);
  if (!r.success) throw new AppError("not_found", "Not found");
  return r.data;
}
