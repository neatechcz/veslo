import { readFileSync } from "node:fs";

const contextRoot = new URL("../../context/", import.meta.url);

export function readContextSource(fileName: string): string {
  return readFileSync(new URL(fileName, contextRoot), "utf8");
}

export function readWorkspaceFacadeSource(): string {
  return readContextSource("workspace.ts");
}

export function readWorkspaceBehaviorSources(): string {
  return [
    "workspace.ts",
    "workspace-types.ts",
    "workspace-lifecycle-state.ts",
    "workspace-debug.ts",
    "workspace-busy-state.ts",
    "workspace-connection-state.ts",
    "workspace-server-registry.ts",
    "workspace-skill-materialization.ts",
    "workspace-connection-controller.ts",
    "workspace-runtime-controller.ts",
    "workspace-local-workspaces.ts",
    "workspace-activation-controller.ts",
    "workspace-bootstrap-controller.ts",
  ]
    .map((name) => {
      try {
        return `\n/* ${name} */\n${readContextSource(name)}`;
      } catch {
        return "";
      }
    })
    .join("\n");
}
