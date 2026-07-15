import solid from "eslint-plugin-solid";
import tseslint from "typescript-eslint";

const APP_TYPESCRIPT_FILES = ["packages/app/src/**/*.{ts,tsx}"];

export default [
  {
    ignores: [
      "**/.next/**",
      "**/dist/**",
      "**/node_modules/**",
      "**/target/**",
      "packages/app/src/**/*.test.ts",
      "packages/app/src/**/*.test.tsx",
      "packages/app/src/**/tests/**",
    ],
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
  },
  {
    files: APP_TYPESCRIPT_FILES,
    ignores: [
      "packages/app/src/**/*.test.ts",
      "packages/app/src/**/*.test.tsx",
      "packages/app/src/**/tests/**",
    ],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      "@typescript-eslint": tseslint.plugin,
      ...solid.configs["flat/typescript"].plugins,
    },
    rules: {
      // The existing app baseline has 122 reactivity diagnostics. Enable this
      // only after the owner-level remediation can make it a real gate.
      "solid/no-react-deps": "error",
      "solid/jsx-no-duplicate-props": "error",
      "solid/jsx-no-undef": ["error", { typescriptEnabled: true }],
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: false },
      ],
    },
  },
];
