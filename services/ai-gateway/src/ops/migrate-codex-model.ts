import { pathToFileURL } from "node:url";

import { createDb } from "../db/index.js";
import { env } from "../env.js";
import { CODEX_DEFAULT_MODEL } from "../providers/codex-model-catalog.js";
import {
  assertValidCodexModelId,
  MySqlCodexPolicyMigrationStore,
  runCodexModelMigration,
  type CodexPolicyMigrationStore,
} from "./codex-model-migration.js";

export type MigrationCliArgs = {
  apply: boolean;
  model: string;
};

export type CodexModelMigrationCliDependencies = {
  databaseUrl: string;
  openStore(databaseUrl: string): {
    store: CodexPolicyMigrationStore;
    close(): Promise<void>;
  };
  writeOutput(line: string): void;
};

export function parseMigrationCliArgs(argv: string[]): MigrationCliArgs {
  let apply = false;
  let model = CODEX_DEFAULT_MODEL;
  let sawApply = false;
  let sawModel = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply" && !sawApply) {
      apply = true;
      sawApply = true;
      continue;
    }
    if (argument === "--model" && !sawModel) {
      const value = argv[index + 1];
      if (typeof value !== "string") {
        throw new Error("Invalid migration arguments");
      }
      model = value;
      sawModel = true;
      index += 1;
      continue;
    }
    throw new Error("Invalid migration arguments");
  }

  assertValidCodexModelId(model);
  return { apply, model };
}

export async function runCodexModelMigrationCli(
  argv: string[],
  dependencies: CodexModelMigrationCliDependencies = defaultDependencies,
): Promise<void> {
  const args = parseMigrationCliArgs(argv);
  const handle = dependencies.openStore(dependencies.databaseUrl);
  let summary;

  try {
    summary = await runCodexModelMigration({
      store: handle.store,
      model: args.model,
      apply: args.apply,
    });
  } finally {
    await handle.close();
  }

  dependencies.writeOutput(JSON.stringify(summary));
}

const defaultDependencies: CodexModelMigrationCliDependencies = {
  databaseUrl: env.databaseUrl,
  openStore(databaseUrl) {
    const handle = createDb(databaseUrl);
    return {
      store: new MySqlCodexPolicyMigrationStore(handle.db),
      close: handle.close,
    };
  },
  writeOutput(line) {
    console.log(line);
  },
};

const isMain =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  void runCodexModelMigrationCli(process.argv.slice(2)).catch(() => {
    console.error("Codex model migration failed.");
    process.exitCode = 1;
  });
}
