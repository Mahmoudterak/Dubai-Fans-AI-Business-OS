import { getEnv } from "@dfos/config";
import { AppError } from "@dfos/domain";
import { listMedia, uploadMedia } from "@dfos/orchestrator";
import { respond, route } from "@/server/api";

export const GET = route({ permission: "content.read" }, ({ ctx }) => listMedia(ctx));

/** multipart/form-data with one "file" field. Type is detected from the bytes (JPEG only). */
export const POST = route({ permission: "content.write", rateLimit: 20 }, async ({ ctx, req }) => {
  const max = getEnv().MEDIA_MAX_UPLOAD_BYTES;
  if (Number(req.headers.get("content-length") ?? 0) > max + 64 * 1024) throw new AppError("validation_failed", "File is too large");
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!file || typeof file === "string") throw new AppError("validation_failed", "Missing file");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const asset = await uploadMedia(ctx, { bytes, name: file.name });
  return respond(201, asset);
});
