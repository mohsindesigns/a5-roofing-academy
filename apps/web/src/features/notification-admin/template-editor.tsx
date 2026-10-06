import { useEffect, useMemo, useRef, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import type { notification } from '@a5/contracts';
import {
  Button,
  ConfirmDialog,
  Field,
  Input,
  Notice,
  Switch,
  Tag,
  Textarea,
  toast,
} from '@/components/ui';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { ApiError, errorMessage } from '@/lib/api/errors';
import { formatDateTime } from '@/lib/format';
import { usePreviewTemplate, useResetTemplate, useUpdateTemplate } from './api';
import { insertAt, placeholderIssues } from './placeholders';

type FieldName = 'subject' | 'body';

function Preview({
  template,
  subject,
  body,
  samples,
  blocked,
}: {
  template: notification.NotificationTemplate;
  subject: string;
  body: string;
  samples: Record<string, string>;
  blocked: boolean;
}) {
  const preview = usePreviewTemplate(template.id);
  const [view, setView] = useState<'rendered' | 'text'>('rendered');
  const debounced = useDebouncedValue(JSON.stringify({ subject, body, samples }), 500);
  const { mutate } = preview;
  useEffect(() => {
    if (blocked) return;
    const v = JSON.parse(debounced) as {
      subject: string;
      body: string;
      samples: Record<string, string>;
    };
    if (!v.subject.trim() || !v.body.trim()) return;
    mutate({ subject: v.subject, body: v.body, data: v.samples });
  }, [debounced, blocked, mutate]);

  const result = preview.data;
  const isEmail = template.channel === 'email';
  return (
    <section aria-labelledby={`preview-${template.id}`}>
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 id={`preview-${template.id}`} className="text-md font-semibold">
          Preview
        </h3>
        {isEmail && (
          <div role="group" aria-label="Preview format" className="flex gap-1">
            {(['rendered', 'text'] as const).map((v) => (
              <Button
                key={v}
                size="sm"
                variant={view === v ? 'secondary' : 'ghost'}
                aria-pressed={view === v}
                onClick={() => setView(v)}
              >
                {v === 'rendered' ? 'Email' : 'Plain text'}
              </Button>
            ))}
          </div>
        )}
      </div>
      {blocked ? (
        <p className="text-sm text-text-secondary">Fix the placeholders above to see a preview.</p>
      ) : preview.isError ? (
        <p role="alert" className="rounded bg-danger-soft px-3 py-2 text-sm text-danger">
          {errorMessage(preview.error)}
        </p>
      ) : !result ? (
        <p className="text-sm text-text-secondary" aria-busy={preview.isPending}>
          {preview.isPending ? 'Rendering preview…' : 'Write a subject and body to see a preview.'}
        </p>
      ) : (
        <div aria-busy={preview.isPending}>
          <p className="mb-2 text-sm">
            <span className="text-text-tertiary">{isEmail ? 'Subject: ' : 'Title: '}</span>
            <span className="font-medium">{result.subject}</span>
          </p>
          {isEmail && view === 'rendered' && result.html ? (
            // Sandboxed with no permissions: the preview can never run script or navigate.
            <iframe
              title="Email preview"
              sandbox=""
              srcDoc={result.html}
              className="h-[520px] w-full rounded border border-border bg-white"
            />
          ) : (
            <pre className="max-h-[360px] overflow-auto rounded border border-border bg-surface-sunken p-3 font-sans text-sm break-words whitespace-pre-wrap">
              {result.text}
            </pre>
          )}
          {result.link && (
            <p className="mt-2 text-xs text-text-tertiary">
              Links to <span className="font-mono">{result.link}</span> in the sample.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * Edits the wording and on/off state of one template (one notification type on one channel).
 * Placeholders are checked as you type, the preview is rendered by the API from the unsaved text
 * and sample values, and saving is recorded in the audit log.
 */
export function TemplateEditor({
  template,
  onDirtyChange,
}: {
  template: notification.NotificationTemplate;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [subject, setSubject] = useState(template.subject);
  const [body, setBody] = useState(template.body);
  const [enabled, setEnabled] = useState(template.enabled);
  const [samples, setSamples] = useState<Record<string, string>>(() =>
    Object.fromEntries(template.variables.map((v) => [v.name, v.sample])),
  );
  const [confirmReset, setConfirmReset] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const subjectRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const lastField = useRef<FieldName>('body');
  const update = useUpdateTemplate(template.id);
  const reset = useResetTemplate(template.id);

  const allowed = useMemo(() => template.variables.map((v) => v.name), [template.variables]);
  const subjectIssues = placeholderIssues(subject, allowed);
  const bodyIssues = placeholderIssues(body, allowed);
  const dirty =
    subject !== template.subject || body !== template.body || enabled !== template.enabled;
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

  // After a save or reset the server copy changes; follow it.
  useEffect(() => {
    setSubject(template.subject);
    setBody(template.body);
    setEnabled(template.enabled);
  }, [template.subject, template.body, template.enabled]);

  const insertVariable = (name: string) => {
    const token = `{{${name}}}`;
    if (lastField.current === 'subject' && subjectRef.current) {
      const el = subjectRef.current;
      const r = insertAt(
        subject,
        el.selectionStart ?? subject.length,
        el.selectionEnd ?? subject.length,
        token,
      );
      setSubject(r.text);
      requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(r.caret, r.caret);
      });
    } else if (bodyRef.current) {
      const el = bodyRef.current;
      const r = insertAt(
        body,
        el.selectionStart ?? body.length,
        el.selectionEnd ?? body.length,
        token,
      );
      setBody(r.text);
      requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(r.caret, r.caret);
      });
    }
  };

  const save = async () => {
    setError(null);
    try {
      await update.mutateAsync({ subject, body, enabled });
      toast.success('Template saved', 'The new wording is used for the next notification.');
    } catch (err) {
      if (err instanceof ApiError && err.fields.length) {
        setError(err.fields.map((f) => f.message).join(' '));
      } else setError(errorMessage(err));
    }
  };

  const isEmail = template.channel === 'email';
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold">{template.typeLabel}</h2>
          <p className="mt-0.5 flex flex-wrap items-center gap-2 text-sm text-text-secondary">
            <span>{isEmail ? 'Email' : 'In-app notification'}</span>
            <Tag tone={template.isDefault ? 'neutral' : 'accent'}>
              {template.isDefault ? 'Default wording' : 'Edited'}
            </Tag>
            <span className="text-text-tertiary">
              Updated {formatDateTime(template.updatedAt)}
              {template.updatedBy && ` by ${template.updatedBy.displayName}`}
            </span>
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <Switch
            checked={enabled}
            onCheckedChange={setEnabled}
            aria-label={`Send ${template.typeLabel} ${isEmail ? 'by email' : 'as an in-app notification'}`}
          />
          {enabled ? 'On' : 'Off'}
        </label>
      </header>

      {template.sensitive && (
        <Notice tone="warning" title="Security message">
          This message carries a one-time link. The link can only appear in the body, and the sent
          message is never kept in the delivery log.
        </Notice>
      )}

      <div className="grid gap-4">
        <Field
          label={isEmail ? 'Subject' : 'Title'}
          error={subjectIssues[0]}
          hint="One line. Add variables from the list below, written like {{variableName}}."
        >
          <Input
            ref={subjectRef}
            value={subject}
            maxLength={200}
            onFocus={() => (lastField.current = 'subject')}
            onChange={(e) => setSubject(e.target.value)}
          />
        </Field>
        <Field label="Message" error={bodyIssues[0]}>
          <Textarea
            ref={bodyRef}
            rows={9}
            value={body}
            maxLength={5000}
            className="font-mono text-sm"
            onFocus={() => (lastField.current = 'body')}
            onChange={(e) => setBody(e.target.value)}
          />
        </Field>
        {error && (
          <p role="alert" className="rounded bg-danger-soft px-3 py-2 text-sm text-danger">
            {error}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            loading={update.isPending}
            disabled={!dirty || subjectIssues.length + bodyIssues.length > 0}
            onClick={save}
          >
            Save changes
          </Button>
          <Button
            disabled={!dirty}
            onClick={() => {
              setSubject(template.subject);
              setBody(template.body);
              setEnabled(template.enabled);
              setError(null);
            }}
          >
            Discard
          </Button>
          <Button
            variant="ghost"
            className="ml-auto"
            leading={<RotateCcw className="size-4" />}
            disabled={template.isDefault && template.enabled}
            onClick={() => setConfirmReset(true)}
          >
            Restore default wording
          </Button>
        </div>
      </div>

      <section aria-labelledby={`vars-${template.id}`}>
        <h3 id={`vars-${template.id}`} className="mb-1 text-md font-semibold">
          Variables
        </h3>
        <p className="mb-2 text-sm text-text-secondary">
          Insert a variable at the cursor. The sample value is only used for the preview.
        </p>
        <ul className="divide-y divide-divider border-y border-divider">
          {template.variables.map((v) => (
            <li
              key={v.name}
              className="grid items-center gap-x-4 gap-y-1 py-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,180px)]"
            >
              <div className="min-w-0">
                <button
                  type="button"
                  className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-xs hover:bg-surface-selected"
                  onClick={() => insertVariable(v.name)}
                  aria-label={`Insert ${v.name}`}
                >
                  {`{{${v.name}}}`}
                </button>
              </div>
              <p className="text-sm text-text-secondary">{v.description}</p>
              <Input
                aria-label={`Sample value for ${v.name}`}
                value={samples[v.name] ?? ''}
                maxLength={500}
                onChange={(e) => setSamples((s) => ({ ...s, [v.name]: e.target.value }))}
              />
            </li>
          ))}
        </ul>
      </section>

      <Preview
        template={template}
        subject={subject}
        body={body}
        samples={samples}
        blocked={subjectIssues.length + bodyIssues.length > 0}
      />

      <ConfirmDialog
        open={confirmReset}
        onOpenChange={setConfirmReset}
        title="Restore the default wording?"
        description="Your edits to this template are replaced with the wording that ships with the academy, and the template is switched on. The change is recorded in the audit log."
        confirmLabel="Restore default"
        loading={reset.isPending}
        onConfirm={async () => {
          try {
            await reset.mutateAsync();
            toast.success('Default wording restored');
            setConfirmReset(false);
          } catch (err) {
            toast.error('Could not restore the default', errorMessage(err));
          }
        }}
      />
    </div>
  );
}
