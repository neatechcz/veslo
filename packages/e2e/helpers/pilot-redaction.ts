const SENSITIVE_DIAGNOSTIC_KEY = /^(?:(?:[a-z]+[_-]?)?token|authorization|api[_-]?key|secret|password|cookie|auth(?:[_-]?json)?)$/i;
const SENSITIVE_DIAGNOSTIC_INLINE_VALUE = /((?:["']?)(?:(?:[a-z]+[_-]?)?token|authorization|api[_-]?key|secret|password|cookie|auth(?:[_-]?json)?)(?:["']?)\s*[:=]\s*)(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^,\s}\]]+)/gi;
const BEARER_VALUE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const SENSITIVE_QUERY_VALUE = /([?&](?:token|access_token|refresh_token|api_key|apikey|secret|password)=)[^&\s]+/gi;

function redactPilotDiagnosticValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactPilotDiagnosticValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        SENSITIVE_DIAGNOSTIC_KEY.test(key) ? '<redacted>' : redactPilotDiagnosticValue(child),
      ]),
    );
  }
  return typeof value === 'string' ? redactPilotDiagnosticText(value) : value;
}

export function redactPilotDiagnosticText(value: string): string {
  try {
    return JSON.stringify(redactPilotDiagnosticValue(JSON.parse(value)), null, 2);
  } catch {
    return value
      .replace(BEARER_VALUE, 'Bearer <redacted>')
      .replace(SENSITIVE_DIAGNOSTIC_INLINE_VALUE, '$1<redacted>')
      .replace(SENSITIVE_QUERY_VALUE, '$1<redacted>');
  }
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
 * chunks without changing the original line layout.
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
