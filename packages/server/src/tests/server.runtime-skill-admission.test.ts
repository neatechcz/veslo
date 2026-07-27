import { describe, expect, test } from "bun:test";

import { EMPTY_SERVING_RUNTIME_SKILL_BINDING } from "../active-runtime-skill-view.js";
import { ordinaryEngineSkillBindingAccepted } from "../server.js";

describe("ordinary runtime skill admission", () => {
  test("accepts the requested complete binding", () => {
    expect(ordinaryEngineSkillBindingAccepted({
      expectedRevision: "view-1",
      expectedAuthorizationRevision: "auth-1",
      actualRevision: "view-1",
      actualAuthorizationRevision: "auth-1",
    })).toBe(true);
  });

  test("accepts canonical empty as the safe fallback for an unusable requested binding", () => {
    expect(ordinaryEngineSkillBindingAccepted({
      expectedRevision: "stale-view",
      expectedAuthorizationRevision: "stale-auth",
      actualRevision: EMPTY_SERVING_RUNTIME_SKILL_BINDING.revision,
      actualAuthorizationRevision:
        EMPTY_SERVING_RUNTIME_SKILL_BINDING.authorizationRevision,
    })).toBe(true);
  });

  test("rejects another non-empty binding and an incomplete empty binding", () => {
    expect(ordinaryEngineSkillBindingAccepted({
      expectedRevision: "view-1",
      expectedAuthorizationRevision: "auth-1",
      actualRevision: "view-2",
      actualAuthorizationRevision: "auth-2",
    })).toBe(false);
    expect(ordinaryEngineSkillBindingAccepted({
      expectedRevision: "view-1",
      expectedAuthorizationRevision: "auth-1",
      actualRevision: EMPTY_SERVING_RUNTIME_SKILL_BINDING.revision,
      actualAuthorizationRevision: "",
    })).toBe(false);
  });
});
