import { createHash } from "node:crypto";
import { AppError } from "@dfos/domain";

export interface InspectedImage {
  contentType: "image/jpeg";
  extension: "jpg";
  width: number;
  height: number;
  sha256: string;
}

/**
 * Validates an upload from its bytes, not its filename or declared type.
 * Instagram's Content Publishing API accepts JPEG only (no MPO/JPS), so only baseline/progressive
 * JPEG is allowed for now.
 */
export function inspectImage(bytes: Uint8Array, maxBytes: number): InspectedImage {
  if (bytes.byteLength === 0) throw new AppError("validation_failed", "Empty file");
  if (bytes.byteLength > maxBytes) {
    throw new AppError("validation_failed", `File is larger than ${Math.round(maxBytes / 1024 / 1024)} MB`);
  }
  if (!(bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)) {
    throw new AppError("validation_failed", "Only JPEG images are accepted (Instagram publishing supports JPEG only)");
  }
  const size = jpegSize(bytes);
  if (!size) throw new AppError("validation_failed", "Could not read JPEG dimensions; the file may be corrupt");
  if (hasMpoMarker(bytes)) throw new AppError("validation_failed", "Extended JPEG formats (MPO) are not supported by Instagram");
  return {
    contentType: "image/jpeg",
    extension: "jpg",
    width: size.width,
    height: size.height,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

/** Reads width/height from the first SOFn marker. */
export function jpegSize(b: Uint8Array): { width: number; height: number } | null {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1]!;
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      i += 2;
      continue;
    }
    const len = (b[i + 2]! << 8) | b[i + 3]!;
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      const height = (b[i + 5]! << 8) | b[i + 6]!;
      const width = (b[i + 7]! << 8) | b[i + 8]!;
      return width && height ? { width, height } : null;
    }
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}

function hasMpoMarker(b: Uint8Array) {
  // MPO files carry an APP2 segment with the "MPF\0" identifier.
  for (let i = 2; i + 8 < Math.min(b.length, 65536); i++) {
    if (b[i] === 0xff && b[i + 1] === 0xe2 && b[i + 4] === 0x4d && b[i + 5] === 0x50 && b[i + 6] === 0x46 && b[i + 7] === 0x00) return true;
  }
  return false;
}

/** Instagram feed images must have an aspect ratio between 4:5 and 1.91:1. */
export function instagramAspectOk(width: number, height: number) {
  const r = width / height;
  return r >= 0.8 - 0.005 && r <= 1.91 + 0.005;
}

/** Storage keys never contain user-supplied names. */
export function mediaStorageKey(organizationId: string, id: string, extension: string) {
  return `orgs/${organizationId}/media/${id}.${extension}`;
}

/** Keeps a display name for the UI only; never used in paths. */
export function safeDisplayName(name: string | undefined) {
  if (!name) return null;
  return name.replace(/[^\p{L}\p{N}._ -]/gu, "_").slice(0, 120);
}
