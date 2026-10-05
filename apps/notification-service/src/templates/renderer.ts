/**
 * Minimal, logic-less template rendering: `{{variable}}` placeholders only. No expressions,
 * helpers or partials, so templates edited by administrators can never execute code. Values are
 * HTML-escaped for the HTML part of emails; the plain-text alternative and in-app notifications
 * contain text only (the web app renders it as text).
 */

const PLACEHOLDER = /\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g;
const SINGLE_PLACEHOLDER = /^\{\{\s*[a-zA-Z][a-zA-Z0-9_]*\s*\}\}$/;
const ANY_BRACES = /\{\{[^{}]*?\}\}|\{\{[^{}\n]{0,30}|\}\}/g;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export type TemplateVars = Record<string, string | null | undefined>;

/** Variable names referenced by a template, in order of first use. */
export function referencedVariables(template: string): string[] {
  const names: string[] = [];
  for (const match of template.matchAll(PLACEHOLDER)) {
    if (!names.includes(match[1]!)) names.push(match[1]!);
  }
  return names;
}

/** Placeholders that are not well-formed `{{name}}` references (unbalanced or invalid names). */
export function malformedPlaceholders(template: string): string[] {
  const bad: string[] = [];
  for (const match of template.matchAll(ANY_BRACES)) {
    const token = match[0];
    if (!SINGLE_PLACEHOLDER.test(token) && !bad.includes(token)) bad.push(token);
  }
  return bad;
}

function clean(value: string): string {
  return value.replace(CONTROL, '');
}

/** Substitute variables as plain text. Unknown or empty variables render as an empty string. */
export function renderPlain(template: string, vars: TemplateVars): string {
  const out = template.replace(PLACEHOLDER, (_m, name: string) => clean(vars[name] ?? ''));
  return out
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, '').replace(/ {2,}/g, ' '))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Single-line rendering for email subjects and in-app titles (no line breaks: header-safe). */
export function renderInline(template: string, vars: TemplateVars, maxLength = 200): string {
  const line = renderPlain(template, vars).replace(/\s+/g, ' ').trim();
  return line.length > maxLength ? `${line.slice(0, maxLength - 1).trimEnd()}…` : line;
}

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]!);
}

/** Only absolute http(s) URLs may become links. */
export function safeUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Body as HTML paragraphs. Escaping the substituted text is equivalent to escaping literal text
 * and every value separately, so neither administrators nor event data can inject markup.
 */
export function renderHtmlBody(template: string, vars: TemplateVars): string {
  return renderPlain(template, vars)
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p style="margin:0 0 16px 0;">${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

export interface EmailRenderOptions {
  actionLabel: string;
  actionUrl: string | null;
  appUrl: string;
  /** Security messages cannot be switched off, so the footer does not offer settings. */
  mandatory: boolean;
}

export function renderEmail(content: { subject: string; body: string }, vars: TemplateVars, options: EmailRenderOptions): RenderedEmail {
  const subject = renderInline(content.subject, vars, 200);
  const actionUrl = safeUrl(options.actionUrl);
  const settingsUrl = `${options.appUrl}/settings/notifications`;
  const footer = options.mandatory
    ? 'This is a security message about your A5 Roofing Sales Academy account.'
    : 'You receive this email because you have an A5 Roofing Sales Academy account.';

  const textParts = [renderPlain(content.body, vars)];
  if (actionUrl) textParts.push(`${options.actionLabel}: ${actionUrl}`);
  textParts.push('--', footer);
  if (!options.mandatory) textParts.push(`Manage email notifications: ${settingsUrl}`);
  const text = textParts.join('\n\n');

  const button = actionUrl
    ? `<table role="presentation" cellspacing="0" cellpadding="0" style="margin:8px 0 24px 0;"><tr><td style="border-radius:6px;background:#b4471c;">` +
      `<a href="${escapeHtml(actionUrl)}" style="display:inline-block;padding:12px 22px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:6px;">${escapeHtml(options.actionLabel)}</a>` +
      `</td></tr></table>` +
      `<p style="margin:0 0 16px 0;font-size:13px;color:#5b6472;">If the button does not work, copy this address into your browser:<br>` +
      `<span style="word-break:break-all;">${escapeHtml(actionUrl)}</span></p>`
    : '';
  const settings = options.mandatory
    ? ''
    : ` <a href="${escapeHtml(settingsUrl)}" style="color:#5b6472;">Manage email notifications</a>.`;

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f3f4f6;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f3f4f6;padding:24px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:#ffffff;border-radius:8px;overflow:hidden;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:#1f2933;">
<tr><td style="background:#16263d;padding:18px 28px;color:#ffffff;font-size:16px;font-weight:700;letter-spacing:0.2px;">A5 Roofing Sales Academy</td></tr>
<tr><td style="padding:28px 28px 8px 28px;">
${renderHtmlBody(content.body, vars)}
${button}
</td></tr>
<tr><td style="padding:16px 28px 24px 28px;border-top:1px solid #e5e7eb;font-size:12px;color:#5b6472;">${escapeHtml(footer)}${settings}</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
  return { subject, text, html };
}

export function renderInApp(content: { subject: string; body: string }, vars: TemplateVars): { title: string; body: string } {
  return { title: renderInline(content.subject, vars, 200), body: renderPlain(content.body, vars).slice(0, 2000) };
}
