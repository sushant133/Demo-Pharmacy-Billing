import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const compat = new FlatCompat({
  baseDirectory: dirname(fileURLToPath(import.meta.url)),
});

const config = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "next-env.d.ts",
      // Gradle's output, and the bridge Capacitor copies in beside it. Neither
      // is ours to fix, and linting them was failing `npm run lint` on three
      // errors in generated code - which is how a quality gate stops being
      // read. Source under android/ (the app manifest, any Java we add) is
      // still linted; only the build directory is skipped.
      "android/**/build/**",
      // The Electron shell: plain CommonJS for Node, with its own package.
      "desktop/**",
    ],
  },
  {
    rules: {
      // Unused code is a smell worth failing on, but an underscore prefix is
      // the conventional way to say "intentionally ignored".
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
];

export default config;
