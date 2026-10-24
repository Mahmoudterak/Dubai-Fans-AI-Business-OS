export type ErrorCode =
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "validation_failed"
  | "conflict"
  | "invalid_transition"
  | "approval_required"
  | "approval_invalid"
  | "idempotency_conflict"
  | "rate_limited"
  | "ai_not_configured"
  | "ai_provider_error"
  | "ai_output_invalid"
  | "budget_exceeded"
  | "integration_not_connected"
  | "integration_reauth_required"
  | "integration_missing_permission"
  | "integration_error"
  | "storage_not_configured"
  | "signature_invalid"
  | "agent_disabled"
  | "internal_error";

const statusByCode: Record<ErrorCode, number> = {
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  validation_failed: 422,
  conflict: 409,
  invalid_transition: 409,
  approval_required: 409,
  approval_invalid: 409,
  idempotency_conflict: 409,
  rate_limited: 429,
  ai_not_configured: 503,
  ai_provider_error: 502,
  ai_output_invalid: 502,
  budget_exceeded: 402,
  integration_not_connected: 409,
  integration_reauth_required: 409,
  integration_missing_permission: 409,
  integration_error: 502,
  storage_not_configured: 503,
  signature_invalid: 401,
  agent_disabled: 409,
  internal_error: 500,
};

export class AppError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
    this.status = statusByCode[code];
  }
}

export const isAppError = (e: unknown): e is AppError => e instanceof AppError;
