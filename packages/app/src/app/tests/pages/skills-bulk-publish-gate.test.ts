import assert from "node:assert/strict";
import test from "node:test";

import { resolveSkillsBulkPublishDisabledReasonKey } from "../../pages/skills-bulk-publish-gate.js";
import type { VesloServerStatus } from "../../lib/veslo-server.js";

const baseInput = {
  selectedCount: 1,
  selectedPublishable: true,
  vesloServerStatus: "connected" as VesloServerStatus,
  vesloServerCanWriteSkills: true,
  vesloServerSkillRegistryAvailable: true,
};

test("skills bulk publish gate preserves selection and publishability priority", () => {
  assert.equal(
    resolveSkillsBulkPublishDisabledReasonKey({
      ...baseInput,
      selectedCount: 0,
      selectedPublishable: false,
      vesloServerStatus: "disconnected",
      vesloServerCanWriteSkills: false,
      vesloServerSkillRegistryAvailable: false,
    }),
    "skills.bulk_publish_no_selection",
  );
  assert.equal(
    resolveSkillsBulkPublishDisabledReasonKey({
      ...baseInput,
      selectedCount: 2,
      selectedPublishable: false,
      vesloServerStatus: "disconnected",
      vesloServerCanWriteSkills: false,
      vesloServerSkillRegistryAvailable: false,
    }),
    "skills.bulk_publish_multiple_selection",
  );
  assert.equal(
    resolveSkillsBulkPublishDisabledReasonKey({
      ...baseInput,
      selectedPublishable: false,
      vesloServerStatus: "disconnected",
      vesloServerCanWriteSkills: false,
      vesloServerSkillRegistryAvailable: false,
    }),
    "skills.bulk_publish_not_publishable",
  );
});

test("skills bulk publish gate reports registry and write capability before disconnection fallback", () => {
  assert.equal(
    resolveSkillsBulkPublishDisabledReasonKey({
      ...baseInput,
      vesloServerCanWriteSkills: false,
      vesloServerSkillRegistryAvailable: false,
    }),
    "skills.bulk_publish_registry_not_configured",
  );
  assert.equal(
    resolveSkillsBulkPublishDisabledReasonKey({
      ...baseInput,
      vesloServerCanWriteSkills: false,
      vesloServerSkillRegistryAvailable: true,
    }),
    "skills.bulk_publish_server_read_only",
  );
  assert.equal(
    resolveSkillsBulkPublishDisabledReasonKey({
      ...baseInput,
      vesloServerStatus: "disconnected",
      vesloServerCanWriteSkills: false,
      vesloServerSkillRegistryAvailable: false,
    }),
    "skills.bulk_publish_server_unavailable",
  );
});

test("skills bulk publish gate trusts capability evidence over a stricter disconnected status", () => {
  assert.equal(
    resolveSkillsBulkPublishDisabledReasonKey({
      ...baseInput,
      vesloServerStatus: "disconnected",
      vesloServerCanWriteSkills: true,
      vesloServerSkillRegistryAvailable: true,
    }),
    null,
  );
});
