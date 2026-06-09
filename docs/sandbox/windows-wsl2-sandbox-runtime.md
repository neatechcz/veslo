# Windows WSL2 Sandbox Runtime

This document is the sandbox-track source of truth for the Windows sandbox
runtime. The historical POC files in this folder explain how the decision was
reached; this file describes the current project reality and intended product
shape for the WSL2 + bwrap implementation.

## Decision

Windows sandboxing is **WSL2 + bwrap**. Veslo should provision and use a
managed WSL2 distribution named `VesloSandbox` for sandboxed OpenCode
execution.

This is not just an option among equivalent Windows backends. In the current
code, `resolveSandbox()` returns `WindowsWsl2` on `win32`. The native Windows
Job Object backend is a stub and AppContainer is historical POC material, not
the supported OpenCode sandbox path.

The managed distro should be based on a pinned lightweight Ubuntu rootfs that
passes the real bwrap probe. Do not auto-follow the newest Ubuntu release. The
initial candidate should be a minimal Ubuntu 22.04 LTS/rootfs; a newer Ubuntu
base is acceptable only after the AppArmor/user-namespace behavior is verified.
Use Ubuntu rather than Alpine or another musl-based distro, because OpenCode's
Linux sidecar assets are glibc-oriented and WSL is the officially recommended
Windows path for OpenCode.

Do not silently modify a user's existing Ubuntu or other personal WSL
distribution. Existing user distros may be used only as explicit development or
advanced-user overrides.

## Why Ubuntu

- The existing sandbox architecture notes already name Ubuntu for Windows
  onboarding.
- OpenCode recommends WSL for Windows, but does not require a specific distro.
  That leaves the distro choice to Veslo.
- Ubuntu/Debian-style glibc environments are the lowest-risk target for the
  Linux OpenCode assets.
- Alpine is smaller, but musl/glibc differences make it a worse KISS default
  for this runtime.
- A pinned lightweight Ubuntu rootfs gives Veslo a predictable apt ecosystem for
  `bubblewrap`, CA certificates, shell/coreutils, and diagnostic tools.
- Ubuntu 24.04+ needs extra validation because AppArmor/user-namespace defaults
  can block bwrap in some configurations.

## First-Run Onboarding

Runtime provisioning belongs in first-run onboarding or installer setup, not in
smoke tests and not in normal developer build commands.

The onboarding flow should:

1. Detect whether WSL is installed and usable.
2. Detect whether WSL2 is available.
3. Detect whether the managed `VesloSandbox` distro exists.
4. If missing, ask for explicit consent before provisioning.
5. Explain when Windows admin rights, network access, disk space, or reboot may
   be required.
6. Import or install the pinned lightweight Ubuntu rootfs as `VesloSandbox`.
7. Install or unpack the pinned sandbox runtime payload:
   - `bubblewrap`
   - CA certificates
   - shell/coreutils basics
   - the matching Linux OpenCode runtime asset
8. Verify the runtime with a real bwrap probe.
9. Store the provisioned runtime version and report clear remediation steps on
   mismatch.

The app should not tell normal users to run `apt install bubblewrap` manually.
If a developer chooses to point `VESLO_WSL_DISTRO` at a personal distro, manual
setup is their responsibility.

## Build Responsibilities

Project build steps may prepare or download artifacts needed by the installer,
but should not mutate the user's OS or WSL state as a side effect.

Acceptable build outputs:

- pinned rootfs manifest
- checksum metadata
- bundled or downloadable provisioning helper
- Linux OpenCode asset/version metadata
- offline/online provisioning mode flags

Not acceptable during a normal build:

- enabling WSL features on the host
- importing a distro into the user's WSL registry
- installing apt packages into a personal distro
- changing user WSL defaults

## Runtime Selection

The runtime selector currently uses this order:

1. `VESLO_WSL_DISTRO`, when explicitly set.
2. Managed `VesloSandbox`, when installed.
3. Existing WSL2 distro fallback for development/support only.

The fallback exists to keep development unblocked while the onboarding
provisioner is being built. The product default remains `VesloSandbox`; a
normal user should not be asked to prepare a personal Ubuntu distro by hand.

Do not treat fallback to a personal distro as product behavior. It is only a
development/support bridge; `VESLO_WSL_DISTRO` is the explicit escape hatch.

## Current Implementation State

The orchestrator has a Windows WSL2 sandbox backend under
`packages/orchestrator/src/sandbox/windows-wsl2/`.

Current implemented behavior:

- discovers `wsl.exe`
- selects a WSL2 distro
- prefers `VesloSandbox` when it exists
- verifies `bubblewrap` by spawning it
- runs OpenCode inside bwrap
- uses a WSL-native per-workspace engine home/config directory
- maps Windows workspace paths to WSL paths before launching OpenCode
- returns the WSL guest IP as `connectHost` so Windows can reach a
  wildcard-bound engine without depending on flaky localhost forwarding
- fails closed when WSL2, bwrap, workspace path visibility, or OpenCode version
  checks fail
- includes a repair/provisioning helper at
  `packages/orchestrator/scripts/windows-wsl2-sandbox-provision.ps1` that
  imports `VesloSandbox`, installs `bubblewrap`/CA certificates, installs the
  pinned Linux OpenCode binary, writes `/etc/wsl.conf`, and verifies bwrap

Not yet implemented:

- first-run UI onboarding
- installer/desktop invocation of the provisioning helper
- versioned runtime manifest
- user-facing repair flow

Smoke tests should only verify the environment. They must not install packages,
repair WSL, or modify user distros.

## Launch Model

On Windows, the orchestrator does not spawn the Windows OpenCode binary. It
launches Linux OpenCode through WSL2:

```text
wsl.exe -d <distro> --exec bash -c <veslo-wsl2-bwrap-opencode>
```

Inside that script:

- the workspace is mounted as `/workspace`
- the per-engine config dir is mounted as `/config`
- `HOME` points to a WSL-native per-engine home under `~/.veslo/engines/<key>`
- `.git` under the workspace is read-only
- host managed config `tools` and `node_modules` are read-only bound into
  `/config/tools` and `/config/node_modules`
- `OPENCODE_SERVER_PASSWORD` and similar sensitive runtime values must pass
  through environment, not be rendered into the generated `bash -c` argv
- the Linux OpenCode runtime is invoked inside `bwrap`

The host-side proxy reaches the engine through WSL guest IPv4 (`connectHost`).
`VESLO_WSL_CONNECT_HOST` is only a diagnostic override.

## Required WSL+bwrap Invariants

- DNS must work inside bwrap, not just in bare WSL. If `/etc/resolv.conf`
  points into `/mnt/wsl`, bind its real target into the sandbox.
- Use WSL guest IP as `connectHost`; Windows `127.0.0.1` forwarding is not the
  source of truth for engine health.
- Managed OpenCode dependencies must use `@opencode-ai/plugin@1.14.29` and
  `zod@4.1.8`.

Fallback plugin mode is acceptable only when it imports real vendored `zod`.

## Historical Local Dev Provisioning Snapshot

As of the 2026-05-28 Windows dev pass, a local dev machine had a manually
provisioned `VesloSandbox` distro that matched the intended managed-runtime
shape closely enough for backend testing. This is a historical snapshot, not a
guarantee that the distro still exists on any given developer machine. Use the
provisioning helper above to recreate it.

Installed state:

- WSL distro: `VesloSandbox`
- Base OS: Ubuntu 22.04 LTS rootfs
- Default user: `veslo`
- Home: `/home/veslo`
- `bubblewrap`: `/usr/bin/bwrap`, version `0.6.1`
- OpenCode: `/usr/local/bin/opencode`, version `1.14.29`
- `/etc/wsl.conf`:

```ini
[user]
default=veslo
[interop]
appendWindowsPath=false
```

The `appendWindowsPath=false` setting is important. Without it, WSL can resolve
the Windows `opencode` shim from `/mnt/c/Program Files/nodejs/opencode`, which is
not a valid managed Linux runtime for bwrap.

Verified checks:

- `pnpm --filter veslo-orchestrator exec bun scripts/windows-wsl2-sandbox-smoke.ts`
  passed with `PASS - WSL2 bwrap smoke passed in distro VesloSandbox (x86_64)`.
- `discoverWsl2Runtime()` selected `VesloSandbox`.
- `resolveWslOpencodeRuntime(runtime, "1.14.29")` resolved
  `/usr/local/bin/opencode`.
- Direct `bwrap ... -- /usr/local/bin/opencode --version` returned `1.14.29`.
- `pnpm --filter veslo-orchestrator typecheck` passed.

This is a local dev bootstrap, not the shipped first-run onboarding. Future
onboarding should automate the same state through a versioned rootfs/runtime
manifest and should not depend on manual package installation.

## Overrides

Supported development overrides:

- `VESLO_WSL_EXE` - absolute path to `wsl.exe`
- `VESLO_WSL_DISTRO` - explicit WSL distro name
- `VESLO_WSL_OPENCODE_BIN` - Linux path to a provisioned OpenCode binary inside
  WSL
- `VESLO_WSL_CONNECT_HOST` - explicit WSL guest IPv4 address for host-to-guest
  engine connectivity diagnostics

These overrides are for development, support, and advanced diagnostics. They
are not the product onboarding path.
