import { describe, expect, it } from 'vitest';
import { notification } from '@a5/contracts';
import { getEventDefinition } from '@a5/events';
import { matchesConditions } from '../src/catalog/conditions.js';
import { EVENT_DESCRIPTORS, NOTIFICATION_TYPE_DEFS, variablesOf } from '../src/catalog/notification-types.js';
import { ContentSealer } from '../src/email/sealer.js';
import {
  escapeHtml,
  malformedPlaceholders,
  referencedVariables,
  renderEmail,
  renderInApp,
  renderInline,
  renderPlain,
} from '../src/templates/renderer.js';
import { validateTemplate } from '../src/templates/templates.service.js';

describe('template renderer', () => {
  it('substitutes variables and renders unknown ones as empty', () => {
    expect(renderPlain('Hi {{ recipientFirstName }}, {{missing}}welcome.', { recipientFirstName: 'Kayla' })).toBe('Hi Kayla, welcome.');
    expect(referencedVariables('{{a}} {{ b }} {{a}}')).toEqual(['a', 'b']);
  });

  it('escapes values and literal text in the HTML part only', () => {
    const vars = { programTitle: '<script>alert("x")</script> & Co', recipientFirstName: "O'Neil" };
    const email = renderEmail(
      { subject: 'Enrolled in {{programTitle}}', body: 'Hi {{recipientFirstName}},\n\nYou are in <b>{{programTitle}}</b>.' },
      vars,
      { actionLabel: 'Start training', actionUrl: 'https://academy.a5roofing.example/training/1', appUrl: 'https://academy.a5roofing.example', mandatory: false },
    );
    expect(email.html).not.toContain('<script>');
    expect(email.html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; Co');
    expect(email.html).toContain('&lt;b&gt;');
    expect(email.html).toContain('O&#39;Neil');
    expect(email.html).toContain('href="https://academy.a5roofing.example/training/1"');
    // The plain-text alternative keeps the raw text; the subject is a single line.
    expect(email.text).toContain('<script>alert("x")</script> & Co');
    expect(email.text).toContain('Start training: https://academy.a5roofing.example/training/1');
    expect(email.text).toContain('Manage email notifications: https://academy.a5roofing.example/settings/notifications');
    expect(email.subject).toBe('Enrolled in <script>alert("x")</script> & Co');
  });

  it('never links non-http URLs and keeps subjects header-safe', () => {
    const email = renderEmail({ subject: 'Line {{x}}', body: 'Body' }, { x: 'one\r\nBcc: someone@example.com' }, {
      actionLabel: 'Open',
      actionUrl: 'javascript:alert(1)',
      appUrl: 'https://academy.a5roofing.example',
      mandatory: true,
    });
    expect(email.html).not.toContain('javascript:');
    expect(email.subject).toBe('Line one Bcc: someone@example.com');
    expect(email.text).not.toContain('Manage email notifications');
    expect(renderInline('{{x}}', { x: 'a'.repeat(300) }, 50)).toHaveLength(50);
  });

  it('strips control characters and collapses blank lines', () => {
    expect(renderPlain('A{{x}}B\n\n\n\nC  D', { x: '\u0000\u0007' })).toBe('AB\n\nC D');
    expect(renderInApp({ subject: 'T', body: '{{x}}' }, { x: 'y'.repeat(3000) }).body).toHaveLength(2000);
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  });

  it('reports malformed placeholders', () => {
    expect(malformedPlaceholders('Hi {{ name }} and {{bad name}} and {{oops')).toEqual(['{{bad name}}', '{{oops']);
    expect(malformedPlaceholders('Plain {{ok}} text')).toEqual([]);
  });
});

describe('rule conditions', () => {
  const payload = { passed: false, kind: 'quiz', scorePercent: 74, context: { programId: 'p1' }, comment: null };
  it('supports equality, lists, operators and nested paths', () => {
    expect(matchesConditions(payload, {})).toBe(true);
    expect(matchesConditions(payload, { passed: false })).toBe(true);
    expect(matchesConditions(payload, { passed: true })).toBe(false);
    expect(matchesConditions(payload, { kind: ['quiz', 'final'] })).toBe(true);
    expect(matchesConditions(payload, { kind: { notIn: ['practice'] }, scorePercent: { gte: 70, lt: 80 } })).toBe(true);
    expect(matchesConditions(payload, { scorePercent: { gt: 80 } })).toBe(false);
    expect(matchesConditions(payload, { 'context.programId': 'p1' })).toBe(true);
    expect(matchesConditions(payload, { comment: null, missing: null })).toBe(true);
    expect(matchesConditions(payload, { kind: { ne: 'quiz' } })).toBe(false);
  });

  it('validates condition documents', () => {
    expect(notification.ruleConditionsSchema.safeParse({ passed: false, kind: ['quiz'] }).success).toBe(true);
    expect(notification.ruleConditionsSchema.safeParse({ 'bad path!': 1 }).success).toBe(false);
    expect(notification.ruleConditionsSchema.safeParse({ score: { between: [1, 2] } }).success).toBe(false);
    expect(notification.ruleConditionsSchema.safeParse({ score: {} }).success).toBe(false);
  });
});

describe('notification catalog', () => {
  it('covers every notification type of the contract exactly once', () => {
    expect(NOTIFICATION_TYPE_DEFS.map((d) => d.key).sort()).toEqual([...notification.NOTIFICATION_TYPES].sort());
  });

  it('ships valid default templates for every supported channel', () => {
    for (const def of NOTIFICATION_TYPE_DEFS) {
      expect(getEventDefinition(def.eventType, 1), def.key).toBeDefined();
      expect(EVENT_DESCRIPTORS[def.eventType], def.key).toBeDefined();
      for (const channel of def.channels) {
        const content = def.defaults[channel];
        expect(content, `${def.key}/${channel}`).toBeDefined();
        expect(validateTemplate(def, content!), `${def.key}/${channel}`).toEqual([]);
      }
      expect(def.rule.channels.every((c) => def.channels.includes(c)), def.key).toBe(true);
      const names = variablesOf(def).map((v) => v.name);
      expect(new Set(names).size, `${def.key} has duplicate variables`).toBe(names.length);
    }
  });

  it('keeps security messages email-only and mandatory', () => {
    for (const def of NOTIFICATION_TYPE_DEFS.filter((d) => d.sensitive)) {
      expect(def.mandatory).toBe(true);
      expect(def.channels).toEqual(['email']);
    }
  });
});

describe('content sealer', () => {
  it('round-trips and rejects tampering or another key', () => {
    const sealer = new ContentSealer('test-internal-secret-0123456789abcdef0123');
    const sealed = sealer.seal({ text: 'https://academy.a5roofing.example/activate?token=abc' });
    expect(sealed).not.toContain('token=abc');
    expect(sealer.unseal<{ text: string }>(sealed).text).toContain('token=abc');
    const [v, iv, tag, ct] = sealed.split('.');
    const flipped = `${v}.${iv}.${tag}.${ct!.slice(0, -2)}AA`;
    expect(() => sealer.unseal(flipped)).toThrow();
    expect(() => new ContentSealer('another-secret-0123456789abcdef0123456789').unseal(sealed)).toThrow();
  });
});
