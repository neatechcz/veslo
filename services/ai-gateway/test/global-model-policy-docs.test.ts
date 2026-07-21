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
  const onboarding = readDoc("features/onboarding-and-auth.md")
  const deployments = readDoc("dev/cloud-deployments.md")
  const state = readDoc("dev/state-and-config-reference.md")
  const appMap = readDoc("dev/app-map.md")
  const index = readDoc("INDEX.md")
  const canonicalManagedAiDocs = [admin, session, billing, onboarding, deployments, state, appMap].join("\n")

  assert.match(admin, /session.*billing entitlement.*user enablement.*global model.*credential/is)
  assert.match(admin, /no custom per-user or per-organization Managed-AI model policies/i)
  assert.match(admin, /Credential selection and rotation are separate from model selection/i)
  assert.match(
    admin,
    /Standalone AI Gateway is authoritative for inference, AI-access assignments,\s*the live authorized model roster and active fallback, credentials, and usage/i,
  )
  assert.doesNotMatch(admin, /DEN admin and standalone AI Gateway admin `Credentials` pages/i)
  assert.match(admin, /missing AI-access record.*enabled.*DEN organization entitlement/is)
  assert.match(admin, /explicitly disabled.*preserved/i)
  assert.match(admin, /global platform model policy.*credential capability/is)
  assert.match(admin, /self-access.*inference.*organization-qualified admin.*same automatic-access service/is)
  assert.match(admin, /rejects.*provider.*credential.*model.*routing/is)
  assert.match(admin, /member modal.*AI Access.*platform admin/is)
  assert.match(admin, /AI Infrastructure.*models.*credentials/is)
  assert.match(admin, /DEN.*`\/admin`.*redirect.*standalone AI Gateway/is)
  assert.match(admin, /direct.*DEN.*enable.*resolver.*fails closed/is)

  assert.match(session, /DEN provider inference remains retired/i)
  assert.match(session, /denInferenceMode: "retired"/i)
  assert.match(session, /denInferenceMode: "legacy_rollback"/i)
  assert.match(session, /no operator environment switch/i)
  assert.match(session, /missing access record.*created lazily as enabled/is)
  assert.match(session, /explicit disabled record.*unchanged/i)
  assert.match(session, /`\/api\/me\/ai-access`.*`\/api\/users\/:userId\/ai-access`.*same automatic-access service/is)
  assert.match(session, /unchanged.*local Veslo server.*`\/ai-gateway\/providers/is)
  assert.match(billing, /`GET \/v1\/managed-ai\/entitlement`/)
  assert.match(billing, /managed_ai_entitlement_denied/)
  assert.match(billing, /managed_ai_entitlement_unavailable/)
  assert.match(billing, /one automatic 14-day trial.*registered company domain/is)
  assert.match(billing, /active members inherit.*trial entitlement/is)
  assert.match(billing, /membership changes.*never.*reset.*trial/is)
  assert.match(billing, /immutable.*claim/is)
  assert.match(billing, /manual.*trial.*without.*changing.*expiry/is)
  assert.match(billing, /does not classify public email providers/i)
  assert.match(billing, /verified email.*normalized exact domain/is)

  assert.match(onboarding, /email\/password.*verification.*before.*organization provisioning/is)
  assert.match(onboarding, /active membership.*before.*AI Gateway.*effective assignment/is)
  assert.match(onboarding, /Gateway.*laz(?:y|ily).*enabled.*global platform model policy.*capability/is)

  assert.match(deployments, /deploy DEN before AI Gateway/i)
  assert.match(deployments, /configure and verify the global model policy/i)
  assert.match(state, /organization id.*runtime memory/is)
  assert.match(state, /must not be persisted.*OpenCode/is)
  assert.match(state, /missing.*AI-access.*enabled.*entitlement/is)
  assert.match(state, /explicit disabled.*preserved/i)
  assert.match(state, /admin.*toggle.*enabled.*technical routing fields.*rejected/is)
  assert.match(appMap, /AI Gateway owns.*global model policy/is)
  assert.match(appMap, /DEN owns.*billing entitlement/is)
  assert.match(appMap, /lazy.*automatic access.*after.*entitlement/is)
  assert.match(index, /AI Gateway.*global model policy/i)

  assert.doesNotMatch(canonicalManagedAiDocs, /Den\/AI Gateway remain authoritative for inference/i)
  assert.doesNotMatch(canonicalManagedAiDocs, /managed-AI assignment and admin truth follow the service/i)
  assert.doesNotMatch(canonicalManagedAiDocs, /DEN and standalone AI Gateway show the same access, credential, and model-policy state/i)
  assert.doesNotMatch(canonicalManagedAiDocs, /DEN resolves bindings/i)
  assert.doesNotMatch(canonicalManagedAiDocs, /configured managed-AI service keeps/i)
  assert.doesNotMatch(canonicalManagedAiDocs, /app can read managed-AI access policy from DEN or standalone AI Gateway/i)
  assert.doesNotMatch(canonicalManagedAiDocs, /read-only signup policy resolver are available first/i)
  assert.doesNotMatch(canonicalManagedAiDocs, /Account creation and eligible credential assignment remain available even when the platform model policy/i)
  assert.doesNotMatch(canonicalManagedAiDocs, /default (?:DEN signup bootstrap )?(?:leaves .*resolver )?unwired.*skips? auto(?:matic)?-assignment/is)
  assert.doesNotMatch(canonicalManagedAiDocs, /If no admin policy is assigned, the user can sign in but cannot send prompts/i)
  assert.doesNotMatch(canonicalManagedAiDocs, /Platform admins can .*pick the assigned provider and credential/i)
})
