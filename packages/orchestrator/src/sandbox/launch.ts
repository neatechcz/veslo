import type { SandboxCommand, SandboxLaunch } from "./types.js";

export function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_./:=+-]+$/.test(arg)) return arg;
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

export function commandToShellString(command: SandboxCommand): string {
  return [command.program, ...command.args].map(shellQuote).join(" ");
}

export function directLaunch(command: SandboxCommand): SandboxLaunch {
  return {
    command: command.program,
    args: command.args,
    cwd: command.cwd,
    env: command.env,
    childKind: "direct",
  };
}
