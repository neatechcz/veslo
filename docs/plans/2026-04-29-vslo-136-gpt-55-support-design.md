# VSLO-136 GPT-5.5 Managed Codex Support Design

## Summary

VSLO-136 should make `codex_oauth/gpt-5.5` usable through Veslo managed Codex without changing the default managed Codex model. Admin-assigned access may include GPT-5.5, and the desktop runtime should route prompts through the existing managed Codex provider flow.

The change updates the bundled `veslo-code` runtime and the server-side Codex CLI worker dependency, then adds focused coverage for GPT-5.5 routing and incompatibility errors.

## Scope

- Support `codex_oauth/gpt-5.5` when it is explicitly assigned or selected.
- Keep the current managed Codex default model unchanged.
- Update the desktop OpenCode sidecar version used to build `veslo-code`.
- Update server-side Codex CLI dependencies used by the managed worker path.
- Preserve the current managed provider routing, session, credential, and gateway-token behavior.
- Return a clear actionable runtime incompatibility error when an old Codex runtime rejects GPT-5.5.
- Verify through focused unit tests and the real Tauri desktop runtime.

## Runtime Flow

The app continues to format managed Codex access as an OpenCode provider named `codex_oauth`. When an assigned profile includes GPT-5.5, config generation should include both the selected/default model and allowed models, preserving provider-qualified model references such as `codex_oauth/gpt-5.5`.

The local Veslo server continues to proxy managed Codex requests to the AI gateway route. The AI gateway and DEN Codex worker transports continue to invoke Codex CLI with `--model <model>`, so GPT-5.5 should pass through unchanged.

## Runtime Versions

The desktop package and orchestrator package should pin the same OpenCode version so bundled and orchestrator-resolved `veslo-code` behavior stay aligned. The ignored sidecar directory is regenerated for local desktop verification, while committed changes should remain in source metadata and lockfiles.

The AI gateway and DEN services should update `@openai/codex` together so hosted and local managed worker flows do not diverge.

## Error Handling

Generic worker failures should keep the existing structured `codex_worker_failed` response. GPT-5.5 runtime-incompatibility failures should be classified separately when Codex CLI stderr indicates an unsupported, unknown, invalid, or unavailable GPT-5.5 model or parameters.

The classified response should be OpenAI-compatible enough for provider clients to surface the message:

```json
{
  "error": {
    "code": "codex_runtime_incompatible",
    "type": "runtime_incompatible",
    "message": "The Codex runtime bundled with Veslo is too old for gpt-5.5. Update Veslo to a build with the current veslo-code/Codex runtime, then retry."
  }
}
```

Diagnostic details such as `timedOut`, `exitCode`, and `stderrTail` may remain available outside the user-facing message.

## Testing

Focused tests should prove:

- GPT-5.5 is included in managed Codex config when assigned.
- Existing GPT-5.4 default assignment behavior is unchanged.
- AI gateway and DEN worker transports pass `gpt-5.5` through to Codex CLI.
- AI gateway and DEN proxy routes preserve structured worker error bodies.
- GPT-5.5 runtime-incompatibility stderr maps to an actionable response.

Final acceptance requires a real Tauri desktop run with managed Codex assigned to `gpt-5.5`, from prompt send through response.
