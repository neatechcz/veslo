import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createRedactingLineBuffer,
  redactPilotCommandArgs,
  redactPilotDiagnosticText,
} from './pilot-redaction.js';

test('diagnostic redaction removes credentials from structured output and command arguments', () => {
  const redacted = redactPilotDiagnosticText(JSON.stringify({
    provider: 'codex_oauth',
    token: 'live-token',
    nested: {
      authorization: 'Bearer another-live-token',
      accessToken: 'access-live-token',
      refreshToken: 'refresh-live-token',
      clientToken: 'client-live-token',
      apiKey: 'api-key-live-token',
      secret: 'secret-live-token',
      password: 'password-live-token',
      hasUserToken: true,
      hasServerToken: false,
    },
    message: 'Authorization: Bearer third-live-token',
    workspacePath: 'C:\\Users\\example\\workspace',
    directory: '/home/example/workspace',
    dbPath: 'C:\\Users\\example\\opencode.db',
    prompt: 'prompt-sentinel-must-not-persist',
    transcript: 'assistant-text-sentinel-must-not-persist',
    body: 'visible-ui-sentinel-must-not-persist',
    email: 'person@example.test',
    lastStdout: 'server prompt-sentinel-must-not-persist C:\\Users\\example\\workspace',
    lastStderr: 'server assistant-text-sentinel-must-not-persist /tmp/example-workspace',
  }));

  assert.match(redacted, /codex_oauth/);
  assert.match(redacted, /<redacted>/);
  assert.match(redacted, /"hasUserToken": true/);
  assert.match(redacted, /"hasServerToken": false/);
  assert.doesNotMatch(redacted, /live-token|another-live-token|third-live-token|access-live-token|refresh-live-token|client-live-token|api-key-live-token|secret-live-token|password-live-token|prompt-sentinel-must-not-persist|assistant-text-sentinel-must-not-persist|visible-ui-sentinel-must-not-persist|person@example\.test|C:\\Users\\example|\/home\/example|\/tmp\/example-workspace/);
  assert.deepEqual(
    redactPilotCommandArgs(['--socket', '/tmp/veslo.sock', 'eval', 'window.token = "live-token"']),
    ['--socket', '<redacted-path>', 'eval', '<redacted-eval-script>'],
  );

  const prefixedTrace = redactPilotDiagnosticText(
    '[app] trace {"hasUserToken":true,"clientToken":"client-live-token"}',
  );
  assert.match(prefixedTrace, /"hasUserToken":true/);
  assert.match(prefixedTrace, /"clientToken":<redacted>/);
  assert.doesNotMatch(prefixedTrace, /client-live-token/);
});

test('diagnostic redaction removes private fields and absolute paths from prefixed trace lines', () => {
  const redacted = redactPilotDiagnosticText(
    '[app:stderr] trace {"event":"session.failed","workspacePath":"C:\\\\Users\\\\example\\\\workspace","directory":"/tmp/example-workspace","message":"prompt-sentinel-must-not-persist","errorCode":"workspace_unavailable"}',
  );

  assert.match(redacted, /"event":"session\.failed"/);
  assert.match(redacted, /"errorCode":"workspace_unavailable"/);
  assert.match(redacted, /"workspacePath":<redacted>/);
  assert.match(redacted, /"message":<redacted>/);
  assert.doesNotMatch(redacted, /prompt-sentinel-must-not-persist|C:\\Users\\example|\/tmp\/example-workspace/);
});

test('line-buffered redaction protects credentials split across app-process chunks', () => {
  const buffer = createRedactingLineBuffer();

  assert.equal(buffer.push('stderr Authorization: Bearer top-secret'), '');
  const persisted = buffer.push('-token\nnext token=live-token\n');

  assert.match(persisted, /stderr Authorization: .*<redacted>/);
  assert.match(persisted, /next token=<redacted>/);
  assert.doesNotMatch(persisted, /top-secret-token|live-token/);
  assert.equal(buffer.flush(), '');
});

test('line-buffered redaction flushes a final unterminated app-process line', () => {
  const buffer = createRedactingLineBuffer();

  assert.equal(buffer.push('{"token":"final-secret"}'), '');
  assert.equal(buffer.flush(), '{\n  "token": "<redacted>"\n}');
});
