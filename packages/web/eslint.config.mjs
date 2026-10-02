import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescript from "eslint-config-next/typescript";

/**
 * Flat config for @payswap/web. eslint-config-next 16 ships native flat
 * configs (the legacy FlatCompat translation crashed ESLint 9 with a
 * circular-structure error), so the core-web-vitals and typescript presets
 * are spread directly.
 */
const eslintConfig = [
  {
    ignores: [
      ".next/**",
      "out/**",
      "coverage/**",
      "node_modules/**",
      "next-env.d.ts",
    ],
  },
  ...coreWebVitals,
  ...typescript,
];

export default eslintConfig;
