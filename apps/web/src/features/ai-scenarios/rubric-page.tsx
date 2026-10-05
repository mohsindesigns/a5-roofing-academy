import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router';
import { ArrowDown, ArrowUp, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react';
import type { ai } from '@a5/contracts';
import {
  Button,
  ConfirmDialog,
  DialogContent,
  DialogRoot,
  EmptyState,
  ErrorState,
  Field,
  IconButton,
  Input,
  MenuContent,
  MenuItem,
  MenuRoot,
  MenuTrigger,
  Notice,
  PageHeader,
  Section,
  Skeleton,
  Table,
  Tag,
  TBody,
  Td,
  Textarea,
  Th,
  THead,
  Tr,
  toast,
} from '@/components/ui';
import { RequirePermission } from '@/app/guards';
import { UnsavedBar } from '@/app/shell/unsaved-bar';
import { useCan } from '@/features/auth/session';
import { ApiError, errorMessage } from '@/lib/api/errors';
import { formatDateTime, pluralize } from '@/lib/format';
import {
  useArchiveRubric,
  usePublishRubricVersion,
  useRubric,
  useRubricVersion,
  useUpdateRubric,
} from './api';
import {
  blankCriterion,
  isChanged,
  slugKey,
  toCriteria,
  validateRubricVersion,
  weightShares,
  type Criterion,
  type CriterionField,
  type RubricIssues,
} from './rubric-model';

function CriterionCard({
  index,
  count,
  c,
  share,
  issues,
  readOnly,
  onChange,
  onMove,
  onRemove,
}: {
  index: number;
  count: number;
  c: Criterion;
  share: number;
  issues: Partial<Record<CriterionField, string>> | undefined;
  readOnly: boolean;
  onChange: (patch: Partial<Criterion>) => void;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
}) {
  const n = index + 1;
  return (
    <li className="rounded-lg border border-border bg-surface">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2 border-b border-divider px-4 py-3">
        <span className="tabular mt-2 w-5 shrink-0 text-sm text-text-secondary">{n}</span>
        <div className="min-w-0 flex-[1_1_14rem]">
          <Field label={`Criterion ${n} name`} hideLabel required error={issues?.label}>
            <Input
              value={c.label}
              disabled={readOnly}
              placeholder="Criterion name"
              className="font-medium"
              autoComplete="off"
              onChange={(e) =>
                onChange({
                  label: e.target.value,
                  ...(!c.keyEdited && !c.existing && { key: slugKey(e.target.value) }),
                })
              }
            />
          </Field>
        </div>
        <div className="ml-8 flex min-h-[var(--a5-control-height)] flex-1 items-center justify-between gap-3 sm:ml-0 sm:flex-none">
          <p className="tabular text-sm whitespace-nowrap text-text-secondary sm:w-28 sm:text-right">
            {share > 0
              ? `${share >= 10 ? Math.round(share) : share.toFixed(1)}% of score`
              : 'No weight'}
          </p>
          {!readOnly && (
            <div className="flex shrink-0 gap-0.5">
              <IconButton
                label={`Move criterion ${n} up`}
                size="sm"
                disabled={index === 0}
                onClick={() => onMove(-1)}
              >
                <ArrowUp className="size-4" />
              </IconButton>
              <IconButton
                label={`Move criterion ${n} down`}
                size="sm"
                disabled={index === count - 1}
                onClick={() => onMove(1)}
              >
                <ArrowDown className="size-4" />
              </IconButton>
              <IconButton
                label={`Remove criterion ${n}`}
                size="sm"
                disabled={count === 1}
                onClick={onRemove}
              >
                <Trash2 className="size-4" />
              </IconButton>
            </div>
          )}
        </div>
      </div>
      <div className="grid gap-4 px-4 py-4 sm:grid-cols-[1fr_160px]">
        <Field
          label="What it measures"
          required
          error={issues?.description}
          className="sm:col-span-2"
        >
          <Textarea
            rows={2}
            value={c.description}
            disabled={readOnly}
            onChange={(e) => onChange({ description: e.target.value })}
          />
        </Field>
        <Field
          label="Scoring guidance"
          optional
          error={issues?.guidance}
          hint="How the evaluator tells strong from weak. Name what lifts or caps the score."
        >
          <Textarea
            rows={4}
            value={c.guidance}
            disabled={readOnly}
            onChange={(e) => onChange({ guidance: e.target.value })}
          />
        </Field>
        <div className="grid content-start gap-4">
          <Field label="Weight" required error={issues?.weight} hint="Relative, 0 to 100.">
            <Input
              type="number"
              inputMode="decimal"
              min={0}
              max={100}
              step="0.5"
              value={c.weight}
              disabled={readOnly}
              onChange={(e) => onChange({ weight: e.target.value })}
            />
          </Field>
          <Field
            label="Key"
            required
            error={issues?.key}
            hint={c.existing ? 'Fixed: past scorecards use it.' : 'Lowercase, digits, underscores.'}
          >
            <Input
              className="font-mono text-sm"
              value={c.key}
              disabled={readOnly || c.existing}
              autoComplete="off"
              onChange={(e) => onChange({ key: e.target.value, keyEdited: true })}
            />
          </Field>
        </div>
      </div>
    </li>
  );
}

function RenameDialog({ rubric, onClose }: { rubric: ai.RubricDetail; onClose: () => void }) {
  const update = useUpdateRubric(rubric.id);
  const [title, setTitle] = useState(rubric.title);
  const [description, setDescription] = useState(rubric.description ?? '');
  const [error, setError] = useState<string | undefined>();
  return (
    <DialogRoot open onOpenChange={(open) => !open && !update.isPending && onClose()}>
      <DialogContent
        title="Rename rubric"
        dismissible={!update.isPending}
        footer={
          <>
            <Button onClick={onClose} disabled={update.isPending}>
              Cancel
            </Button>
            <Button type="submit" form="rename-rubric" variant="primary" loading={update.isPending}>
              Save
            </Button>
          </>
        }
      >
        <form
          id="rename-rubric"
          className="grid gap-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            setError(undefined);
            if (!title.trim()) return setError('Required');
            update.mutate(
              { title: title.trim(), description: description.trim() || null },
              {
                onSuccess: () => {
                  toast.success('Rubric updated');
                  onClose();
                },
                onError: (err) =>
                  setError(
                    err instanceof ApiError
                      ? (err.fields.find((f) => f.path === 'title')?.message ?? err.message)
                      : errorMessage(err),
                  ),
              },
            );
          }}
        >
          <Field label="Title" required error={error}>
            <Input value={title} autoComplete="off" onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <Field label="Description" optional>
            <Textarea
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
        </form>
      </DialogContent>
    </DialogRoot>
  );
}

function RubricEditor({ rubric }: { rubric: ai.RubricDetail }) {
  const canUpdate = useCan('ai_scenarios.update');
  const readOnly = !canUpdate || rubric.archived;
  const current = rubric.currentVersion;
  const publish = usePublishRubricVersion(rubric.id);
  const archive = useArchiveRubric(rubric.id);
  const [criteria, setCriteria] = useState<Criterion[]>(() =>
    toCriteria(current.categories, { existing: true }),
  );
  const [passingScore, setPassingScore] = useState(String(current.passingScore));
  const [changeNote, setChangeNote] = useState('');
  const [issues, setIssues] = useState<RubricIssues | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [loadVersion, setLoadVersion] = useState<string | null>(null);
  const loaded = useRubricVersion(rubric.id, loadVersion);

  // A newly published version (or a refetch) resets the editor to the saved criteria.
  useEffect(() => {
    setCriteria(toCriteria(current.categories, { existing: true }));
    setPassingScore(String(current.passingScore));
    setChangeNote('');
    setIssues(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current.id]);

  // Loading an older version puts its criteria in the editor as the basis of a new version.
  useEffect(() => {
    if (!loaded.data || loaded.data.id !== loadVersion) return;
    const keep = new Set(current.categories.map((c) => c.key));
    setCriteria(
      toCriteria(loaded.data.categories, { existing: false }).map((c) => ({
        ...c,
        existing: keep.has(c.key),
      })),
    );
    setPassingScore(String(loaded.data.passingScore));
    setChangeNote(`Based on version ${loaded.data.version}`);
    setLoadVersion(null);
    toast.info(`Version ${loaded.data.version} loaded`, 'Publish to make it the current version.');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded.data]);

  const shares = useMemo(() => weightShares(criteria), [criteria]);
  const total = criteria.reduce((sum, c) => sum + (Number(c.weight) || 0), 0);
  const dirty = isChanged(criteria, passingScore, current);
  const patch = (uid: string, change: Partial<Criterion>) =>
    setCriteria((list) => list.map((c) => (c.uid === uid ? { ...c, ...change } : c)));
  const move = (i: number, delta: -1 | 1) =>
    setCriteria((list) => {
      const next = [...list];
      const [item] = next.splice(i, 1);
      next.splice(i + delta, 0, item!);
      return next;
    });

  const submit = () => {
    setServerError(null);
    const result = validateRubricVersion(criteria, passingScore, changeNote);
    if (!result.ok) {
      setIssues(result.issues);
      return;
    }
    setIssues(null);
    publish.mutate(result.request, {
      onSuccess: (next) => {
        const live = rubric.scenarioCount;
        toast.success(
          `Version ${next.currentVersion.version} published`,
          live > 0
            ? `${pluralize(live, 'scenario')} using this rubric got a new prompt version.`
            : undefined,
        );
      },
      onError: (err) => {
        if (err instanceof ApiError && err.fields.length > 0) {
          setServerError(err.fields.map((f) => f.message).join(' '));
        } else setServerError(errorMessage(err));
      },
    });
  };

  return (
    <div className={dirty && !readOnly ? 'pb-24' : ''}>
      <PageHeader
        breadcrumbs={[
          { label: 'AI scenarios', to: '/content/ai-scenarios?tab=rubrics' },
          { label: rubric.title },
        ]}
        title={rubric.title}
        description={rubric.description ?? undefined}
        meta={
          <>
            <span className="tabular">Version {current.version}</span>
            <span className="tabular">
              {pluralize(current.categoryCount, 'criterion', 'criteria')}
            </span>
            <span className="tabular">{pluralize(rubric.scenarioCount, 'scenario')} use it</span>
            {rubric.archived && <Tag tone="danger">Archived</Tag>}
          </>
        }
        actions={
          canUpdate &&
          !rubric.archived && (
            <>
              <Button leading={<Pencil className="size-4" />} onClick={() => setRenaming(true)}>
                Rename
              </Button>
              <MenuRoot>
                <MenuTrigger asChild>
                  <IconButton label="More actions" variant="secondary">
                    <MoreHorizontal className="size-4" />
                  </IconButton>
                </MenuTrigger>
                <MenuContent>
                  <MenuItem tone="danger" onSelect={() => setArchiving(true)}>
                    Archive rubric
                  </MenuItem>
                </MenuContent>
              </MenuRoot>
            </>
          )
        }
      />

      {!readOnly && (
        <Notice tone="information" className="mb-6" title="Versions are permanent">
          Publishing saves a new version and creates a new prompt version for the{' '}
          {pluralize(rubric.scenarioCount, 'live scenario')} using this rubric. Past scorecards keep
          the version they were scored with.
        </Notice>
      )}

      <Section
        title="Criteria"
        description={`Weights are relative: each criterion counts for its share of the total (${total.toLocaleString()} across ${pluralize(criteria.length, 'criterion', 'criteria')}).`}
        id="criteria-heading"
      >
        {issues && issues.general.length > 0 && (
          <p role="alert" className="mb-3 rounded bg-danger-soft px-3 py-2 text-sm text-danger">
            {issues.general.join(' ')}
          </p>
        )}
        <ol className="grid gap-3">
          {criteria.map((c, i) => (
            <CriterionCard
              key={c.uid}
              index={i}
              count={criteria.length}
              c={c}
              share={shares[i] ?? 0}
              issues={issues?.criteria[c.uid]}
              readOnly={readOnly}
              onChange={(change) => patch(c.uid, change)}
              onMove={(d) => move(i, d)}
              onRemove={() => setCriteria((list) => list.filter((x) => x.uid !== c.uid))}
            />
          ))}
        </ol>
        {!readOnly && (
          <Button
            className="mt-3"
            leading={<Plus className="size-4" />}
            disabled={criteria.length >= 30}
            onClick={() => setCriteria((list) => [...list, blankCriterion()])}
          >
            Add criterion
          </Button>
        )}
      </Section>

      <Section title="Version details" id="version-details">
        <div className="grid max-w-[720px] gap-4 sm:grid-cols-[180px_1fr]">
          <Field
            label="Default pass mark"
            error={issues?.passingScore}
            hint="Suggested for scenarios using this rubric. Each scenario sets its own."
          >
            <Input
              type="number"
              inputMode="numeric"
              min={0}
              max={100}
              value={passingScore}
              disabled={readOnly}
              onChange={(e) => setPassingScore(e.target.value)}
            />
          </Field>
          {!readOnly && (
            <Field label="Note for this version" optional hint="Shown in the version history.">
              <Input
                maxLength={300}
                value={changeNote}
                onChange={(e) => setChangeNote(e.target.value)}
              />
            </Field>
          )}
        </div>
      </Section>

      <Section title="Version history" id="rubric-history">
        {rubric.versions.length === 0 ? (
          <EmptyState title="No versions" />
        ) : (
          <Table caption="Rubric versions">
            <THead>
              <tr>
                <Th>Version</Th>
                <Th>Note</Th>
                <Th className="text-right">Criteria</Th>
                <Th className="text-right">Pass mark</Th>
                <Th>Saved</Th>
                {!readOnly && (
                  <Th>
                    <span className="sr-only">Actions</span>
                  </Th>
                )}
              </tr>
            </THead>
            <TBody>
              {rubric.versions.map((v) => (
                <Tr key={v.id}>
                  <Td className="whitespace-nowrap">
                    <span className="tabular font-medium">v{v.version}</span>
                    {v.id === current.id && (
                      <span className="ml-2">
                        <Tag tone="success">Current</Tag>
                      </span>
                    )}
                  </Td>
                  <Td className="max-w-80 text-text-secondary">{v.changeNote ?? '—'}</Td>
                  <Td className="tabular text-right">{v.categoryCount}</Td>
                  <Td className="tabular text-right">{v.passingScore}</Td>
                  <Td className="whitespace-nowrap text-text-secondary">
                    {formatDateTime(v.createdAt)}
                    {v.createdBy ? ` · ${v.createdBy.displayName}` : ''}
                  </Td>
                  {!readOnly && (
                    <Td className="text-right whitespace-nowrap">
                      {v.id !== current.id && (
                        <Button
                          size="sm"
                          variant="ghost"
                          loading={loadVersion === v.id && loaded.isFetching}
                          onClick={() => setLoadVersion(v.id)}
                        >
                          Use as starting point <span className="sr-only">v{v.version}</span>
                        </Button>
                      )}
                    </Td>
                  )}
                </Tr>
              ))}
            </TBody>
          </Table>
        )}
        {loaded.isError && <ErrorState className="mt-3" message={errorMessage(loaded.error)} />}
      </Section>

      {dirty && !readOnly && (
        <UnsavedBar
          actions={
            <>
              <Button
                disabled={publish.isPending}
                onClick={() => {
                  setCriteria(toCriteria(current.categories, { existing: true }));
                  setPassingScore(String(current.passingScore));
                  setChangeNote('');
                  setIssues(null);
                  setServerError(null);
                }}
              >
                Discard
              </Button>
              <Button variant="primary" loading={publish.isPending} onClick={submit}>
                Publish version {current.version + 1}
              </Button>
            </>
          }
        >
          <span className="font-medium">Unsaved changes.</span>{' '}
          {serverError ? (
            <span role="alert" className="text-danger">
              {serverError}
            </span>
          ) : issues ? (
            <span role="alert" className="text-danger">
              Fix the marked fields to publish.
            </span>
          ) : (
            <span className="text-text-secondary">
              Publishing creates version {current.version + 1}.
            </span>
          )}
        </UnsavedBar>
      )}

      {renaming && <RenameDialog rubric={rubric} onClose={() => setRenaming(false)} />}
      <ConfirmDialog
        open={archiving}
        onOpenChange={setArchiving}
        title="Archive this rubric?"
        description="It will no longer be offered for new scenarios. Scenarios that already use it keep working."
        confirmLabel="Archive rubric"
        tone="danger"
        loading={archive.isPending}
        error={archive.isError ? errorMessage(archive.error) : null}
        onConfirm={() =>
          archive.mutate(undefined, {
            onSuccess: () => {
              toast.success('Rubric archived');
              setArchiving(false);
            },
          })
        }
      />
    </div>
  );
}

function RubricLoader({ id }: { id: string }) {
  const rubric = useRubric(id);
  if (rubric.isPending) return <Skeleton className="h-96 w-full" />;
  if (rubric.isError) {
    const gone = rubric.error instanceof ApiError && rubric.error.isNotFound;
    return gone ? (
      <EmptyState title="This rubric no longer exists" className="mt-10" />
    ) : (
      <ErrorState message={errorMessage(rubric.error)} onRetry={() => rubric.refetch()} />
    );
  }
  return <RubricEditor key={rubric.data.id} rubric={rubric.data} />;
}

export function RubricPage() {
  const { id = '' } = useParams();
  return (
    <RequirePermission all={['ai_scenarios.view']}>
      <RubricLoader id={id} />
    </RequirePermission>
  );
}
