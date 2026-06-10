import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import type { BunPlugin } from "bun";

const bunRuntime = (globalThis as typeof globalThis & {
  Bun?: {
    build?: (...args: any[]) => Promise<any>;
    argv?: string[];
  };
}).Bun;

if (!bunRuntime?.build || !bunRuntime.argv) {
  console.error("This script must be run with Bun.");
  process.exit(1);
}

const bun = bunRuntime as { build: (...args: any[]) => Promise<any>; argv: string[] };

async function createSolidTransformPlugin(): Promise<BunPlugin> {
  const require = createRequire(import.meta.url);
  const solidPackageJson = realpathSync(require.resolve("@opentui/solid/package.json"));
  const solidRequire = createRequire(solidPackageJson);
  const babel = await import(pathToFileURL(solidRequire.resolve("@babel/core")).href);
  const solidPresetModule = await import(pathToFileURL(solidRequire.resolve("babel-preset-solid")).href);
  const solidPreset = solidPresetModule.default ?? solidPresetModule;

  return {
    name: "veslo-orchestrator-solid",
    setup: (build) => {
      build.onLoad({ filter: /\/node_modules\/solid-js\/dist\/server\.js$/ }, async (args) => {
        const path = args.path.replace("server.js", "solid.js");
        const file = Bun.file(path);
        const code = await file.text();
        return { contents: code, loader: "js" };
      });
      build.onLoad({ filter: /\/node_modules\/solid-js\/store\/dist\/server\.js$/ }, async (args) => {
        const path = args.path.replace("server.js", "store.js");
        const file = Bun.file(path);
        const code = await file.text();
        return { contents: code, loader: "js" };
      });
      build.onLoad({ filter: /\.(js|ts)x$/ }, async (args) => {
        const file = Bun.file(args.path);
        const source = await file.text();
        // Avoid @babel/preset-typescript here. Bun on Windows cannot resolve
        // that preset's pnpm-junctioned transitive deps from @opentui/solid.
        const code = args.path.endsWith(".tsx")
          ? ts.transpileModule(source, {
            compilerOptions: {
              jsx: ts.JsxEmit.Preserve,
              module: ts.ModuleKind.ESNext,
              target: ts.ScriptTarget.ES2022,
            },
            fileName: args.path,
          }).outputText
          : source;
        const transformed = await babel.transformAsync(code, {
          filename: args.path,
          presets: [
            [
              solidPreset,
              {
                moduleName: "@opentui/solid",
                generate: "universal",
              },
            ],
          ],
        });
        return {
          contents: transformed?.code ?? "",
          loader: "js",
        };
      });
    },
  };
}

type BuildOptions = {
  targets: string[];
  outdir: string;
  filename: string;
};

function readArgs(argv: string[]): BuildOptions {
  const options: BuildOptions = {
    targets: [],
    outdir: resolve("dist", "bin"),
    filename: "veslo",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value) continue;

    if (value === "--target") {
      const next = argv[index + 1];
      if (next) {
        options.targets.push(next);
        index += 1;
      }
      continue;
    }

    if (value.startsWith("--target=")) {
      const next = value.slice("--target=".length).trim();
      if (next) options.targets.push(next);
      continue;
    }

    if (value === "--outdir") {
      const next = argv[index + 1];
      if (next) {
        options.outdir = resolve(next);
        index += 1;
      }
      continue;
    }

    if (value.startsWith("--outdir=")) {
      const next = value.slice("--outdir=".length).trim();
      if (next) options.outdir = resolve(next);
      continue;
    }

    if (value === "--filename") {
      const next = argv[index + 1];
      if (next) {
        options.filename = next;
        index += 1;
      }
      continue;
    }

    if (value.startsWith("--filename=")) {
      const next = value.slice("--filename=".length).trim();
      if (next) options.filename = next;
    }
  }

  return options;
}

function outputName(filename: string, target?: string) {
  const needsExe = target ? target.includes("windows") : process.platform === "win32";
  const suffix = target ? `-${target}` : "";
  const ext = needsExe ? ".exe" : "";
  return `${filename}${suffix}${ext}`;
}

function defaultTarget(): string {
  const os = process.platform === "win32" ? "windows" : process.platform;
  return `bun-${os}-${process.arch}`;
}

async function buildOnce(entrypoint: string, outdir: string, filename: string, target?: string) {
  mkdirSync(outdir, { recursive: true });
  const outfile = join(outdir, outputName(filename, target));
  const define: Record<string, string> = {};
  const compileExecutablePath = process.env.BUN_WINDOWS_X64_BASELINE_EXECUTABLE?.trim();
  const pkgPath = resolve("package.json");
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    if (typeof pkg.version === "string" && pkg.version.trim()) {
      define.__VESLO_ORCHESTRATOR_VERSION__ = `\"${pkg.version.trim()}\"`;
    }
  } catch {
    // ignore
  }

  const resolvedTarget = target ?? defaultTarget();
  const compileOptions: Record<string, string> = {
    target: resolvedTarget,
    outfile,
  };
  if (resolvedTarget === "bun-windows-x64-baseline" && compileExecutablePath) {
    compileOptions.executablePath = compileExecutablePath;
  }
  const result = await bun.build({
    tsconfig: "./tsconfig.json",
    plugins: [await createSolidTransformPlugin()],
    entrypoints: [entrypoint],
    define,
    compile: compileOptions,
  });
  if (!result.success) {
    for (const log of result.logs) {
      console.error(log);
    }
    process.exit(1);
  }
}

const options = readArgs(bun.argv.slice(2));
const entrypoint = resolve("src", "cli.ts");
const targets = options.targets.length ? options.targets : [undefined];

for (const target of targets) {
  await buildOnce(entrypoint, options.outdir, options.filename, target);
}
