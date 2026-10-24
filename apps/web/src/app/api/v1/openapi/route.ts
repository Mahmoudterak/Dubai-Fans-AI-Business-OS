import { NextResponse } from "next/server";
import { getEnv } from "@dfos/config";
import { buildOpenApi } from "@/server/openapi";

export function GET() {
  return NextResponse.json(buildOpenApi(getEnv().APP_BASE_URL));
}
