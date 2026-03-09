# Veslo Vision

**Mission:** Make your company feel 1000× more productive.

**How:** We give AI agents the tools your team already uses and let them learn from your behavior. The more you use Veslo, the more connected your tools become, the more knowledge accumulates, and the bigger the chunks of work you can automate.

**Today:** Veslo is the simplest interface to `opencode`. Create a new chat that can work in your folder:

1. **Cloud-primary** — Processing is done locally but chats are synced to cloud 

Current cloud mental model:

- Veslo worker is the runtime destination.
- Veslo app is the experience layer.
- Veslo server is the control/API layer.

Veslo helps users ship agentic workflows to their team. It works on top of opencode (opencode.ai) an agentic coding platform that exposes apis and sdks. We care about maximally using the opencode primitives. And build the thinest possible layer - always favoring opencode apis over custom built ones.

In other words:
- OpenCode is the **engine**.
- Veslo is the **experience** : onboarding, safety, permissions, progress, artifacts, and a premium-feeling UI. But mainly maximum usage for BFUs. 

Veslo competes directly with Anthropic's Cowork conceptually, but is more enterprise-oriented while allowing local deployment.

## Non-Goals

- Replacing OpenCode's CLI/TUI.
- Creating bespoke "magic" capabilities that don't map to OpenCode APIs.
