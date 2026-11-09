import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    ".vercel/**",
    "out/**",
    "build/**",
    "_update-backups/**",
    // Versioned third-party OCR runtimes copied by build:local-ocr.
    "public/local-ocr/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
