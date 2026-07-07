import { basename, dirname, join, normalize, sep } from "node:path";

const vendoredPackageDirName = "chrome-devtools-mcp-package";
const browserProfileArgNames = [
  "--isolated",
  "--user-data-dir",
  "--userDataDir",
  "--browser-url",
  "--browserUrl",
  "--ws-endpoint",
  "--wsEndpoint",
  "--auto-connect",
  "--autoConnect",
];

function hasArg(values, name) {
  return values.some((value) => value === name || value.startsWith(`${name}=`));
}

function hasExplicitBrowserProfileConfig(values) {
  return browserProfileArgNames.some((name) => hasArg(values, name));
}

function normalizeForCompare(value) {
  return normalize(String(value)).toLowerCase();
}

function isVendoredJsEntrypoint(value, execPath, existsSync) {
  if (typeof value !== "string" || !value.toLowerCase().endsWith(".js")) return false;
  if (!existsSync(value)) return false;
  const vendoredRoot = `${normalizeForCompare(join(dirname(execPath), vendoredPackageDirName))}${sep}`;
  return normalizeForCompare(value).startsWith(vendoredRoot);
}

function userArgStartIndex(argv, execPath) {
  const firstArg = argv[1] ?? "";
  if (!firstArg || firstArg.startsWith("-")) return 1;
  const firstBase = basename(firstArg).toLowerCase();
  const execBase = basename(execPath).toLowerCase();
  if (
    firstArg === "chrome-devtools-mcp" ||
    firstBase === "chrome-devtools-mcp" ||
    firstBase === "chrome-devtools-mcp.exe" ||
    firstBase.startsWith("chrome-devtools-mcp-shim.") ||
    firstBase === execBase
  ) {
    return 2;
  }
  return 1;
}

export function resolveChromeDevtoolsMcpShimInvocation(input) {
  const argv = Array.isArray(input.argv) ? input.argv.map(String) : [];
  const execPath = String(input.execPath ?? argv[0] ?? "");
  const env = input.env ?? {};
  const existsSync = input.existsSync;
  const defaultEntrypoint = join(
    dirname(execPath),
    vendoredPackageDirName,
    "build",
    "src",
    "index.js",
  );

  let entrypoint = defaultEntrypoint;
  let entrypointArgIndex = null;
  for (let index = 1; index < argv.length; index += 1) {
    if (isVendoredJsEntrypoint(argv[index], execPath, existsSync)) {
      entrypoint = argv[index];
      entrypointArgIndex = index;
      break;
    }
  }

  const argsForImportedEntrypoint =
    entrypointArgIndex === null
      ? argv.slice(userArgStartIndex(argv, execPath))
      : argv.slice(entrypointArgIndex + 1);
  const shouldInjectIsolated =
    entrypointArgIndex === null &&
    env.VESLO_CHROME_DEVTOOLS_MCP_DEFAULT_ISOLATED !== "0" &&
    !hasExplicitBrowserProfileConfig(argsForImportedEntrypoint);
  const argvForImportedEntrypoint = [
    argv[0] ?? execPath,
    entrypoint,
    ...argsForImportedEntrypoint,
    ...(shouldInjectIsolated ? ["--isolated"] : []),
  ];

  return {
    entrypoint,
    entrypointArgIndex,
    argvForImportedEntrypoint,
    shouldInjectIsolated,
  };
}
