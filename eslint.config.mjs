import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // CS-1: types are never bypassed. No `any`, no ts-ignore/ts-expect-error.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/ban-ts-comment": "error",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Compiled output for the worker and the node test runner
    // (tsconfig.node.json). CommonJS by necessity, so it is not source.
    ".node-build/**",
    // Owner's standalone Figma token generator (CommonJS by design). It sits
    // outside coding-standard.md's scope (/app, /modules, /worker, /lib, /tests)
    // and is never edited by the build (DS-1).
    "generate-css-vars.js",
  ]),
]);

export default eslintConfig;
