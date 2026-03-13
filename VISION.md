# Veslo Vision

**Mission:** Make your company feel 1000× more productive.

**How:** We give AI agents the tools your team already uses and let them learn from your behavior. The more you use Veslo, the more connected your tools become, the more knowledge accumulates, and the bigger the chunks of work you can automate.

**Today:** Veslo is the simplest interface to `opencode`.

- `New session` starts immediately in a persistent Veslo-managed private workspace.
- `Open project/folder` brings an existing local folder into Veslo.
- Processing is local-first. Cloud is used for identity, chat history, and sync.
- If a session is backed by a workspace that exists only on one device, other devices can see it as history but cannot continue it there.
- In the future, once a workspace is explicitly moved to cloud, that work can become continuable on other devices.
- Messaging connectors remain implemented at the runtime layer, but are intentionally hidden from the end-user UI while Veslo prioritizes a native mobile app.

Current cloud mental model:

- Veslo app is the experience layer.
- The workspace directory is the execution context.
- Cloud stores identity, organization state, chat history, and sync metadata.
- Remote/cloud execution remains a platform capability, not the default BFU flow today.

Veslo helps users ship agentic workflows to their team. It works on top of opencode (opencode.ai) an agentic coding platform that exposes apis and sdks. We care about maximally using the opencode primitives. And build the thinest possible layer - always favoring opencode apis over custom built ones.

In other words:
- OpenCode is the **engine**.
- Veslo is the **experience** : onboarding, safety, permissions, progress, artifacts, and a premium-feeling UI. But mainly maximum usage for BFUs. 

Veslo competes directly with Anthropic's Cowork conceptually, but is more enterprise-oriented while allowing local deployment.

## Non-Goals

- Replacing OpenCode's CLI/TUI.
- Creating bespoke "magic" capabilities that don't map to OpenCode APIs.
