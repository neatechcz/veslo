#!/usr/bin/env node

import {
  doctor,
  execManaged,
  installPackageArchive,
  packExpandedPackage,
  pathInfo,
  repairHeadless,
  stageExpandedPackage,
} from "./runtime.mjs";

const printJson = (value) => {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
};

const hasFlag = (args, flag) => args.includes(flag);

const flagValue = (args, flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] || "" : "";
};

async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;

  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(
      [
        "Usage:",
        "  veslo-document-runtime doctor --json",
        "  veslo-document-runtime path --json",
        "  veslo-document-runtime repair --headless",
        "  veslo-document-runtime stage --headless --source <expanded-runtime-dir> [--activate]",
        "  veslo-document-runtime pack --headless --source <expanded-runtime-dir> --output <file.veslopkg>",
        "  veslo-document-runtime install --headless --package <file.veslopkg> [--activate] [--sha256 <digest>]",
        "  veslo-document-runtime exec -- <command> [...args]",
        "",
      ].join("\n"),
    );
    return 0;
  }

  if (command === "doctor") {
    const result = await doctor();
    if (hasFlag(rest, "--json")) {
      printJson(result);
    } else {
      process.stdout.write(`${result.status}\n`);
    }
    return result.ok ? 0 : 1;
  }

  if (command === "path") {
    const result = await pathInfo();
    if (hasFlag(rest, "--json")) {
      printJson(result);
    } else {
      process.stdout.write(`${result.activePath || ""}\n`);
    }
    return result.ok ? 0 : 1;
  }

  if (command === "repair") {
    if (!hasFlag(rest, "--headless")) {
      throw new Error("repair requires --headless");
    }
    const result = await repairHeadless();
    printJson(result);
    return result.ok ? 0 : 1;
  }

  if (command === "stage") {
    if (!hasFlag(rest, "--headless")) {
      throw new Error("stage requires --headless");
    }
    const sourceDir = flagValue(rest, "--source");
    if (!sourceDir) {
      throw new Error("stage requires --source <expanded-runtime-dir>");
    }
    const result = await stageExpandedPackage({
      sourceDir,
      activate: hasFlag(rest, "--activate"),
    });
    printJson(result);
    return result.ok ? 0 : 1;
  }

  if (command === "pack") {
    if (!hasFlag(rest, "--headless")) {
      throw new Error("pack requires --headless");
    }
    const sourceDir = flagValue(rest, "--source");
    const outputPath = flagValue(rest, "--output");
    if (!sourceDir) {
      throw new Error("pack requires --source <expanded-runtime-dir>");
    }
    if (!outputPath) {
      throw new Error("pack requires --output <file.veslopkg>");
    }
    const result = await packExpandedPackage({ sourceDir, outputPath });
    printJson(result);
    return result.ok ? 0 : 1;
  }

  if (command === "install") {
    if (!hasFlag(rest, "--headless")) {
      throw new Error("install requires --headless");
    }
    const packagePath = flagValue(rest, "--package");
    if (!packagePath) {
      throw new Error("install requires --package <file.veslopkg>");
    }
    const result = await installPackageArchive({
      packagePath,
      expectedSha256: flagValue(rest, "--sha256") || undefined,
      activate: hasFlag(rest, "--activate"),
    });
    printJson(result);
    return result.ok ? 0 : 1;
  }

  if (command === "exec") {
    const separator = rest.indexOf("--");
    const execArgs = separator >= 0 ? rest.slice(separator + 1) : rest;
    return await execManaged(execArgs);
  }

  throw new Error(`Unknown command: ${command}`);
}

main().then((code) => {
  process.exitCode = code;
}).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
