import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/node_modules/**", "**/.next/**", "**/dist/**", "**/.turbo/**", "**/next-env.d.ts", ".data/**", "packages/db/migrations/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { process: "readonly", console: "readonly", crypto: "readonly", Buffer: "readonly", setTimeout: "readonly", clearTimeout: "readonly", setInterval: "readonly", clearInterval: "readonly", URL: "readonly", URLSearchParams: "readonly", fetch: "readonly", Response: "readonly", Headers: "readonly", AbortController: "readonly", window: "readonly", document: "readonly", NodeJS: "readonly" },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-non-null-assertion": "off",
      // Never run shell commands from app code.
      "no-restricted-imports": ["error", { paths: [{ name: "child_process", message: "Shelling out is not allowed in app code." }, { name: "node:child_process", message: "Shelling out is not allowed in app code." }] }],
    },
  },
);
