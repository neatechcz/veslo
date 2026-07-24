import assert from "node:assert/strict";
import test from "node:test";

import { attachmentSubmitErrorMessage } from "../../lib/attachment-submit-error-presentation.js";

const translations: Record<string, string> = {
  "session.pending_submit_failed": "Odeslání selhalo",
  "session.attachment_unknown_name": "přiložený soubor",
  "session.attachment_unknown_format": "daný formát",
  "session.attachment_format_unsupported": "Soubor „{name}“ je ve formátu {format}. Exportujte ho jako EML, PDF nebo TXT.",
  "session.attachment_processing_failed": "Soubor „{name}“ není platným souborem {format}.",
};

const tr = (key: string) => translations[key] ?? key;

test("localizes a typed unsupported MSG result from safe details", () => {
  const result = attachmentSubmitErrorMessage({
    code: "attachment_format_unsupported",
    details: { attachmentName: "mail.msg", format: "MSG", suggestedAlternatives: ["EML", "PDF", "TXT"] },
    fallback: "raw server fallback",
    tr,
  });

  assert.equal(result.specific, true);
  assert.equal(result.message, "Soubor „mail.msg“ je ve formátu MSG. Exportujte ho jako EML, PDF nebo TXT.");
  assert.doesNotMatch(result.message, /raw server fallback|UnknownError|application\/octet-stream/);
});

test("keeps the server fallback for an untyped non-attachment failure", () => {
  const result = attachmentSubmitErrorMessage({
    code: "engine_not_running",
    fallback: "Local runtime is unavailable",
    tr,
  });

  assert.deepEqual(result, { message: "Local runtime is unavailable", specific: false });
});
