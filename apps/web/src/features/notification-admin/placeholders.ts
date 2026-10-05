/**
 * Placeholder checks for notification templates. They mirror the server's rules
 * (`{{variableName}}`, nothing else), so the editor can point at a mistake while typing; the API
 * still validates every save.
 */
const PLACEHOLDER = /\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g;
const SINGLE_PLACEHOLDER = /^\{\{\s*[a-zA-Z][a-zA-Z0-9_]*\s*\}\}$/;
const ANY_BRACES = /\{\{[^{}]*?\}\}|\{\{[^{}\n]{0,30}|\}\}/g;

export function referencedVariables(text: string): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(PLACEHOLDER)) {
    if (!names.includes(match[1]!)) names.push(match[1]!);
  }
  return names;
}

export function malformedPlaceholders(text: string): string[] {
  const bad: string[] = [];
  for (const match of text.matchAll(ANY_BRACES)) {
    const token = match[0];
    if (!SINGLE_PLACEHOLDER.test(token) && !bad.includes(token)) bad.push(token);
  }
  return bad;
}

/** Problems with one template field, in words an administrator can act on. */
export function placeholderIssues(text: string, allowed: readonly string[]): string[] {
  const issues: string[] = [];
  for (const token of malformedPlaceholders(text)) {
    issues.push(`Fix ${token}. Placeholders look like {{variableName}}.`);
  }
  for (const name of referencedVariables(text)) {
    if (!allowed.includes(name)) issues.push(`{{${name}}} is not available for this notification.`);
  }
  return issues;
}

/** Insert `token` at the selection of a text field, returning the new text and caret position. */
export function insertAt(
  text: string,
  start: number,
  end: number,
  token: string,
): { text: string; caret: number } {
  const from = Math.max(0, Math.min(start, text.length));
  const to = Math.max(from, Math.min(end, text.length));
  return { text: text.slice(0, from) + token + text.slice(to), caret: from + token.length };
}
