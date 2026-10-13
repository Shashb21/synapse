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
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Agent worktrees, browser-tool output and test artifacts are not this project's source.
    ".claude/**",
    ".playwright-mcp/**",
    ".superpowers/**",
    "test-results/**",
    "playwright-report/**",
  ]),
]);

export default eslintConfig;
