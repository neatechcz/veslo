# Windows WSL2 Sandbox Runtime

This document is the sandbox-track source of truth for the Windows WSL2 sandbox
runtime direction. The historical POC files in this folder explain how the
decision was reached; this file describes the intended product shape for the
WSL2 + bwrap implementation.

## Decision

Windows sandboxing is WSL2-first. Veslo should provision and use a managed WSL2
distribution named `VesloSandbox` for sandboxed OpenCode execution.

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

The runtime selector should use this order:

1. `VESLO_WSL_DISTRO`, when explicitly set.
2. Managed `VesloSandbox`, when installed.
3. Existing WSL2 distro fallback for development only.

The fallback exists to keep development unblocked while the onboarding
provisioner is being built. The product default remains `VesloSandbox`.

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
- fails closed when WSL2, bwrap, workspace path visibility, or OpenCode version
  checks fail

Not yet implemented:

- first-run UI onboarding
- managed Ubuntu rootfs acquisition/import
- runtime payload installation into `VesloSandbox`
- versioned runtime manifest
- user-facing repair flow

Smoke tests should only verify the environment. They must not install packages,
repair WSL, or modify user distros.

## Local Dev Provisioning Snapshot

As of the 2026-05-28 Windows dev pass, this machine has a manually provisioned
`VesloSandbox` distro that matches the intended managed-runtime shape closely
enough for backend testing.

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

These overrides are for development, support, and advanced diagnostics. They
are not the product onboarding path.
