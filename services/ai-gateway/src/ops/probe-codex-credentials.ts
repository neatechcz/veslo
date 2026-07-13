import { pathToFileURL } from "node:url";

import { MySqlCredentialRepository } from "../credentials/mysql-repository.js";
import { MySqlSecretStore } from "../credentials/mysql-secret-store.js";
import { createDb } from "../db/index.js";
import { env } from "../env.js";
import { CODEX_DEFAULT_MODEL } from "../providers/codex-model-catalog.js";
import { CachedCodexCredentialStatusProvider, type CodexCredentialStatusProvider } from "../usage/codex-status.js";
import {
  runCodexCredentialProbe,
  type CodexCredentialProbeRepository,
} from "./codex-credential-probe.js";
import { assertValidCodexModelId } from "./codex-model-migration.js";

export type CredentialProbeCliArgs = {
  model: string;
};

export type CodexCredentialProbeCliRuntime = {
  repository: CodexCredentialProbeRepository;
  statusProvider: CodexCredentialStatusProvider;
  close(): Promise<void>;
};

export type CodexCredentialProbeCliDependencies = {
  databaseUrl: string;
  secretKey: string;
  openRuntime(input: {
    databaseUrl: string;
    secretKey: string;
    model: string;
  }): CodexCredentialProbeCliRuntime;
  writeOutput(line: string): void;
};

export function parseCredentialProbeCliArgs(argv: string[]): CredentialProbeCliArgs {
  let model = CODEX_DEFAULT_MODEL;
  let sawModel = false;
  const firstArgumentIndex = argv[0] === "--" ? 1 : 0;

  for (let index = firstArgumentIndex; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--model" && !sawModel) {
      const value = argv[index + 1];
      if (typeof value !== "string") {
        throw new Error("Invalid probe arguments");
      }
      model = value;
      sawModel = true;
      index += 1;
      continue;
    }
    throw new Error("Invalid probe arguments");
  }

  assertValidCodexModelId(model);
  return { model };
}

export async function runCodexCredentialProbeCli(
  argv: string[],
  dependencies: CodexCredentialProbeCliDependencies = defaultDependencies,
): Promise<0 | 1> {
  const args = parseCredentialProbeCliArgs(argv);
  const runtime = dependencies.openRuntime({
    databaseUrl: dependencies.databaseUrl,
    secretKey: dependencies.secretKey,
    model: args.model,
  });

  try {
    const credentials = await runCodexCredentialProbe({
      repository: runtime.repository,
      statusProvider: runtime.statusProvider,
      model: args.model,
    });
    const passed = credentials.filter((credential) => credential.outcome === "ok").length;
    const failed = credentials.length - passed;

    dependencies.writeOutput(JSON.stringify({
      model: args.model,
      total: credentials.length,
      passed,
      failed,
      credentials,
    }));

    return failed > 0 ? 1 : 0;
  } finally {
    await runtime.close();
  }
}

const defaultDependencies: CodexCredentialProbeCliDependencies = {
  databaseUrl: env.databaseUrl,
  secretKey: env.secretKey,
  openRuntime(input) {
    const handle = createDb(input.databaseUrl);
    const repository = new MySqlCredentialRepository(handle.db);
    const secretStore = new MySqlSecretStore(handle.db, input.secretKey);
    const statusProvider = new CachedCodexCredentialStatusProvider({
      model: input.model,
      loadCredentialAuthJson: async (credentialId) => {
        const credential = await repository.getCredentialRecordById(credentialId);
        if (!credential || credential.deletedAt) {
          return null;
        }
        const secret = await secretStore.get(credential.secretRef);
        return secret.kind === "codex_auth_json" ? secret.authJson : null;
      },
      saveCredentialAuthJson: async (credentialId, authJson) => {
        const credential = await repository.getCredentialRecordById(credentialId);
        if (!credential || credential.deletedAt) {
          return;
        }
        await secretStore.replace(credential.secretRef, {
          kind: "codex_auth_json",
          authJson,
        });
      },
    });

    return {
      repository,
      statusProvider,
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
  void runCodexCredentialProbeCli(process.argv.slice(2))
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch(() => {
      console.error("Codex credential probe failed.");
      process.exitCode = 1;
    });
}
