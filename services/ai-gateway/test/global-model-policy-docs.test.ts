import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const docsRoot = new URL("../../../docs/", import.meta.url)

function readDoc(path: string): string {
  return readFileSync(new URL(path, docsRoot), "utf8")
}

test("canonical docs preserve the managed-AI ownership and runtime order contract", () => {
  const admin = readDoc("admin-managed-ai-access.md")
  const session = readDoc("features/session-runtime.md")
  const billing = readDoc("features/organization-billing.md")
  const deployments = readDoc("dev/cloud-deployments.md")
  const state = readDoc("dev/state-and-config-reference.md")
  const appMap = readDoc("dev/app-map.md")
  const index = readDoc("INDEX.md")
  const canonicalManagedAiDocs = [admin, session, billing, deployments, state, appMap].join("\n")

  assert.match(admin, /session.*billing entitlement.*user enablement.*global model.*credential/is)
  assert.match(admin, /no per-user or per-organization Managed-AI model overrides/i)
  assert.match(admin, /Credential selection and rotation are separate from model selection/i)
  assert.match(admin, /Standalone AI Gateway is authoritative for inference, AI-access assignments, the global model, credentials, and usage/i)
  assert.doesNotMatch(admin, /DEN admin and standalone AI Gateway admin `Credentials` pages/i)

  assert.match(session, /DEN provider inference defaults to the code-level dependency/i)
  assert.match(session, /denInferenceMode: "retired"/i)
  assert.match(session, /denInferenceMode: "legacy_rollback"/i)
  assert.match(session, /no operator environment switch/i)
  assert.match(session, /default DEN signup bootstrap does not inject `getActiveModelProvider`/i)
  assert.match(billing, /`GET \/v1\/managed-ai\/entitlement`/)
  assert.match(billing, /managed_ai_entitlement_denied/)
  assert.match(billing, /managed_ai_entitlement_unavailable/)

  assert.match(deployments, /deploy DEN before AI Gateway/i)
  assert.match(deployments, /configure and verify the global model policy/i)
  assert.match(state, /organization id.*runtime memory/is)
  assert.match(state, /must not be persisted.*OpenCode/is)
  assert.match(appMap, /AI Gateway owns.*global model policy/is)
  assert.match(appMap, /DEN owns.*billing entitlement/is)
  assert.match(appMap, /default leaves that resolver unwired and skips auto-assignment/is)
  assert.match(index, /AI Gateway.*global model policy/i)

  assert.doesNotMatch(canonicalManagedAiDocs, /Den\/AI Gateway remain authoritative for inference/i)
  assert.doesNotMatch(canonicalManagedAiDocs, /managed-AI assignment and admin truth follow the service/i)
  assert.doesNotMatch(canonicalManagedAiDocs, /DEN and standalone AI Gateway show the same access, credential, and model-policy state/i)
  assert.doesNotMatch(canonicalManagedAiDocs, /DEN resolves bindings/i)
  assert.doesNotMatch(canonicalManagedAiDocs, /configured managed-AI service keeps/i)
  assert.doesNotMatch(canonicalManagedAiDocs, /app can read managed-AI access policy from DEN or standalone AI Gateway/i)
  assert.doesNotMatch(canonicalManagedAiDocs, /read-only signup policy resolver are available first/i)
  assert.doesNotMatch(canonicalManagedAiDocs, /Account creation and eligible credential assignment remain available even when the platform model policy/i)
})
