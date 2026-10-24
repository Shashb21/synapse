import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

/**
 * Design tokens only (KAN-158): font sizes come from the type scale in
 * globals.css (text-caption … text-display) and colour from the semantic tokens
 * (known, unknown, destructive, primary, muted-foreground), never ad-hoc values.
 */
const TOKEN_MESSAGE_SIZE = "Use a type-scale token (text-caption, text-callout, text-body, text-headline, text-title-2, text-title-1, text-display) instead of text-[Npx].";
const TOKEN_MESSAGE_COLOUR = "Use a semantic colour token (known, unknown, destructive, primary, muted-foreground) instead of a raw Tailwind palette colour.";
const SIZE = "/(^|\\s)text-\\[\\d+(\\.\\d+)?px\\]/";
const COLOUR = "/(^|[\\s:])(text|bg|border|ring|fill|stroke)-(emerald|green|teal|amber|yellow|orange|rose|red|violet|indigo|fuchsia|purple|blue|sky)-\\d{2,3}/";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ["src/**/*.tsx"],
    ignores: ["src/components/brand-mark.tsx", "src/components/room/**"],
    rules: {
      "no-restricted-syntax": [
        "error",
        { selector: `Literal[value=${SIZE}]`, message: TOKEN_MESSAGE_SIZE },
        { selector: `TemplateElement[value.raw=${SIZE}]`, message: TOKEN_MESSAGE_SIZE },
        { selector: `Literal[value=${COLOUR}]`, message: TOKEN_MESSAGE_COLOUR },
        { selector: `TemplateElement[value.raw=${COLOUR}]`, message: TOKEN_MESSAGE_COLOUR },
      ],
    },
  },
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
