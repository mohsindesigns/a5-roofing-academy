import { useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import type { learning } from '@a5/contracts';
import type { Rule } from '@a5/rules';
import {
  Button,
  ConfirmDialog,
  DialogContent,
  DialogRoot,
  EmptyState,
  Field,
  Input,
  Switch,
  Textarea,
  toast,
} from '@/components/ui';
import { useCan } from '@/features/auth/session';
import { useSearchState } from '@/hooks/use-search-state';
import { ApiError, errorMessage } from '@/lib/api/errors';
import { useLessonActions, useMove, useStructure } from './api';
import { LessonEditor, type LessonTarget } from './lesson-editor';
import { StructureTree, type TreeActions } from './structure-tree';
import { describeLocation, findNode, planMoveTo, planStep, titleOf, type NodeKind } from './tree';
import { UnlockRuleDialog, useRuleContext, type RuleTarget } from './unlock-rule-panel';
import { ruleResolver } from './rule-editor';

// ------------------------------------------------------------------ phase / module dialog

type NodeDialogState =
  | { mode: 'create'; kind: 'phase' }
  | { mode: 'create'; kind: 'module'; phaseId: string }
  | { mode: 'edit'; kind: 'phase' | 'module'; id: string; title: string; summary: string | null };

function NodeDialog({
  state,
  phaseLabel,
  onClose,
  save,
}: {
  state: NodeDialogState | null;
  phaseLabel: string;
  onClose: () => void;
  save: (
    state: NodeDialogState,
    values: { title: string; summary: string | null },
  ) => Promise<unknown>;
}) {
  const noun = state?.kind === 'phase' ? phaseLabel.toLowerCase() : 'module';
  return (
    <DialogRoot open={state !== null} onOpenChange={(o) => !o && onClose()}>
      {state && (
        <DialogContent
          size="sm"
          title={state.mode === 'create' ? `Add ${noun}` : `Edit ${noun}`}
          description={
            state.kind === 'phase'
              ? `A ${noun} groups modules and can have its own unlock rule.`
              : 'A module groups related lessons.'
          }
        >
          <NodeForm
            key={state.mode === 'edit' ? state.id : `${state.kind}-new`}
            initialTitle={state.mode === 'edit' ? state.title : ''}
            initialSummary={state.mode === 'edit' ? (state.summary ?? '') : ''}
            onCancel={onClose}
            onSubmit={async (values) => {
              await save(state, values);
              onClose();
            }}
          />
        </DialogContent>
      )}
    </DialogRoot>
  );
}

function NodeForm({
  initialTitle,
  initialSummary,
  onCancel,
  onSubmit,
}: {
  initialTitle: string;
  initialSummary: string;
  onCancel: () => void;
  onSubmit: (v: { title: string; summary: string | null }) => Promise<void>;
}) {
  const [title, setTitle] = useState(initialTitle);
  const [summary, setSummary] = useState(initialSummary);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  return (
    <form
      className="grid gap-4"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!title.trim()) return;
        setSaving(true);
        setErrors({});
        setFormError(null);
        try {
          await onSubmit({ title: title.trim(), summary: summary.trim() || null });
        } catch (err) {
          if (err instanceof ApiError && err.fields.length)
            setErrors(Object.fromEntries(err.fields.map((f) => [f.path, f.message])));
          else setFormError(errorMessage(err));
          setSaving(false);
        }
      }}
    >
      <Field label="Title" required error={errors.title}>
        <Input autoFocus value={title} maxLength={160} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <Field label="Summary" optional error={errors.summary}>
        <Textarea
          rows={3}
          value={summary}
          maxLength={1000}
          onChange={(e) => setSummary(e.target.value)}
        />
      </Field>
      {formError && (
        <p role="alert" className="rounded bg-danger-soft px-3 py-2 text-sm text-danger">
          {formError}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button onClick={onCancel}>Cancel</Button>
        <Button type="submit" variant="primary" loading={saving} disabled={!title.trim()}>
          Save
        </Button>
      </div>
    </form>
  );
}

// ------------------------------------------------------------------ tab

type Removal = { kind: 'phase' | 'module' | 'lesson'; id: string; title: string };

export function StructureTab({ program }: { program: learning.ProgramDetail }) {
  const canEdit = useCan('lessons.update') && program.status !== 'archived';
  const canCreate = useCan('lessons.create') && program.status !== 'archived';
  const [url, setUrl] = useSearchState({ lesson: '' });
  const [showArchived, setShowArchived] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const [nodeDialog, setNodeDialog] = useState<NodeDialogState | null>(null);
  const [ruleTarget, setRuleTarget] = useState<RuleTarget | null>(null);
  const [creating, setCreating] = useState<string | null>(null);
  const [removal, setRemoval] = useState<Removal | null>(null);
  const [removalError, setRemovalError] = useState<string | null>(null);

  const ruleContext = useRuleContext(program);
  const resolver = useMemo(() => ruleResolver(ruleContext), [ruleContext]);
  const move = useMove(program.id);
  const structure = useStructure(program.id);
  const lessons = useLessonActions(program.id);
  const label = program.phaseLabel;

  const lessonTarget: LessonTarget | null = creating
    ? { mode: 'create', moduleId: creating }
    : url.lesson
      ? { mode: 'edit', lessonId: url.lesson }
      : null;

  const focusAfter = (kind: NodeKind, id: string, dir: 'up' | 'down') => {
    setTimeout(() => {
      const first = document.querySelector<HTMLButtonElement>(
        `[data-focus-key="${kind}:${id}:${dir}"]`,
      );
      const other = document.querySelector<HTMLButtonElement>(
        `[data-focus-key="${kind}:${id}:${dir === 'up' ? 'down' : 'up'}"]`,
      );
      (first && !first.disabled ? first : other)?.focus();
    }, 0);
  };

  const run = async (
    plan: Parameters<typeof move.mutateAsync>[0] | null,
    focus?: 'up' | 'down',
  ) => {
    if (!plan) return;
    const kind: NodeKind = plan.kind;
    const id =
      plan.kind === 'phase' ? plan.phaseId : plan.kind === 'module' ? plan.moduleId : plan.lessonId;
    const name = titleOf(program.phases, kind, id);
    try {
      const next = await move.mutateAsync(plan);
      setAnnouncement(`Moved ${name} to ${describeLocation(next.phases, kind, id)}.`);
      if (focus) focusAfter(kind, id, focus);
    } catch (err) {
      toast.error(`Could not move ${name}`, errorMessage(err));
    }
  };

  const actions: TreeActions = {
    move: (plan) => void run(plan),
    step: (kind, id, direction) =>
      void run(
        planStep(program.phases, kind, id, direction, { includeArchived: showArchived }),
        direction < 0 ? 'up' : 'down',
      ),
    moveTo: (kind, id, parentId) => void run(planMoveTo(program.phases, kind, id, parentId)),
    editLesson: (id) => setUrl({ lesson: id }),
    addLesson: (moduleId) => setCreating(moduleId),
    addModule: (phaseId) => setNodeDialog({ mode: 'create', kind: 'module', phaseId }),
    editNode: (kind, id) => {
      const at = findNode(program.phases, kind, id);
      const node = kind === 'phase' ? at?.phase : at?.module;
      if (node) setNodeDialog({ mode: 'edit', kind, id, title: node.title, summary: node.summary });
    },
    editRule: (kind, id) => {
      const at = findNode(program.phases, kind, id);
      const node = kind === 'phase' ? at?.phase : at?.module;
      if (node) setRuleTarget({ kind, id, title: node.title, rule: node.unlockRule });
    },
    setArchived: async (kind, id, archived) => {
      const name = titleOf(program.phases, kind, id);
      try {
        if (kind === 'lesson') await lessons.archive.mutateAsync({ id, archived });
        else await structure.setArchived(kind === 'phase' ? 'phases' : 'modules', id, archived);
        toast.success(archived ? `${name} archived` : `${name} restored`);
      } catch (err) {
        toast.error('That did not work', errorMessage(err));
      }
    },
    duplicateLesson: async (id) => {
      try {
        const copy = await lessons.duplicate.mutateAsync(id);
        toast.success('Lesson duplicated', copy.title);
      } catch (err) {
        toast.error('Could not duplicate the lesson', errorMessage(err));
      }
    },
    remove: (kind, id) => {
      setRemovalError(null);
      setRemoval({ kind, id, title: titleOf(program.phases, kind, id) });
    },
  };

  const saveRule = async (target: RuleTarget, rule: Rule | null) =>
    target.kind === 'phase'
      ? structure.updatePhase(target.id, { unlockRule: rule })
      : structure.updateModule(target.id, { unlockRule: rule });

  const hasContent = program.phases.length > 0;
  const emptyModule = useMemo(
    () => program.phases.every((p) => p.modules.length === 0),
    [program.phases],
  );

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-sm text-text-secondary">
          <Switch
            checked={showArchived}
            onCheckedChange={setShowArchived}
            aria-label="Show archived items"
          />
          Show archived
        </label>
        {canCreate && (
          <Button
            leading={<Plus className="size-4" />}
            onClick={() => setNodeDialog({ mode: 'create', kind: 'phase' })}
          >
            Add {label.toLowerCase()}
          </Button>
        )}
      </div>

      {!hasContent ? (
        <EmptyState
          title={`No ${label.toLowerCase()}s yet`}
          description={`Start with a ${label.toLowerCase()}, add modules to it, then add lessons. Reorder anything by dragging, or with the arrow buttons.`}
          action={
            canCreate && (
              <Button
                variant="primary"
                onClick={() => setNodeDialog({ mode: 'create', kind: 'phase' })}
              >
                Add {label.toLowerCase()}
              </Button>
            )
          }
        />
      ) : (
        <>
          <p className="mb-3 text-sm text-text-secondary">
            {canEdit
              ? 'Drag a row to move it, or use the arrow buttons and the row menu. Changes are saved straight away and reach learners when you publish.'
              : 'You can view this program but not change it.'}
            {emptyModule && ` Add a module to a ${label.toLowerCase()} to start adding lessons.`}
          </p>
          <StructureTree
            phases={program.phases}
            canEdit={canEdit}
            showArchived={showArchived}
            actions={actions}
            resolver={resolver}
          />
        </>
      )}

      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>

      <NodeDialog
        state={nodeDialog}
        phaseLabel={label}
        onClose={() => setNodeDialog(null)}
        save={async (state, values) => {
          if (state.mode === 'create') {
            return state.kind === 'phase'
              ? structure.createPhase(values)
              : structure.createModule(state.phaseId, values);
          }
          return state.kind === 'phase'
            ? structure.updatePhase(state.id, values)
            : structure.updateModule(state.id, values);
        }}
      />

      <UnlockRuleDialog
        target={ruleTarget}
        program={program}
        onClose={() => setRuleTarget(null)}
        save={async (target, rule) => {
          await saveRule(target, rule);
          toast.success(rule ? 'Unlock rule saved' : 'Unlock rule removed');
        }}
      />

      <LessonEditor
        program={program}
        target={lessonTarget}
        onClose={() => {
          setCreating(null);
          setUrl({ lesson: '' });
        }}
        saveRule={(lessonId, rule) =>
          lessons.update.mutateAsync({ id: lessonId, body: { unlockRule: rule } })
        }
      />

      <ConfirmDialog
        open={removal !== null}
        onOpenChange={(o) => !o && setRemoval(null)}
        title={`Delete ${removal?.title ?? ''}?`}
        description={
          removal?.kind === 'lesson'
            ? 'A lesson that was never published and has no learner activity is deleted for good. Otherwise it is archived so progress and history stay intact.'
            : `Everything inside is affected. Items that were never published and have no learner activity are deleted for good; everything else is archived.`
        }
        confirmLabel="Delete"
        tone="danger"
        loading={structure.pending || lessons.remove.isPending}
        error={removalError}
        onConfirm={async () => {
          if (!removal) return;
          setRemovalError(null);
          try {
            const result =
              removal.kind === 'lesson'
                ? await lessons.remove.mutateAsync(removal.id)
                : await structure.remove(
                    removal.kind === 'phase' ? 'phases' : 'modules',
                    removal.id,
                  );
            toast.success(
              result.outcome === 'deleted' ? 'Deleted' : 'Archived instead',
              result.message,
            );
            setRemoval(null);
          } catch (err) {
            setRemovalError(errorMessage(err));
          }
        }}
      />
    </div>
  );
}
