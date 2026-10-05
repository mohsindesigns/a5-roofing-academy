import { createContext, useContext, useId, useMemo, type ReactNode } from 'react';
import { useQueries } from '@tanstack/react-query';
import { ChevronDown, Plus, Trash2 } from 'lucide-react';
import { isGroup, type LeafRule, type Rule } from '@a5/rules';
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
  MultiSelect,
  Select,
} from '@/components/ui';
import { ApiError } from '@/lib/api/errors';
import { cn } from '@/lib/cn';
import {
  programStructureQuery,
  useAssessmentLookup,
  useDefinitionOptions,
  useProgramLookup,
  useScenarioLookup,
  type LookupOption,
} from './api';
import {
  ADDABLE_LEAVES,
  ASSESSMENT_KINDS,
  LEAF_LABEL,
  UNSET,
  appendAt,
  emptyGroup,
  newLeaf,
  removeAt,
  replaceAt,
  ruleProblems,
  samePath,
  type RulePath,
} from './rule-model';

// ------------------------------------------------------------------ reference data

interface Lookup {
  options: LookupOption[];
  state: 'loading' | 'ready' | 'denied' | 'error';
}

interface Lookups {
  programs: Lookup;
  assessments: Lookup;
  scenarios: Lookup;
  certifications: Lookup;
  phases: Lookup;
  lessons: Lookup;
}

const Ctx = createContext<Lookups | null>(null);

function fromQuery(q: {
  data: LookupOption[] | undefined;
  isPending: boolean;
  isError: boolean;
  error: unknown;
}): Lookup {
  if (q.isPending) return { options: [], state: 'loading' };
  if (q.isError) {
    return {
      options: [],
      state: q.error instanceof ApiError && q.error.isForbidden ? 'denied' : 'error',
    };
  }
  return { options: q.data ?? [], state: 'ready' };
}

function useLookups(programIds: readonly string[], excludeCertificationId?: string): Lookups {
  const programs = useProgramLookup();
  const assessments = useAssessmentLookup();
  const scenarios = useScenarioLookup();
  const definitions = useDefinitionOptions();
  const structures = useQueries({ queries: programIds.map((id) => programStructureQuery(id)) });
  const structureKey = structures.map((s) => s.dataUpdatedAt).join(',');

  return useMemo<Lookups>(() => {
    const phases: LookupOption[] = [];
    const lessons: LookupOption[] = [];
    for (const s of structures) {
      const program = s.data;
      if (!program) continue;
      for (const phase of program.phases) {
        phases.push({
          id: phase.id,
          label: `${program.title} › ${phase.label} ${phase.position}: ${phase.title}`,
        });
        for (const mod of phase.modules) {
          for (const lesson of mod.lessons) {
            lessons.push({ id: lesson.id, label: `${program.title} › ${lesson.title}` });
          }
        }
      }
    }
    const structureState: Lookup['state'] = structures.some((s) => s.isPending)
      ? 'loading'
      : structures.some((s) => s.isError)
        ? structures.some((s) => s.error instanceof ApiError && s.error.isForbidden)
          ? 'denied'
          : 'error'
        : 'ready';
    return {
      programs: fromQuery(programs),
      assessments: fromQuery(assessments),
      scenarios: fromQuery(scenarios),
      certifications: fromQuery({
        data: definitions.data?.items
          .filter((d) => d.id !== excludeCertificationId)
          .map((d) => ({ id: d.id, label: d.name })),
        isPending: definitions.isPending,
        isError: definitions.isError,
        error: definitions.error,
      }),
      phases: { options: phases, state: structureState },
      lessons: { options: lessons, state: structureState },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    programs.data,
    programs.isPending,
    programs.isError,
    assessments.data,
    assessments.isPending,
    assessments.isError,
    scenarios.data,
    scenarios.isPending,
    scenarios.isError,
    definitions.data,
    definitions.isPending,
    definitions.isError,
    excludeCertificationId,
    structureKey,
  ]);
}

function useLookupContext(): Lookups {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('RuleEditor lookups are missing');
  return ctx;
}

// ------------------------------------------------------------------ small controls

function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  unit,
  hint,
  disabled,
  invalid,
  describedBy,
}: {
  label: string;
  value: number | undefined;
  onChange: (v: number) => void;
  min: number;
  max: number;
  unit?: string;
  hint?: string;
  disabled?: boolean;
  invalid?: boolean;
  describedBy?: string;
}) {
  return (
    <Field label={label} hint={hint}>
      <Input
        type="number"
        inputMode="decimal"
        min={min}
        max={max}
        step="any"
        disabled={disabled}
        value={value === undefined || Number.isNaN(value) ? '' : value}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        trailing={
          unit ? (
            <span className="pointer-events-none text-sm text-text-tertiary">{unit}</span>
          ) : undefined
        }
        onChange={(e) => onChange(e.target.value === '' ? UNSET : Number(e.target.value))}
      />
    </Field>
  );
}

function PickField({
  label,
  value,
  onChange,
  lookup,
  noun,
  disabled,
  invalid,
}: {
  label: string;
  value: string;
  onChange: (id: string) => void;
  lookup: Lookup;
  noun: string;
  disabled?: boolean;
  invalid?: boolean;
}) {
  const known = lookup.options.some((o) => o.id === value);
  const hint =
    lookup.state === 'denied'
      ? `You can't list ${noun}s with your current permissions. The existing choice is kept.`
      : lookup.state === 'error'
        ? `The list of ${noun}s could not be loaded. The existing choice is kept.`
        : lookup.state === 'loading'
          ? 'Loading…'
          : undefined;
  return (
    <Field label={label} hint={hint}>
      <Select
        value={value}
        disabled={disabled || lookup.state === 'loading'}
        aria-invalid={invalid || undefined}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">{`Choose a ${noun}`}</option>
        {value && !known && <option value={value}>{`Selected ${noun} (not in the list)`}</option>}
        {lookup.options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </Select>
    </Field>
  );
}

function OptionalToggle({
  label,
  checked,
  onChange,
  disabled,
  children,
}: {
  label: string;
  checked: boolean;
  onChange: (on: boolean) => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <div className="grid gap-2">
      <div className="flex items-center gap-2">
        <Checkbox
          id={id}
          checked={checked}
          disabled={disabled}
          onCheckedChange={(v) => onChange(v === true)}
        />
        <label htmlFor={id} className="text-sm font-medium">
          {label}
        </label>
      </div>
      {checked && children}
    </div>
  );
}

function ScenarioFilter({
  value,
  onChange,
  disabled,
}: {
  value: string[] | undefined;
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}) {
  const { scenarios } = useLookupContext();
  const selected = value ?? [];
  return (
    <Field
      label="Only these scenarios"
      hint={
        scenarios.state === 'denied'
          ? "You can't list AI scenarios with your current permissions."
          : 'Leave empty to count every scenario.'
      }
    >
      <MultiSelect
        options={scenarios.options.map((o) => ({ value: o.id, label: o.label }))}
        value={selected}
        onChange={onChange}
        placeholder="Search scenarios"
        loading={scenarios.state === 'loading'}
        emptyText={disabled ? '' : 'No scenarios'}
      />
    </Field>
  );
}

// ------------------------------------------------------------------ leaf editors

function LeafFields({
  rule,
  onChange,
  disabled,
  invalid,
}: {
  rule: LeafRule;
  onChange: (rule: Rule) => void;
  disabled?: boolean;
  invalid: boolean;
}) {
  const lookups = useLookupContext();
  const set = (patch: Record<string, unknown>) => onChange({ ...rule, ...patch } as Rule);
  const grid = 'grid gap-3 sm:grid-cols-2';

  switch (rule.type) {
    case 'program_completed':
      return (
        <div className={grid}>
          <PickField
            label="Program"
            noun="program"
            lookup={lookups.programs}
            value={rule.programId}
            onChange={(programId) => set({ programId })}
            disabled={disabled}
            invalid={invalid && !rule.programId}
          />
          <NumberField
            label="Minimum completion"
            unit="%"
            min={0}
            max={100}
            value={rule.minPercent}
            onChange={(minPercent) => set({ minPercent })}
            disabled={disabled}
            invalid={invalid}
          />
        </div>
      );
    case 'phase_completed':
      return (
        <PickField
          label="Phase"
          noun="phase"
          lookup={lookups.phases}
          value={rule.phaseId}
          onChange={(phaseId) => set({ phaseId })}
          disabled={disabled}
          invalid={invalid}
        />
      );
    case 'lesson_completed':
      return (
        <PickField
          label="Lesson"
          noun="lesson"
          lookup={lookups.lessons}
          value={rule.lessonId}
          onChange={(lessonId) => set({ lessonId })}
          disabled={disabled}
          invalid={invalid}
        />
      );
    case 'assessment_score':
      return (
        <div className={grid}>
          <PickField
            label="Assessment"
            noun="assessment"
            lookup={lookups.assessments}
            value={rule.assessmentId}
            onChange={(assessmentId) => set({ assessmentId })}
            disabled={disabled}
            invalid={invalid && !rule.assessmentId}
          />
          <NumberField
            label="Passing score"
            unit="%"
            min={0}
            max={100}
            value={rule.minPercent}
            onChange={(minPercent) => set({ minPercent })}
            disabled={disabled}
            invalid={invalid}
          />
        </div>
      );
    case 'program_assessments_score':
      return (
        <div className="grid gap-3">
          <div className={grid}>
            <PickField
              label="Program"
              noun="program"
              lookup={lookups.programs}
              value={rule.programId}
              onChange={(programId) => set({ programId })}
              disabled={disabled}
              invalid={invalid && !rule.programId}
            />
            <NumberField
              label="Passing score on each"
              unit="%"
              min={0}
              max={100}
              value={rule.minPercent}
              onChange={(minPercent) => set({ minPercent })}
              disabled={disabled}
              invalid={invalid}
            />
          </div>
          <fieldset className="grid gap-1.5">
            <legend className="text-sm font-medium">Kinds of assessment</legend>
            <div className="flex flex-wrap gap-x-5 gap-y-1.5">
              {ASSESSMENT_KINDS.map((k) => {
                const on = rule.kinds.includes(k.value);
                return (
                  <label key={k.value} className="flex items-center gap-2 text-base">
                    <Checkbox
                      checked={on}
                      disabled={disabled}
                      onCheckedChange={(v) =>
                        set({
                          kinds:
                            v === true
                              ? [...rule.kinds, k.value]
                              : rule.kinds.filter((x) => x !== k.value),
                        })
                      }
                    />
                    {k.label}
                  </label>
                );
              })}
            </div>
          </fieldset>
        </div>
      );
    case 'ai_scenario_score':
      return (
        <div className={grid}>
          <PickField
            label="Scenario"
            noun="scenario"
            lookup={lookups.scenarios}
            value={rule.scenarioId}
            onChange={(scenarioId) => set({ scenarioId })}
            disabled={disabled}
            invalid={invalid && !rule.scenarioId}
          />
          <NumberField
            label="Minimum score"
            min={0}
            max={100}
            value={rule.minScore}
            onChange={(minScore) => set({ minScore })}
            disabled={disabled}
            invalid={invalid}
          />
        </div>
      );
    case 'ai_sessions_count':
      return (
        <div className="grid gap-3">
          <div className={grid}>
            <NumberField
              label="Sessions required"
              min={1}
              max={1000}
              value={rule.minCount}
              onChange={(minCount) => set({ minCount })}
              disabled={disabled}
              invalid={invalid}
            />
          </div>
          <OptionalToggle
            label="Only count sessions above a score"
            checked={rule.minScore !== undefined}
            disabled={disabled}
            onChange={(on) => set({ minScore: on ? UNSET : undefined })}
          >
            <div className={grid}>
              <NumberField
                label="Minimum session score"
                min={0}
                max={100}
                value={rule.minScore}
                onChange={(minScore) => set({ minScore })}
                disabled={disabled}
                invalid={invalid}
              />
            </div>
          </OptionalToggle>
          <OptionalToggle
            label="Only count some scenarios"
            checked={rule.scenarioIds !== undefined}
            disabled={disabled}
            onChange={(on) => set({ scenarioIds: on ? [] : undefined })}
          >
            <ScenarioFilter
              value={rule.scenarioIds}
              onChange={(scenarioIds) => set({ scenarioIds })}
              disabled={disabled}
            />
          </OptionalToggle>
        </div>
      );
    case 'ai_average_score':
      return (
        <div className="grid gap-3">
          <div className={grid}>
            <NumberField
              label="Minimum average"
              min={0}
              max={100}
              value={rule.minScore}
              onChange={(minScore) => set({ minScore })}
              disabled={disabled}
              invalid={invalid}
            />
          </div>
          <OptionalToggle
            label="Average only the most recent sessions"
            checked={rule.lastN !== undefined}
            disabled={disabled}
            onChange={(on) => set({ lastN: on ? UNSET : undefined })}
          >
            <div className={grid}>
              <NumberField
                label="Number of recent sessions"
                min={1}
                max={1000}
                value={rule.lastN}
                onChange={(lastN) => set({ lastN })}
                disabled={disabled}
                invalid={invalid}
              />
            </div>
          </OptionalToggle>
          <OptionalToggle
            label="Only count some scenarios"
            checked={rule.scenarioIds !== undefined}
            disabled={disabled}
            onChange={(on) => set({ scenarioIds: on ? [] : undefined })}
          >
            <ScenarioFilter
              value={rule.scenarioIds}
              onChange={(scenarioIds) => set({ scenarioIds })}
              disabled={disabled}
            />
          </OptionalToggle>
        </div>
      );
    case 'certification_held':
      return (
        <PickField
          label="Certification"
          noun="certification"
          lookup={lookups.certifications}
          value={rule.certificationId}
          onChange={(certificationId) => set({ certificationId })}
          disabled={disabled}
          invalid={invalid}
        />
      );
    case 'days_since_enrollment':
      return (
        <div className={grid}>
          <NumberField
            label="Days"
            min={0}
            max={3650}
            value={rule.days}
            onChange={(days) => set({ days })}
            disabled={disabled}
            invalid={invalid}
            hint="Counted from the day the person enrolled."
          />
        </div>
      );
    case 'date_reached':
      return (
        <div className={grid}>
          <Field label="Not before" hint="Midnight UTC on this date.">
            <Input
              type="date"
              disabled={disabled}
              aria-invalid={invalid || undefined}
              value={rule.date ? rule.date.slice(0, 10) : ''}
              onChange={(e) => set({ date: e.target.value ? `${e.target.value}T00:00:00Z` : '' })}
            />
          </Field>
        </div>
      );
    case 'approval':
      return (
        <p className="text-sm text-text-secondary">
          {rule.kind === 'manager'
            ? "The person's manager approves."
            : rule.kind === 'trainer'
              ? "The person's trainer approves."
              : 'An administrator reviews and approves.'}{' '}
          This follows the approval policy above.
        </p>
      );
    case 'module_completed':
      return (
        <p className="text-sm text-text-secondary">Module requirements cannot be edited here.</p>
      );
  }
}

function LeafRow({
  rule,
  path,
  onRule,
  onRemove,
  disabled,
  problem,
}: {
  rule: LeafRule;
  path: RulePath;
  onRule: (path: RulePath, rule: Rule) => void;
  onRemove: (path: RulePath) => void;
  disabled?: boolean;
  problem: string | undefined;
}) {
  const id = useId();
  return (
    <li className="px-4 py-3.5">
      <div className="flex items-start justify-between gap-3">
        <p id={id} className="text-base font-medium">
          {LEAF_LABEL[rule.type]}
        </p>
        {!disabled && (
          <IconButton
            label={`Remove requirement: ${LEAF_LABEL[rule.type]}`}
            size="sm"
            onClick={() => onRemove(path)}
          >
            <Trash2 className="size-4" />
          </IconButton>
        )}
      </div>
      <div className="mt-2" role="group" aria-labelledby={id}>
        <LeafFields
          rule={rule}
          onChange={(next) => onRule(path, next)}
          disabled={disabled}
          invalid={Boolean(problem)}
        />
        {rule.type !== 'approval' && (
          <div className="mt-3 sm:max-w-sm">
            <Field
              label="Custom wording"
              optional
              hint="Replaces the automatic description people see."
            >
              <Input
                disabled={disabled}
                maxLength={200}
                value={rule.label ?? ''}
                onChange={(e) =>
                  onRule(path, { ...rule, label: e.target.value || undefined } as Rule)
                }
              />
            </Field>
          </div>
        )}
      </div>
      {problem && <p className="mt-2 text-sm font-medium text-danger">{problem}</p>}
    </li>
  );
}

// ------------------------------------------------------------------ groups

function AddMenu({ onAdd, label }: { onAdd: (rule: Rule) => void; label: string }) {
  const groups = ['Training', 'Assessments', 'AI practice', 'Other'] as const;
  return (
    <MenuRoot>
      <MenuTrigger asChild>
        <Button
          size="sm"
          leading={<Plus className="size-4" />}
          trailing={<ChevronDown className="size-3.5" />}
        >
          {label}
        </Button>
      </MenuTrigger>
      <MenuContent align="start" className="min-w-[260px]">
        {groups.map((g, i) => (
          <div key={g}>
            {i > 0 && <MenuSeparator />}
            <MenuLabel>{g}</MenuLabel>
            {ADDABLE_LEAVES.filter((l) => l.group === g).map((l) => (
              <MenuItem key={l.type} onSelect={() => onAdd(newLeaf(l.type))}>
                {l.label}
              </MenuItem>
            ))}
          </div>
        ))}
        <MenuSeparator />
        <MenuItem onSelect={() => onAdd(emptyGroup('any'))}>A choice: any one of several</MenuItem>
      </MenuContent>
    </MenuRoot>
  );
}

function GroupEditor({
  rule,
  path,
  depth,
  onRule,
  onRemove,
  onAdd,
  disabled,
  problems,
  showProblems,
}: {
  rule: Extract<Rule, { rules: Rule[] }>;
  path: RulePath;
  depth: number;
  onRule: (path: RulePath, rule: Rule) => void;
  onRemove: (path: RulePath) => void;
  onAdd: (path: RulePath, rule: Rule) => void;
  disabled?: boolean;
  problems: ReturnType<typeof ruleProblems>;
  showProblems: boolean;
}) {
  const isRoot = path.length === 0;
  const own = showProblems ? problems.find((p) => samePath(p.path, path)) : undefined;
  const selectId = useId();
  return (
    <div
      className={cn(
        'rounded-lg border border-border bg-surface',
        !isRoot && 'bg-surface-sunken/50',
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-divider px-4 py-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor={selectId} className="text-sm font-medium text-text-secondary">
            {isRoot ? 'The person must meet' : 'Within this choice, they must meet'}
          </label>
          <Select
            id={selectId}
            className="w-auto min-w-[150px]"
            disabled={disabled}
            value={rule.type}
            onChange={(e) => onRule(path, { ...rule, type: e.target.value as 'all' | 'any' })}
          >
            <option value="all">Every requirement</option>
            <option value="any">Any one requirement</option>
          </Select>
        </div>
        {!isRoot && !disabled && (
          <IconButton label="Remove this choice" size="sm" onClick={() => onRemove(path)}>
            <Trash2 className="size-4" />
          </IconButton>
        )}
      </div>
      {rule.rules.length === 0 ? (
        <p className="px-4 py-5 text-sm text-text-secondary">No requirements yet.</p>
      ) : (
        <ul className="divide-y divide-divider">
          {rule.rules.map((child, i) => {
            const childPath = [...path, i];
            if (isGroup(child)) {
              return (
                <li key={i} className="p-3">
                  <GroupEditor
                    rule={child}
                    path={childPath}
                    depth={depth + 1}
                    onRule={onRule}
                    onRemove={onRemove}
                    onAdd={onAdd}
                    disabled={disabled}
                    problems={problems}
                    showProblems={showProblems}
                  />
                </li>
              );
            }
            return (
              <LeafRow
                key={i}
                rule={child}
                path={childPath}
                onRule={onRule}
                onRemove={onRemove}
                disabled={disabled}
                problem={
                  showProblems
                    ? problems.find((p) => samePath(p.path, childPath))?.message
                    : undefined
                }
              />
            );
          })}
        </ul>
      )}
      {own && <p className="px-4 pb-2 text-sm font-medium text-danger">{own.message}</p>}
      {!disabled && (
        <div className="border-t border-divider px-4 py-2.5">
          <AddMenu
            label={depth === 0 ? 'Add requirement' : 'Add to this choice'}
            onAdd={(node) => onAdd(path, node)}
          />
        </div>
      )}
    </div>
  );
}

/**
 * Editor for an eligibility rule tree. It writes the same `Rule` structure the API validates and
 * evaluates; every threshold is a field the administrator fills in, never a constant.
 */
export function RuleEditor({
  value,
  onChange,
  programIds,
  excludeCertificationId,
  disabled,
  showProblems = false,
  ariaLabel,
}: {
  value: Rule;
  onChange: (rule: Rule) => void;
  /** Programs of the certification: the phases and lessons offered come from these. */
  programIds: readonly string[];
  excludeCertificationId?: string;
  disabled?: boolean;
  showProblems?: boolean;
  ariaLabel: string;
}) {
  const lookups = useLookups(programIds, excludeCertificationId);
  const problems = useMemo(() => ruleProblems(value), [value]);
  if (!isGroup(value)) return null;
  return (
    <Ctx.Provider value={lookups}>
      <div role="group" aria-label={ariaLabel}>
        <GroupEditor
          rule={value}
          path={[]}
          depth={0}
          disabled={disabled}
          problems={problems}
          showProblems={showProblems}
          onRule={(path, rule) => onChange(replaceAt(value, path, rule))}
          onRemove={(path) => onChange(removeAt(value, path))}
          onAdd={(path, rule) => onChange(appendAt(value, path, rule))}
        />
      </div>
    </Ctx.Provider>
  );
}
