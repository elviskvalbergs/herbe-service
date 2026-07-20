import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
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
    // vitest --coverage output (gitignored, but present locally after a run).
    "coverage/**",
    // next-pwa's generated service worker (gitignored, but present locally
    // after a `pnpm build` — see next.config.ts).
    "public/sw.js",
    "public/workbox-*.js",
    // next-pwa's bundled custom worker output (worker/index.ts, WS1 Task 10)
    // — same generated-on-every-build story as the two entries above.
    "public/worker-*.js",
  ]),
]);

export default eslintConfig;
