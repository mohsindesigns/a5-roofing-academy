import { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { learning } from '@a5/contracts';
import {
  Button,
  ConfirmDialog,
  DialogRoot,
  Field,
  IconButton,
  Input,
  SheetContent,
  Switch,
  TabsContent,
  TabsList,
  TabsRoot,
  Tag,
  Textarea,
  toast,
} from '@/components/ui';
import { LessonTypeIcon, lessonTypeLabel } from '@/features/learning/lesson-ui';
import { MediaPicker } from '@/features/content/media/media-picker';
import { ApiError, errorMessage } from '@/lib/api/errors';
import { useLessonActions, useLessonResources } from './api';
import {
  ConfigFields,
  MarkdownField,
  defaultConfig,
  type Config,
  type FieldErrors,
} from './lesson-config';
import { boundsOf, rangeHint } from './schema-bounds';
import { UnlockRulePanel } from './unlock-rule-panel';

/** What each lesson type is for, in the words shown when choosing one. */
const TYPE_HELP: Record<learning.LessonType, string> = {
  video: 'A video from the media library. Completes when enough of it has been watched.',
  article: 'Written content in Markdown. Learners mark it done when they have read it.',
  pdf: 'A PDF from the media library, read in the page.',
  document: 'A Word, PowerPoint or Excel file from the media library.',
  external: 'A link to a page outside the academy.',
  quiz: 'A quiz from the assessment bank. Completes when the learner passes it.',
  final_assessment: 'The final exam. Completes when the learner passes it.',
  assignment: 'A written response that a manager or trainer reviews.',
  ai_simulation: 'An AI homeowner role-play. Completes at a minimum score.',
  scenario: 'A scenario role-play. Completes at a minimum score.',
  manager_approval: 'A manager confirms the learner is ready to continue.',
  acknowledgment: 'The learner reads a statement and signs by typing their name.',
};

function TypePicker({ onPick }: { onPick: (t: learning.LessonType) => void }) {
  return (
    <div>
      <p className="mb-3 text-sm text-text-secondary">
        Choose what kind of lesson this is. The type cannot be changed later.
      </p>
      <ul className="grid gap-2 sm:grid-cols-2">
        {learning.LESSON_TYPES.map((t) => (
          <li key={t}>
            <button
              type="button"
              onClick={() => onPick(t)}
              className="flex h-full w-full items-start gap-3 rounded-lg border border-border bg-surface p-3 text-left hover:bg-surface-hover"
            >
              <LessonTypeIcon type={t} className="mt-0.5 size-4 shrink-0 text-brand-secondary" />
              <span>
                <span className="block text-sm font-semibold">{lessonTypeLabel(t)}</span>
                <span className="block text-xs text-text-secondary">{TYPE_HELP[t]}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ------------------------------------------------------------------ attachments

function Attachments({ lessonId }: { lessonId: string }) {
  const { list, add, remove } = useLessonResources(lessonId);
  const [kind, setKind] = useState<'link' | 'media'>('link');
  const [title, setTitle] = useState('');
  const [url, setUrl] = useState('');
  const [mediaId, setMediaId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canAdd = title.trim() && (kind === 'link' ? url.trim() : mediaId);
  return (
    <div className="grid gap-4">
      <p className="text-sm text-text-secondary">
        Extra material shown beside the lesson, such as a checklist or a reference page.
      </p>
      {list.isPending ? (
        <p className="text-sm text-text-secondary">Loading attachments…</p>
      ) : list.isError ? (
        <p role="alert" className="text-sm text-danger">
          {errorMessage(list.error)}
        </p>
      ) : list.data.items.length === 0 ? (
        <p className="text-sm text-text-secondary">No attachments yet.</p>
      ) : (
        <ul className="divide-y divide-divider border-y border-divider">
          {list.data.items.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-3 py-2">
              <p className="min-w-0 text-sm">
                <span className="font-medium">{r.title}</span>
                <span className="block truncate text-xs text-text-tertiary">
                  {r.kind === 'link' ? r.url : 'File from the media library'}
                </span>
              </p>
              <IconButton
                label={`Remove ${r.title}`}
                size="sm"
                onClick={() =>
                  remove.mutate(r.id, {
                    onError: (e) => toast.error('Could not remove the attachment', errorMessage(e)),
                  })
                }
              >
                <Trash2 className="size-4" />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
      <form
        className="grid gap-3 rounded-lg border border-border p-3"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!canAdd) return;
          setError(null);
          try {
            await add.mutateAsync(
              kind === 'link'
                ? { kind, title: title.trim(), url: url.trim() }
                : { kind, title: title.trim(), mediaAssetId: mediaId },
            );
            setTitle('');
            setUrl('');
            setMediaId(null);
          } catch (err) {
            setError(
              err instanceof ApiError && err.fields.length
                ? err.fields.map((f) => f.message).join(' ')
                : errorMessage(err),
            );
          }
        }}
      >
        <p className="text-sm font-medium">Add an attachment</p>
        <div role="group" aria-label="Attachment type" className="flex gap-1">
          <Button
            size="sm"
            variant={kind === 'link' ? 'secondary' : 'ghost'}
            aria-pressed={kind === 'link'}
            onClick={() => setKind('link')}
          >
            Link
          </Button>
          <Button
            size="sm"
            variant={kind === 'media' ? 'secondary' : 'ghost'}
            aria-pressed={kind === 'media'}
            onClick={() => setKind('media')}
          >
            File from library
          </Button>
        </div>
        <Field label="Title">
          <Input value={title} maxLength={160} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        {kind === 'link' ? (
          <Field label="Address" hint="A full web address starting with https://">
            <Input type="url" value={url} onChange={(e) => setUrl(e.target.value)} />
          </Field>
        ) : (
          <Field label="File">
            <MediaPicker kind="document" value={mediaId} onChange={setMediaId} />
          </Field>
        )}
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <div>
          <Button
            type="submit"
            leading={<Plus className="size-3.5" />}
            loading={add.isPending}
            disabled={!canAdd}
          >
            Add attachment
          </Button>
        </div>
      </form>
    </div>
  );
}

// ------------------------------------------------------------------ form

function LessonForm({
  program,
  lesson,
  moduleId,
  type,
  onClose,
  onDirty,
}: {
  program: learning.ProgramDetail;
  lesson: learning.AdminLesson | null;
  moduleId: string;
  type: learning.LessonType;
  onClose: () => void;
  onDirty: (dirty: boolean) => void;
}) {
  const actions = useLessonActions(program.id);
  const [title, setTitle] = useState(lesson?.title ?? '');
  const [summary, setSummary] = useState(lesson?.summary ?? '');
  const [body, setBody] = useState(lesson?.body ?? '');
  const [isRequired, setIsRequired] = useState(lesson?.isRequired ?? true);
  const [minutes, setMinutes] = useState(lesson?.estimatedMinutes ?? 0);
  const [config, setConfig] = useState<Config>(lesson?.config ?? defaultConfig(type));
  const [serverErrors, setServerErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [tried, setTried] = useState(false);

  const minuteBounds = boundsOf(learning.updateLessonRequestSchema)['estimatedMinutes'];
  const clientErrors = useMemo<FieldErrors>(() => {
    const parsed = learning.parseLessonConfig(type, config);
    const errors: FieldErrors = {};
    if (!parsed.success) for (const i of parsed.issues) errors[i.path] = i.message;
    return errors;
  }, [type, config]);
  const errors = { ...(tried ? clientErrors : {}), ...serverErrors };
  const hasConfigIssues = Object.keys(clientErrors).length > 0;

  const dirty = lesson
    ? title !== lesson.title ||
      summary !== (lesson.summary ?? '') ||
      body !== (lesson.body ?? '') ||
      isRequired !== lesson.isRequired ||
      minutes !== lesson.estimatedMinutes ||
      JSON.stringify(config) !== JSON.stringify(lesson.config)
    : true;
  useEffect(() => onDirty(dirty), [dirty, onDirty]);

  const save = async () => {
    setTried(true);
    setServerErrors({});
    setFormError(null);
    if (!title.trim() || hasConfigIssues) return;
    const payload = {
      title: title.trim(),
      summary: summary.trim() || null,
      body: body.trim() || null,
      isRequired,
      estimatedMinutes: minutes,
      config,
    };
    try {
      if (lesson) await actions.update.mutateAsync({ id: lesson.id, body: payload });
      else await actions.create.mutateAsync({ ...payload, moduleId, type });
      toast.success(
        lesson ? 'Lesson saved' : 'Lesson added',
        'Publish the program to show it to learners.',
      );
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.fields.length) {
        setServerErrors(Object.fromEntries(err.fields.map((f) => [f.path, f.message])));
        const unmapped = err.fields.filter(
          (f) =>
            !f.path.startsWith('config.') &&
            !['title', 'summary', 'body', 'estimatedMinutes'].includes(f.path),
        );
        if (unmapped.length) setFormError(err.message);
      } else setFormError(errorMessage(err));
    }
  };

  const busy = actions.create.isPending || actions.update.isPending;
  return (
    <form
      className="grid gap-5"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="flex items-center gap-2 text-sm text-text-secondary">
        <LessonTypeIcon type={type} className="size-4 text-brand-secondary" />
        {lessonTypeLabel(type)}
        {lesson && lesson.status !== 'published' && (
          <Tag tone={lesson.status === 'archived' ? 'neutral' : 'warning'}>
            {lesson.status === 'archived' ? 'Archived' : 'Draft'}
          </Tag>
        )}
        {lesson?.hasUnpublishedChanges && lesson.status === 'published' && (
          <Tag tone="warning">Unpublished changes</Tag>
        )}
      </div>
      <Field
        label="Title"
        required
        error={errors.title ?? (tried && !title.trim() ? 'Enter a title.' : undefined)}
      >
        <Input autoFocus value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <Field
        label="Summary"
        optional
        hint="One or two sentences shown in the lesson list."
        error={errors.summary}
      >
        <Textarea
          rows={2}
          value={summary}
          maxLength={1000}
          onChange={(e) => setSummary(e.target.value)}
        />
      </Field>

      <ConfigFields
        type={type}
        config={config}
        set={(p) => setConfig((c) => ({ ...c, ...p }))}
        errors={errors}
        minutes={minutes}
        setMinutes={setMinutes}
      />

      {type === 'article' ? (
        <MarkdownField
          label="Article"
          value={body}
          onChange={setBody}
          rows={16}
          maxLength={100_000}
          error={errors.body}
          hint="Markdown: headings, lists, links and tables. Images and raw HTML are not shown."
        />
      ) : (
        <details open={Boolean(body)}>
          <summary className="cursor-pointer text-sm font-medium">
            Notes shown with the lesson
          </summary>
          <div className="mt-2">
            <MarkdownField
              label="Notes"
              value={body}
              onChange={setBody}
              rows={6}
              optional
              maxLength={100_000}
              error={errors.body}
            />
          </div>
        </details>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Estimated time (minutes)"
          error={errors.estimatedMinutes}
          hint={rangeHint(minuteBounds) ? `Allowed: ${rangeHint(minuteBounds)}` : undefined}
        >
          <Input
            type="number"
            min={minuteBounds?.min}
            max={minuteBounds?.max}
            value={minutes}
            onChange={(e) => setMinutes(Number(e.target.value) || 0)}
          />
        </Field>
        <label className="flex items-start gap-3 sm:mt-6">
          <Switch className="mt-0.5" checked={isRequired} onCheckedChange={setIsRequired} />
          <span>
            <span className="block text-sm font-medium">Required</span>
            <span className="block text-xs text-text-tertiary">
              Required lessons count toward program completion.
            </span>
          </span>
        </label>
      </div>

      {formError && (
        <p role="alert" className="rounded bg-danger-soft px-3 py-2 text-sm text-danger">
          {formError}
        </p>
      )}
      <div className="flex justify-end gap-2 border-t border-divider pt-4">
        <Button onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary" loading={busy} disabled={!dirty}>
          {lesson ? 'Save lesson' : 'Add lesson'}
        </Button>
      </div>
    </form>
  );
}

export type LessonTarget =
  { mode: 'edit'; lessonId: string } | { mode: 'create'; moduleId: string };

/**
 * Lesson editor (side sheet). New lessons start with a type choice because each type has its own
 * required settings; existing lessons have Content, Unlock rule and Attachments tabs.
 */
export function LessonEditor({
  program,
  target,
  onClose,
  saveRule,
}: {
  program: learning.ProgramDetail;
  target: LessonTarget | null;
  onClose: () => void;
  saveRule: (lessonId: string, rule: learning.AdminLesson['unlockRule']) => Promise<unknown>;
}) {
  const [type, setType] = useState<learning.LessonType | null>(null);
  const [dirty, setDirty] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [tab, setTab] = useState('content');
  const [savingRule, setSavingRule] = useState(false);
  const [ruleError, setRuleError] = useState<string | null>(null);

  const found = useMemo(() => {
    if (target?.mode !== 'edit') return null;
    for (const p of program.phases)
      for (const m of p.modules) {
        const l = m.lessons.find((x) => x.id === target.lessonId);
        if (l) return { lesson: l, module: m, phase: p };
      }
    return null;
  }, [program, target]);
  const mod = useMemo(
    () =>
      target?.mode === 'create'
        ? program.phases.flatMap((p) => p.modules).find((m) => m.id === target.moduleId)
        : found?.module,
    [program, target, found],
  );

  const requestClose = () => {
    if (dirty && (found || type)) setConfirm(true);
    else {
      reset();
      onClose();
    }
  };
  const reset = () => {
    setType(null);
    setDirty(false);
    setTab('content');
    setRuleError(null);
  };
  const open = target !== null;
  const lessonType = found?.lesson.type ?? type;

  return (
    <>
      <DialogRoot open={open} onOpenChange={(o) => !o && requestClose()}>
        <SheetContent
          className="sm:w-[min(680px,96vw)]"
          title={found ? found.lesson.title : 'New lesson'}
          description={mod ? `In ${mod.title}` : undefined}
        >
          {target?.mode === 'create' && !type ? (
            <TypePicker onPick={setType} />
          ) : lessonType && target ? (
            found ? (
              <TabsRoot value={tab} onValueChange={setTab}>
                <TabsList
                  className="mb-5"
                  items={[
                    { value: 'content', label: 'Content' },
                    { value: 'rule', label: 'Unlock rule' },
                    { value: 'attachments', label: 'Attachments' },
                  ]}
                />
                <TabsContent value="content">
                  <LessonForm
                    key={`${found.lesson.id}-${found.lesson.updatedAt}`}
                    program={program}
                    lesson={found.lesson}
                    moduleId={found.module.id}
                    type={found.lesson.type}
                    onClose={() => {
                      reset();
                      onClose();
                    }}
                    onDirty={setDirty}
                  />
                </TabsContent>
                <TabsContent value="rule">
                  <UnlockRulePanel
                    key={`${found.lesson.id}-${found.lesson.updatedAt}`}
                    program={program}
                    self={{ kind: 'lesson', id: found.lesson.id }}
                    rule={found.lesson.unlockRule}
                    saving={savingRule}
                    error={ruleError}
                    onSave={async (rule) => {
                      setSavingRule(true);
                      setRuleError(null);
                      try {
                        await saveRule(found.lesson.id, rule);
                        toast.success(rule ? 'Rule saved' : 'Rule removed');
                      } catch (err) {
                        setRuleError(errorMessage(err));
                      } finally {
                        setSavingRule(false);
                      }
                    }}
                  />
                </TabsContent>
                <TabsContent value="attachments">
                  <Attachments lessonId={found.lesson.id} />
                </TabsContent>
              </TabsRoot>
            ) : target.mode === 'create' ? (
              <LessonForm
                program={program}
                lesson={null}
                moduleId={target.moduleId}
                type={lessonType}
                onClose={() => {
                  reset();
                  onClose();
                }}
                onDirty={setDirty}
              />
            ) : null
          ) : target?.mode === 'edit' && !found ? (
            <p className="text-sm text-text-secondary">
              This lesson no longer exists in the program.
            </p>
          ) : null}
        </SheetContent>
      </DialogRoot>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Discard your changes?"
        description="This lesson has edits that are not saved."
        confirmLabel="Discard"
        tone="danger"
        onConfirm={() => {
          setConfirm(false);
          reset();
          onClose();
        }}
      />
    </>
  );
}
