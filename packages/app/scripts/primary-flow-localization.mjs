import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (relativePath) => readFileSync(new URL(relativePath, import.meta.url), "utf8");

const checks = [
  {
    file: "../src/app/pages/session.tsx",
    forbidden: [
      "Start a new session",
      "What do you want to do?",
      "Automate your browser",
      "Give me a soul",
      "Choose folder",
      "Loading earlier messages...",
      "Quick actions",
      "Permission Required",
    ],
  },
  {
    file: "../src/app/pages/soul.tsx",
    forbidden: [
      "Soul and Heartbeat",
      "Enable soul mode",
      "Run heartbeat now",
      "Current focus",
      "Boundaries and guardrails",
    ],
  },
  {
    file: "../src/app/components/session/composer.tsx",
    forbidden: [
      "Remote workspace",
      "Local workspace",
      "Choose folder",
      "Try it now: set up my CRM in Notion",
      "Loading agents...",
      "Thinking effort",
    ],
  },
  {
    file: "../src/app/components/session/workspace-session-list.tsx",
    forbidden: [
      "Edit name",
      "New session",
      "New worker",
      "Connect remote",
      "No sessions yet.",
      "Loading tasks...",
      "Remove workspace",
    ],
  },
  {
    file: "../src/app/components/session/inbox-panel.tsx",
    forbidden: [
      "Share files with your remote worker.",
      "Refresh inbox",
      "Drop files or click to upload",
      "Connect to see inbox files.",
      "No inbox files yet.",
    ],
  },
];

const failures = [];

for (const check of checks) {
  const source = read(check.file);
  const hits = check.forbidden.filter((value) => source.includes(value));
  if (hits.length > 0) {
    failures.push({ file: check.file, hits });
  }
}

assert.equal(
  failures.length,
  0,
  `Primary flow localization regressions found:\n${failures
    .map((failure) => `${failure.file}: ${failure.hits.join(", ")}`)
    .join("\n")}`,
);

console.log(JSON.stringify({ ok: true, checkedFiles: checks.length }));
