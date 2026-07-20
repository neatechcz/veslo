const SENSITIVE_DIAGNOSTIC_KEY = /^(?:(?:[a-z]+[_-]?)?token|authorization|api[_-]?key|secret|password|cookie|auth(?:[_-]?json)?)$/i;
const PRIVATE_DIAGNOSTIC_KEY = /^(?:message|error|failure|stack|body|text|label|title|content|prompt|transcript|workspacepath|workspace_path|directory|dbpath|db_path|path|filepath|file_path|email|subject|laststdout|laststderr)$/i;
const SENSITIVE_DIAGNOSTIC_INLINE_VALUE = /((?:["']?)(?:(?:[a-z]+[_-]?)?token|authorization|api[_-]?key|secret|password|cookie|auth(?:[_-]?json)?|message|error|failure|stack|body|text|label|title|content|prompt|transcript|workspacepath|workspace_path|directory|dbpath|db_path|path|filepath|file_path|email|subject)(?:["']?)\s*[:=]\s*)((?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^,\s}\]]+))/gi;
const BEARER_VALUE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const SENSITIVE_QUERY_VALUE = /([?&](?:token|access_token|refresh_token|api_key|apikey|secret|password)=)[^&\s]+/gi;
const WINDOWS_ABSOLUTE_PATH = /\b[A-Za-z]:(?:\\\\|\\|\/)[^\s"'`<>|,)\]}]*/g;
const POSIX_ABSOLUTE_PATH = /(^|[\s"'(=])\/(?:Users|home|tmp|var|private|mnt|opt|workspace|workspaces)(?:\/[^\s"'`<>()\[\]{}]*)*/g;
const JUNIT_PRIVATE_ATTRIBUTE = /(\s(?:(?:[a-z]+[_-]?)?token|authorization|api[_-]?key|secret|password|cookie|auth(?:[_-]?json)?|message|error|failure|stack|body|text|label|title|content|prompt|transcript|workspacepath|workspace_path|directory|dbpath|db_path|path|filepath|file_path|email|subject)\s*=\s*)(["'])([^"']*)\2/gi;
const JUNIT_PRIVATE_ELEMENT_BODY = /(<(failure|error|system-out|system-err)\b[^>]*>)[\s\S]*?(<\/\2\s*>)/gi;

function isCredentialPresenceBoolean(key: string, value: unknown): boolean {
  return typeof value === 'boolean' && /^(?:has|is)[a-z0-9_-]*(?:token|authorization|api[_-]?key|secret|password|cookie|auth(?:[_-]?json)?)$/i.test(key);
}

function redactInlineSensitiveValue(_match: string, prefix: string, rawValue: string): string {
  const key = prefix.match(/["']?([A-Za-z0-9_-]+)["']?\s*[:=]\s*$/)?.[1] ?? '';
  const normalizedValue = rawValue.trim().replace(/^["']|["']$/g, '').toLowerCase();
  if ((normalizedValue === 'true' || normalizedValue === 'false') &&
    isCredentialPresenceBoolean(key, normalizedValue === 'true')) {
    return `${prefix}${rawValue}`;
  }
  return `${prefix}<redacted>`;
}

function redactPilotDiagnosticValue(value: unknown, key?: string): unknown {
  if (PRIVATE_DIAGNOSTIC_KEY.test(key ?? '')) return '<redacted>';
  if (Array.isArray(value)) return value.map((entry) => redactPilotDiagnosticValue(entry));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        SENSITIVE_DIAGNOSTIC_KEY.test(key) && !isCredentialPresenceBoolean(key, child)
          ? '<redacted>'
          : redactPilotDiagnosticValue(child, key),
      ]),
    );
  }
  return typeof value === 'string' ? redactInlineDiagnosticText(value) : value;
}

function redactInlineDiagnosticText(value: string): string {
  return value
    .replace(BEARER_VALUE, 'Bearer <redacted>')
    .replace(SENSITIVE_DIAGNOSTIC_INLINE_VALUE, redactInlineSensitiveValue)
    .replace(SENSITIVE_QUERY_VALUE, '$1<redacted>')
    .replace(WINDOWS_ABSOLUTE_PATH, '<redacted-path>')
    .replace(POSIX_ABSOLUTE_PATH, '$1<redacted-path>');
}

export function redactPilotDiagnosticText(value: string): string {
  try {
    return JSON.stringify(redactPilotDiagnosticValue(JSON.parse(value)), null, 2);
  } catch {
    return redactInlineDiagnosticText(value);
  }
}

/**
 * Keeps a JUnit artifact well-formed while removing all failure diagnostics.
 * The generic line redactor intentionally emits compact diagnostic markers
 * such as `message=<redacted>`, which is not valid XML attribute syntax.
 */
export function redactPilotJUnitXml(value: string): string {
  return value
    .replace(JUNIT_PRIVATE_ATTRIBUTE, '$1$2[redacted]$2')
    .replace(JUNIT_PRIVATE_ELEMENT_BODY, '$1[redacted]$3')
    .replace(BEARER_VALUE, 'Bearer [redacted]')
    .replace(SENSITIVE_QUERY_VALUE, '$1[redacted]')
    .replace(WINDOWS_ABSOLUTE_PATH, '[redacted-path]')
    .replace(POSIX_ABSOLUTE_PATH, '$1[redacted-path]');
}

export function redactPilotCommandArgs(args: string[]): string[] {
  const evalIndex = args.indexOf('eval');
  return args.map((arg, index) => {
    if (evalIndex >= 0 && index > evalIndex) return '<redacted-eval-script>';
    return redactPilotDiagnosticText(arg);
  });
}

/**
 * Keeps partial process output in memory until a complete line is available,
 * then redacts it before it can enter a persistent run artifact or be echoed
 * by the harness. This covers credentials split across arbitrary stdout/stderr
 * chunks. Structured JSON may be normalized while it is redacted.
 */
export function createRedactingLineBuffer(): {
  push(chunk: string): string;
  flush(): string;
} {
  let pending = '';

  const redactCompleteLines = (value: string): { output: string; remainder: string } => {
    let output = '';
    let cursor = 0;
    const linePattern = /([^\r\n]*)(\r?\n)/g;
    let match: RegExpExecArray | null;
    while ((match = linePattern.exec(value))) {
      output += redactPilotDiagnosticText(match[1]) + match[2];
      cursor = match.index + match[0].length;
    }
    return { output, remainder: value.slice(cursor) };
  };

  return {
    push(chunk: string): string {
      const result = redactCompleteLines(pending + chunk);
      pending = result.remainder;
      return result.output;
    },
    flush(): string {
      const output = pending ? redactPilotDiagnosticText(pending) : '';
      pending = '';
      return output;
    },
  };
}
