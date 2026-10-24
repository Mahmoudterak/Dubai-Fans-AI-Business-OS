import type { NextConfig } from "next";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

// The monorepo keeps one .env at the root; Next only reads apps/web/.env by itself.
// Real environment variables (e.g. on Vercel) always win.
const rootEnv = path.resolve(process.cwd(), "../../.env");
if (existsSync(rootEnv)) {
  for (const line of readFileSync(rootEnv, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m?.[1] && process.env[m[1]] === undefined) process.env[m[1]] = (m[2] ?? "").replace(/^["']|["']$/g, "");
  }
}

const isProd = process.env.NODE_ENV === "production";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  {
    key: "Content-Security-Policy",
    // Clerk needs its own script/frame/connect origins (see docs/operations/deployment.md).
    value: [
      "default-src 'self'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "object-src 'none'",
      "img-src 'self' data: https:",
      "font-src 'self' data:",
      "style-src 'self' 'unsafe-inline'",
      `script-src 'self' 'unsafe-inline'${isProd ? "" : " 'unsafe-eval'"} https://*.clerk.accounts.dev https://*.clerk.com`,
      "connect-src 'self' https://*.clerk.accounts.dev https://*.clerk.com",
      "frame-src https://*.clerk.accounts.dev https://*.clerk.com",
      "worker-src 'self' blob:",
    ].join("; "),
  },
  ...(isProd ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" }] : []),
];

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: [
    "@dfos/auth",
    "@dfos/ai",
    "@dfos/config",
    "@dfos/contracts",
    "@dfos/db",
    "@dfos/domain",
    "@dfos/integrations",
    "@dfos/observability",
    "@dfos/orchestrator",
  ],
  serverExternalPackages: ["postgres", "@aws-sdk/client-s3", "@aws-sdk/s3-request-presigner"],
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default config;
