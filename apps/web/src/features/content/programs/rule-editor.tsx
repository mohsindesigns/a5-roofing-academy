import { useMemo } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import {
  Button,
  Checkbox,
  Field,
  IconButton,
  Input,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuRoot,
  MenuSeparator,
  MenuTrigger,
  Select,
} from '@/components/ui';
import { describeRule, type LeafRuleType, type RuleLabelResolver } from '@a5/rules';
import { cn } from '@/lib/cn';
import {
  LEAF_GROUPS,
  LEAF_META,
  LEAF_TYPES,
  RULE_BOUNDS,
  addChild,
  emptyGroup,
  fromDraft,
  isDraftGroup,
  newLeaf,
  removeNode,
  updateNode,
  type DraftGroup,
  type DraftLeaf,
  type DraftNode,
  type FieldSpec,
  type Problem,
  type RefKind,
} from './rule-model';
import type { Phase } from './tree';
import { ruleSchema } from '@a5/rules';

/** What the pickers can offer. A missing list (no permission to read it) turns into a text box. */
export interface RuleContext {
  phases: Phase[];
  /** The node being edited; a rule cannot depend on itself. */
  self?: { kind: 'phase' | 'module' | 'lesson'; id: string };
  programs?: Array<{ id: string; title: string }>;
  assessments?: Array<{ id: string; title: string; passingPercent: number }>;
  scenarios?: Array<{ id: string; title: string; passingScore: number }>;
  certifications?: Array<{ id: string; name: string }>;
}

interface Option {
  value: string;
  label: string;
}

function refOptions(kind: RefKind, ctx: RuleContext): Option[] | null {
  const live = <T extends { status: string }>(n: T) => n.status !== 'archived';
  switch (kind) {
    case 'phase':
      return ctx.phases
        .filter((p) => live(p) && !(ctx.self?.kind === 'phase' && ctx.self.id === p.id))
        .map((p) => ({ value: p.id, label: `${p.label}: ${p.title}` }));
    case 'module':
      return ctx.phases.flatMap((p) =>
        p.modules
          .filter((m) => live(m) && !(ctx.self?.kind === 'module' && ctx.self.id === m.id))
          .map((m) => ({ value: m.id, label: `${p.label} › ${m.title}` })),
      );
    case 'lesson':
      return ctx.phases.flatMap((p) =>
        p.modules.flatMap((m) =>
          m.lessons
            .filter((l) => live(l) && !(ctx.self?.kind === 'lesson' && ctx.self.id === l.id))
            .map((l) => ({ value: l.id, label: `${p.label} › ${m.title} › ${l.title}` })),
        ),
      );
    case 'program':
      return ctx.programs?.map((p) => ({ value: p.id, label: p.title })) ?? null;
    case 'assessment':
      return ctx.assessments?.map((a) => ({ value: a.id, label: a.title })) ?? null;
    case 'scenario':
      return ctx.scenarios?.map((s) => ({ value: s.id, label: s.title })) ?? null;
    case 'certification':
      return ctx.certifications?.map((c) => ({ value: c.id, label: c.name })) ?? null;
  }
}

/** Names for `describeRule`, so the summary reads "Complete “Lesson 3”" rather than ids. */
export function ruleResolver(ctx: RuleContext): RuleLabelResolver {
  const lessons = new Map<string, string>();
  const modules = new Map<string, string>();
  const phases = new Map<string, string>();
  for (const p of ctx.phases) {
    phases.set(p.id, p.label);
    for (const m of p.modules) {
      modules.set(m.id, m.title);
      for (const l of m.lessons) lessons.set(l.id, l.title);
    }
  }
  return {
    lesson: (id) => lessons.get(id),
    module: (id) => modules.get(id),
    phase: (id) => phases.get(id),
    program: (id) => ctx.programs?.find((p) => p.id === id)?.title,
    assessment: (id) => ctx.assessments?.find((a) => a.id === id)?.title,
    scenario: (id) => ctx.scenarios?.find((s) => s.id === id)?.title,
    certification: (id) => ctx.certifications?.find((c) => c.id === id)?.name,
  };
}

/** `datetime-local` value for an ISO instant, in the viewer's time zone. */
export function toLocalInput(iso: unknown): string {
  if (typeof iso !== 'string') return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromLocalInput(value: string): string {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

function FieldControl({
  leaf,
  spec,
  ctx,
  error,
  onChange,
}: {
  leaf: DraftLeaf;
  spec: FieldSpec;
  ctx: RuleContext;
  error?: string;
  onChange: (values: Record<string, unknown>) => void;
}) {
  const value = leaf.values[spec.name];
  const bounds = RULE_BOUNDS[leaf.type]?.[spec.name];
  const set = (v: unknown, extra: Record<string, unknown> = {}) =>
    onChange({ ...leaf.values, [spec.name]: v, ...extra });
  const f = spec.field;

  if (f.kind === 'ref') {
    const options = refOptions(f.ref, ctx);
    return (
      <Field label={spec.label} error={error} required>
        {options ? (
          <Select
            value={typeof value === 'string' ? value : ''}
            onChange={(e) => {
              const id = e.target.value;
              // Offer the assessment's own pass mark / scenario's pass score as the starting value.
              const extra: Record<string, unknown> = {};
              if (f.ref === 'assessment' && leaf.values.minPercent === undefined) {
                const a = ctx.assessments?.find((x) => x.id === id);
                if (a) extra.minPercent = a.passingPercent;
              }
              if (
                f.ref === 'scenario' &&
                leaf.type === 'ai_scenario_score' &&
                leaf.values.minScore === undefined
              ) {
                const s = ctx.scenarios?.find((x) => x.id === id);
                if (s) extra.minScore = s.passingScore;
              }
              set(id, extra);
            }}
          >
            <option value="">Choose…</option>
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
            {typeof value === 'string' && value && !options.some((o) => o.value === value) && (
              <option value={value}>Unavailable item</option>
            )}
          </Select>
        ) : (
          <Input
            value={typeof value === 'string' ? value : ''}
            placeholder="Item ID"
            onChange={(e) => set(e.target.value.trim())}
          />
        )}
      </Field>
    );
  }

  if (f.kind === 'refs') {
    const options = refOptions(f.ref, ctx);
    const selected = Array.isArray(value) ? (value as string[]) : [];
    if (!options) return null;
    return (
      <fieldset className="grid gap-1.5">
        <legend className="mb-1 text-sm font-medium">
          {spec.label} <span className="font-normal text-text-tertiary">Optional</span>
        </legend>
        {options.length === 0 && <p className="text-sm text-text-secondary">None available.</p>}
        {options.map((o) => (
          <label key={o.value} className="flex items-center gap-2.5 text-sm">
            <Checkbox
              checked={selected.includes(o.value)}
              onCheckedChange={(c) =>
                set(c === true ? [...selected, o.value] : selected.filter((x) => x !== o.value))
              }
            />
            {o.label}
          </label>
        ))}
        <p className="text-xs text-text-tertiary">Leave all unchecked to count every scenario.</p>
      </fieldset>
    );
  }

  if (f.kind === 'number') {
    const hint = [
      bounds?.min !== undefined && bounds?.max !== undefined
        ? `${bounds.min}–${bounds.max}${spec.unit === '%' ? '%' : ''}`
        : bounds?.min !== undefined
          ? `${bounds.min} or more`
          : undefined,
    ]
      .filter(Boolean)
      .join('');
    return (
      <Field
        label={spec.label}
        error={error}
        hint={hint || undefined}
        required={!spec.optional}
        optional={spec.optional}
      >
        <Input
          type="number"
          inputMode="decimal"
          min={bounds?.min}
          max={bounds?.max}
          step={bounds?.integer ? 1 : 'any'}
          value={value === undefined || value === null ? '' : String(value)}
          onChange={(e) => set(e.target.value)}
        />
      </Field>
    );
  }

  if (f.kind === 'choice') {
    return (
      <Field label={spec.label} error={error} required>
        <Select
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => set(e.target.value)}
        >
          <option value="">Choose…</option>
          {f.options.map((o) => (
            <option key={o} value={o}>
              {o.replace(/_/g, ' ')}
            </option>
          ))}
        </Select>
      </Field>
    );
  }

  if (f.kind === 'choices') {
    const selected = Array.isArray(value) ? (value as string[]) : [];
    return (
      <fieldset className="grid gap-1.5">
        <legend className="mb-1 text-sm font-medium">{spec.label}</legend>
        <div className="flex flex-wrap gap-x-5 gap-y-1.5">
          {f.options.map((o) => (
            <label key={o} className="flex items-center gap-2 text-sm capitalize">
              <Checkbox
                checked={selected.includes(o)}
                onCheckedChange={(c) =>
                  set(c === true ? [...selected, o] : selected.filter((x) => x !== o))
                }
              />
              {o}
            </label>
          ))}
        </div>
        {error && (
          <p role="alert" className="text-xs font-medium text-danger">
            {error}
          </p>
        )}
      </fieldset>
    );
  }

  return (
    <Field label={spec.label} error={error} required>
      <Input
        type="datetime-local"
        value={toLocalInput(value)}
        onChange={(e) => set(e.target.value ? fromLocalInput(e.target.value) : '')}
      />
    </Field>
  );
}

function LeafEditor({
  leaf,
  ctx,
  problems,
  onChange,
  onRemove,
}: {
  leaf: DraftLeaf;
  ctx: RuleContext;
  problems: Problem[];
  onChange: (values: Record<string, unknown>) => void;
  onRemove: () => void;
}) {
  const meta = LEAF_META[leaf.type];
  const errorFor = (spec: FieldSpec) => problems.find((p) => p.field === spec.name)?.message;
  return (
    <div className="rounded-lg border border-border bg-surface px-3.5 py-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <p className="text-sm font-semibold">{meta.label}</p>
        <IconButton label={`Remove requirement: ${meta.label}`} size="sm" onClick={onRemove}>
          <Trash2 className="size-4" />
        </IconButton>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {meta.fields.map((spec) => (
          <div
            key={spec.name}
            className={cn(
              spec.field.kind === 'choices' || spec.field.kind === 'refs'
                ? 'sm:col-span-2'
                : undefined,
            )}
          >
            <FieldControl
              leaf={leaf}
              spec={spec}
              ctx={ctx}
              error={errorFor(spec)}
              onChange={onChange}
            />
          </div>
        ))}
      </div>
      {problems
        .filter((p) => !meta.fields.some((s) => s.name === p.field))
        .map((p) => (
          <p key={p.message} role="alert" className="mt-2 text-xs font-medium text-danger">
            {p.message}
          </p>
        ))}
      <details className="mt-2">
        <summary className="cursor-pointer text-xs text-text-secondary">Custom wording</summary>
        <div className="mt-2">
          <Field
            label="Shown to learners instead of the generated sentence"
            optional
            hint="For example “Pass the objection quiz with at least 80%”."
          >
            <Input
              maxLength={200}
              value={typeof leaf.values.label === 'string' ? leaf.values.label : ''}
              onChange={(e) => onChange({ ...leaf.values, label: e.target.value })}
            />
          </Field>
        </div>
      </details>
    </div>
  );
}

function AddMenu({
  onAdd,
  onAddGroup,
}: {
  onAdd: (t: LeafRuleType) => void;
  onAddGroup: (t: 'all' | 'any') => void;
}) {
  return (
    <MenuRoot>
      <MenuTrigger asChild>
        <Button size="sm" leading={<Plus className="size-3.5" />}>
          Add requirement
        </Button>
      </MenuTrigger>
      <MenuContent align="start" className="max-h-[360px] overflow-y-auto">
        {LEAF_GROUPS.map((group) => (
          <div key={group}>
            <MenuLabel>{group}</MenuLabel>
            {LEAF_TYPES.filter((t) => LEAF_META[t].group === group).map((t) => (
              <MenuItem key={t} onSelect={() => onAdd(t)}>
                {LEAF_META[t].label}
              </MenuItem>
            ))}
          </div>
        ))}
        <MenuSeparator />
        <MenuLabel>Group</MenuLabel>
        <MenuItem onSelect={() => onAddGroup('any')}>Any one of several…</MenuItem>
        <MenuItem onSelect={() => onAddGroup('all')}>All of several…</MenuItem>
      </MenuContent>
    </MenuRoot>
  );
}

function GroupEditor({
  group,
  root,
  depth,
  ctx,
  problems,
  onChange,
}: {
  group: DraftGroup;
  root: DraftGroup;
  depth: number;
  ctx: RuleContext;
  problems: Map<string, Problem[]>;
  onChange: (next: DraftGroup) => void;
}) {
  return (
    <div className={cn(depth > 0 && 'border-l-2 border-border-strong pl-4')}>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-sm">
          <span className="text-text-secondary">{depth === 0 ? 'Learner must meet' : 'Meet'}</span>
          <div className="w-44">
            <Select
              aria-label={
                depth === 0 ? 'How requirements combine' : 'How requirements in this group combine'
              }
              value={group.type}
              onChange={(e) =>
                onChange(
                  updateNode(
                    root,
                    group.uid,
                    (n) => ({ ...n, type: e.target.value as 'all' | 'any' }) as DraftNode,
                  ),
                )
              }
            >
              <option value="all">all of these</option>
              <option value="any">any one of these</option>
            </Select>
          </div>
        </label>
        {depth > 0 && (
          <IconButton
            label="Remove this group"
            size="sm"
            onClick={() => onChange(removeNode(root, group.uid))}
          >
            <Trash2 className="size-4" />
          </IconButton>
        )}
      </div>
      {problems.get(group.uid)?.map((p) => (
        <p key={p.message} role="alert" className="mb-2 text-xs font-medium text-danger">
          {p.message}
        </p>
      ))}
      <div className="grid gap-3">
        {group.rules.map((child) =>
          isDraftGroup(child) ? (
            <GroupEditor
              key={child.uid}
              group={child}
              root={root}
              depth={depth + 1}
              ctx={ctx}
              problems={problems}
              onChange={onChange}
            />
          ) : (
            <LeafEditor
              key={child.uid}
              leaf={child}
              ctx={ctx}
              problems={problems.get(child.uid) ?? []}
              onChange={(values) =>
                onChange(updateNode(root, child.uid, (n) => ({ ...n, values }) as DraftNode))
              }
              onRemove={() => onChange(removeNode(root, child.uid))}
            />
          ),
        )}
        {group.rules.length === 0 && (
          <p className="text-sm text-text-secondary">
            {depth === 0 ? 'No requirements yet.' : 'This group is empty.'}
          </p>
        )}
        <div>
          <AddMenu
            onAdd={(t) => onChange(addChild(root, group.uid, newLeaf(t)))}
            onAddGroup={(t) => onChange(addChild(root, group.uid, emptyGroup(t)))}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * Unlock-rule editor: a tree of requirements combined with "all of" / "any one of". Thresholds
 * are limited by the `@a5/rules` schema and the rule is validated against it before saving.
 */
export function RuleEditor({
  draft,
  onChange,
  ctx,
  problems,
}: {
  draft: DraftGroup;
  onChange: (next: DraftGroup) => void;
  ctx: RuleContext;
  problems: Map<string, Problem[]>;
}) {
  const resolver = useMemo(() => ruleResolver(ctx), [ctx]);
  const rule = fromDraft(draft);
  const parsed = rule === null ? null : ruleSchema.safeParse(rule);
  const summary =
    rule === null
      ? 'No requirements: this item is available as soon as the rest of the program allows it.'
      : parsed?.success && problems.size === 0
        ? describeRule(parsed.data, resolver)
        : null;
  return (
    <div className="grid gap-4">
      <GroupEditor
        group={draft}
        root={draft}
        depth={0}
        ctx={ctx}
        problems={problems}
        onChange={onChange}
      />
      {summary && (
        <p className="rounded bg-surface-sunken px-3 py-2 text-sm text-text-secondary">
          <span className="font-medium text-text-primary">Learners see: </span>
          {summary}
        </p>
      )}
    </div>
  );
}
