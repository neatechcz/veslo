import solid from "eslint-plugin-solid";
import tseslint from "typescript-eslint";

const APP_TYPESCRIPT_FILES = ["packages/app/src/**/*.{ts,tsx}"];
const SOLID_REACTIVITY_GATE_FILES = [
  "packages/app/src/app/context/app-route-sync.ts",
  "packages/app/src/app/context/session-event-stream.ts",
  "packages/app/src/app/context/session-queue-drain-controller.ts",
  "packages/app/src/app/context/session-route-sync.ts",
  "packages/app/src/app/context/sidebar-workspace-sessions.ts",
  "packages/app/src/app/context/veslo-server-connection.ts",
  "packages/app/src/app/context/workspace-connection-state.ts",
  "packages/app/src/app/context/workspace-session-snapshots.ts",
  "packages/app/src/app/context/workspace-switch-overlay-state.ts",
  "packages/app/src/app/pages/dashboard.tsx",
  "packages/app/src/app/pages/dashboard-tab-refresh-controller.ts",
  "packages/app/src/app/pages/session-search-command-controller.ts",
];

export default [
  {
    ignores: [
      "**/.next/**",
      "**/dist/**",
      "**/node_modules/**",
      "**/target/**",
      "packages/app/src/**/*.test.ts",
      "packages/app/src/**/*.test.tsx",
      "packages/app/src/**/*.dom-test.ts",
      "packages/app/src/**/*.dom-test.tsx",
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
      "packages/app/src/**/*.dom-test.ts",
      "packages/app/src/**/*.dom-test.tsx",
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
  {
    files: SOLID_REACTIVITY_GATE_FILES,
    rules: {
      "solid/reactivity": "error",
    },
  },
];
