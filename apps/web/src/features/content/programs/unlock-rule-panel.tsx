import { useMemo, useState } from 'react';
import type { learning } from '@a5/contracts';
import { ruleSchema, type Rule } from '@a5/rules';
import { Button, DialogContent, DialogRoot, Notice } from '@/components/ui';
import { useCertificationOptions, useProgramOptions } from '@/features/analytics/options';
import { errorMessage } from '@/lib/api/errors';
import { useAssessmentOptions, useScenarioOptions } from './api';
import { RuleEditor, type RuleContext } from './rule-editor';
import { fromDraft, sameRule, toDraft, validateDraft, type DraftGroup } from './rule-model';

/** Pickers for the rule editor, loaded for whatever the viewer is allowed to read. */
export function useRuleContext(
  program: learning.ProgramDetail,
  self?: RuleContext['self'],
): RuleContext {
  const programs = useProgramOptions('active');
  const assessments = useAssessmentOptions();
  const scenarios = useScenarioOptions();
  const certifications = useCertificationOptions();
  return useMemo(
    () => ({
      phases: program.phases,
      self,
      programs: programs.data?.items.map((p) => ({ id: p.id, title: p.title })),
      assessments: assessments.data?.items.map((a) => ({
        id: a.id,
        title: a.title,
        passingPercent: a.passingPercent,
      })),
      scenarios: scenarios.data?.items.map((s) => ({
        id: s.id,
        title: s.title,
        passingScore: s.passingScore,
      })),
      certifications: certifications.data?.items.map((c) => ({ id: c.id, name: c.name })),
    }),
    [program.phases, self, programs.data, assessments.data, scenarios.data, certifications.data],
  );
}

/**
 * Edits one unlock rule. `onSave(null)` removes the rule. The save button stays disabled until
 * the rule satisfies the `@a5/rules` schema, so a half-filled requirement can never be sent.
 */
export function UnlockRulePanel({
  program,
  self,
  rule,
  onSave,
  onCancel,
  saving,
  error,
}: {
  program: learning.ProgramDetail;
  self: NonNullable<RuleContext['self']>;
  rule: Rule | null;
  onSave: (rule: Rule | null) => void;
  onCancel?: () => void;
  saving?: boolean;
  error?: string | null;
}) {
  const ctx = useRuleContext(program, self);
  const [draft, setDraft] = useState<DraftGroup>(() => toDraft(rule));
  const problems = useMemo(() => validateDraft(draft), [draft]);
  const next = fromDraft(draft);
  const changed = !sameRule(next, rule);
  const valid = problems.size === 0;
  const sequential = program.settings.navigationMode === 'sequential';
  return (
    <div className="grid gap-4">
      {sequential && (
        <Notice tone="information">
          This program is sequential: learners already need to finish the previous required item
          before the next one opens. Requirements here are in addition to that.
        </Notice>
      )}
      <RuleEditor draft={draft} onChange={setDraft} ctx={ctx} problems={problems} />
      {error && (
        <p role="alert" className="rounded bg-danger-soft px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2 border-t border-divider pt-4">
        {onCancel && <Button onClick={onCancel}>Cancel</Button>}
        <Button
          variant="primary"
          loading={saving}
          disabled={!changed || !valid || (next !== null && !ruleSchema.safeParse(next).success)}
          onClick={() => onSave(next === null ? null : ruleSchema.parse(next))}
        >
          {next === null && rule !== null ? 'Remove rule' : 'Save rule'}
        </Button>
      </div>
    </div>
  );
}

export interface RuleTarget {
  kind: 'phase' | 'module';
  id: string;
  title: string;
  rule: Rule | null;
}

export function UnlockRuleDialog({
  target,
  program,
  onClose,
  save,
}: {
  target: RuleTarget | null;
  program: learning.ProgramDetail;
  onClose: () => void;
  save: (target: RuleTarget, rule: Rule | null) => Promise<unknown>;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <DialogRoot
      open={target !== null}
      onOpenChange={(o) => {
        if (!o) {
          setError(null);
          onClose();
        }
      }}
    >
      <DialogContent
        size="lg"
        title={target ? `Unlock rule: ${target.title}` : 'Unlock rule'}
        description={`Choose what a learner must do before this ${target?.kind ?? 'item'} opens.`}
      >
        {target && (
          <UnlockRulePanel
            key={target.id}
            program={program}
            self={{ kind: target.kind, id: target.id }}
            rule={target.rule}
            saving={saving}
            error={error}
            onCancel={onClose}
            onSave={async (rule) => {
              setSaving(true);
              setError(null);
              try {
                await save(target, rule);
                onClose();
              } catch (err) {
                setError(errorMessage(err));
              } finally {
                setSaving(false);
              }
            }}
          />
        )}
      </DialogContent>
    </DialogRoot>
  );
}
