import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const representativeScenarios = [
  'message-send-registry-degraded',
  'live-skills-finder-roundtrip',
  'session-run-truthfulness',
  'vslo-281-msg-attachment-visible-error',
] as const;

function scenarioScripts(content: string): string[] {
  return Array.from(content.matchAll(/script = '''\r?\n([\s\S]*?)\r?\n'''/g), (match) => match[1]);
}

test('representative Pilot scenarios parse and consume the browser prelude', () => {
  for (const scenario of representativeScenarios) {
    const content = readFileSync(
      new URL(`../pilot-scenarios/${scenario}.toml`, import.meta.url),
      'utf8',
    );
    const scripts = scenarioScripts(content);

    assert.ok(scripts.length > 0, `${scenario} must contain Pilot eval scripts`);
    assert.match(content, /window\.__vesloPilotE2E/, `${scenario} must use the shared browser prelude`);
    for (const script of scripts) {
      assert.doesNotThrow(
        () => new Function(`return (async () => {\n${script}\n});`),
        `${scenario} contains an invalid Pilot eval script`,
      );
    }
  }
});

test('contenteditable migrations preserve browser editing and the reload scenario restores its prelude', () => {
  const liveInference = readFileSync(
    new URL('../pilot-scenarios/message-send-registry-degraded.toml', import.meta.url),
    'utf8',
  );
  const liveSkills = readFileSync(
    new URL('../pilot-scenarios/live-skills-finder-roundtrip.toml', import.meta.url),
    'utf8',
  );
  const sessionTruthfulness = readFileSync(
    new URL('../pilot-scenarios/session-run-truthfulness.toml', import.meta.url),
    'utf8',
  );

  assert.match(liveSkills, /insertContenteditableThroughBrowser\(textbox, text\)/);
  assert.doesNotMatch(liveSkills, /textbox\.replaceChildren\(/);
  assert.match(liveSkills, /managed-ai-config-sync:managed-decision/);
  assert.match(liveSkills, /const engineReadyAfterId = Math\.max/);
  assert.doesNotMatch(liveSkills, /apply-gateway-provider-routing:done/);
  assert.match(liveInference, /const bootEngineStart = trace\.find/);
  assert.match(liveInference, /const engineReadyAfterId = Math\.max/);
  assert.doesNotMatch(liveInference, /Number\(entry\?\.id \?\? 0\) > runtimeStartGateId[\s\S]{0,240}managed-ai-config-sync:managed-decision/);
  assert.match(sessionTruthfulness, /insertContenteditableThroughBrowser\(editor, text\)/);
  assert.doesNotMatch(sessionTruthfulness, /editor\.replaceChildren\(/);
  assert.match(sessionTruthfulness, /\/transcript\/recover/);
  assert.match(sessionTruthfulness, /expectedRunId/);
  assert.match(sessionTruthfulness, /const appendCanonicalText = async \(run, text, createdAt\)/);
  assert.match(sessionTruthfulness, /await appendCanonicalText\(failedRun, 'truthfulness-running', 6000\)/);
  assert.match(sessionTruthfulness, /attachmentPendingMessageId = normalize\(attachmentRun\.clientMessageId\)/);
  assert.doesNotMatch(sessionTruthfulness, /pending-submit-sending/);
  assert.doesNotMatch(
    sessionTruthfulness,
    /sessions\/\$\{encodeURIComponent\(sessionId\)\}\/transcript`, \{\s*\n\s*method: 'POST'/,
  );
  assert.match(sessionTruthfulness, /restore Pilot browser prelude after webview reload/);
  assert.match(sessionTruthfulness, /veslo\.tauriPilot\.browserPrelude\.v1/);
});
