import { useState } from 'react';
import { Link } from 'react-router';
import { Plus, X } from 'lucide-react';
import { learning } from '@a5/contracts';
import {
  Button,
  EmptyState,
  ErrorState,
  Field,
  IconButton,
  MultiSelect,
  Notice,
  Pagination,
  ProgressBar,
  Select,
  Skeleton,
  Switch,
  Table,
  TBody,
  Td,
  Th,
  THead,
  Tr,
  toast,
} from '@/components/ui';
import { useProgramOptions, useRoleOptions } from '@/features/analytics/options';
import { useCan } from '@/features/auth/session';
import { useDepartments, useLocations, useTeams } from '@/features/organization/api';
import { AssignDialog } from '@/features/team/assign-dialog';
import { errorMessage } from '@/lib/api/errors';
import { formatDate } from '@/lib/format';
import {
  useProgramEnrollments,
  useSetAudiences,
  useSetPrerequisites,
  useUpdateProgram,
} from './api';
import { BoundedNumber } from './settings-panel';
import { boundsOf } from './schema-bounds';

const settingsBounds = boundsOf(learning.programSettingsPatchSchema);

const KIND_LABEL: Record<learning.AudienceKind, string> = {
  role: 'Role',
  team: 'Team',
  department: 'Department',
  location: 'Location',
};

/** Options for an audience of each kind, from the same directories the rest of the app uses. */
function useAudienceOptions() {
  const roles = useRoleOptions();
  const teams = useTeams();
  const departments = useDepartments();
  const locations = useLocations();
  const pick = <T,>(
    q: { data?: { items: T[] } },
    value: (t: T) => string,
    label: (t: T) => string,
  ) => q.data?.items.map((t) => ({ value: value(t), label: label(t) })) ?? [];
  return {
    role: pick(
      roles,
      (r) => r.key,
      (r) => r.name,
    ),
    team: pick(
      teams,
      (t) => t.id,
      (t) => t.name,
    ),
    department: pick(
      departments,
      (d) => d.id,
      (d) => d.name,
    ),
    location: pick(
      locations,
      (l) => l.id,
      (l) => l.name,
    ),
  } satisfies Record<learning.AudienceKind, Array<{ value: string; label: string }>>;
}

function Audiences({ program, canEdit }: { program: learning.ProgramDetail; canEdit: boolean }) {
  const save = useSetAudiences(program.id);
  const options = useAudienceOptions();
  const [kind, setKind] = useState<learning.AudienceKind>('team');
  const [ref, setRef] = useState('');
  const [error, setError] = useState<string | null>(null);
  const current = program.audiences;
  const taken = new Set(current.filter((a) => a.kind === kind).map((a) => a.ref));
  const choices = options[kind].filter((o) => !taken.has(o.value));
  // Without permission to list roles there is nothing to choose from for that kind.
  const kinds = learning.AUDIENCE_KINDS.filter((k) => k !== 'role' || options.role.length > 0);

  const apply = async (next: learning.Audience[]) => {
    setError(null);
    try {
      await save.mutateAsync(next);
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  return (
    <section aria-labelledby="audience-heading">
      <h3 id="audience-heading" className="text-md font-semibold">
        Audience
      </h3>
      <p className="mt-0.5 mb-3 text-sm text-text-secondary">
        Who this program is meant for. The audience decides who sees it in the catalog when
        self-enrollment is on, and who is enrolled automatically when that is on.
      </p>
      {current.length === 0 ? (
        <p className="mb-3 text-sm text-text-secondary">
          No audience set. With self-enrollment on, everyone can join; with automatic enrollment on,
          nobody is enrolled.
        </p>
      ) : (
        <ul className="mb-3 flex flex-wrap gap-2">
          {current.map((a) => (
            <li
              key={`${a.kind}:${a.ref}`}
              className="inline-flex items-center gap-1 rounded bg-surface-sunken py-0.5 pr-0.5 pl-2 text-sm"
            >
              <span className="text-text-tertiary">{KIND_LABEL[a.kind]}</span> {a.name}
              {canEdit && (
                <IconButton
                  label={`Remove ${KIND_LABEL[a.kind].toLowerCase()} ${a.name}`}
                  size="sm"
                  className="size-6 w-6"
                  onClick={() =>
                    apply(
                      current
                        .filter((x) => !(x.kind === a.kind && x.ref === a.ref))
                        .map(({ kind: k, ref: r }) => ({ kind: k, ref: r })),
                    )
                  }
                >
                  <X className="size-3.5" />
                </IconButton>
              )}
            </li>
          ))}
        </ul>
      )}
      {canEdit && (
        <div className="grid gap-2 sm:grid-cols-[150px_minmax(0,1fr)_auto] sm:items-end">
          <Field label="Add by">
            <Select
              value={kind}
              onChange={(e) => {
                setKind(e.target.value as learning.AudienceKind);
                setRef('');
              }}
            >
              {kinds.map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={KIND_LABEL[kind]}>
            <Select value={ref} onChange={(e) => setRef(e.target.value)}>
              <option value="">Choose…</option>
              {choices.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
          <Button
            leading={<Plus className="size-3.5" />}
            loading={save.isPending}
            disabled={!ref}
            onClick={async () => {
              await apply([
                ...current.map(({ kind: k, ref: r }) => ({ kind: k, ref: r })),
                { kind, ref },
              ]);
              setRef('');
            }}
          >
            Add
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      )}
    </section>
  );
}

function Prerequisites({
  program,
  canEdit,
}: {
  program: learning.ProgramDetail;
  canEdit: boolean;
}) {
  const save = useSetPrerequisites(program.id);
  const programs = useProgramOptions('active');
  const options = (programs.data?.items ?? [])
    .filter((p) => p.id !== program.id)
    .map((p) => ({ value: p.id, label: p.title }));
  return (
    <section aria-labelledby="prereq-heading">
      <h3 id="prereq-heading" className="text-md font-semibold">
        Prerequisites
      </h3>
      <p className="mt-0.5 mb-3 text-sm text-text-secondary">
        Programs a learner must finish before this one opens.
      </p>
      <MultiSelect
        options={options}
        value={program.prerequisites.map((p) => p.id)}
        selectedLabels={Object.fromEntries(program.prerequisites.map((p) => [p.id, p.title]))}
        placeholder={canEdit ? 'Search programs' : 'None'}
        max={20}
        onChange={async (ids) => {
          if (!canEdit) return;
          try {
            await save.mutateAsync(ids);
          } catch (err) {
            toast.error('Could not save prerequisites', errorMessage(err));
          }
        }}
      />
    </section>
  );
}

function Rules({ program, canEdit }: { program: learning.ProgramDetail; canEdit: boolean }) {
  const update = useUpdateProgram(program.id);
  const [days, setDays] = useState<number | null>(program.settings.defaultDueDays);
  const set = async (settings: learning.ProgramSettingsPatch) => {
    try {
      await update.mutateAsync({ settings });
    } catch (err) {
      toast.error('Could not save', errorMessage(err));
    }
  };
  const s = program.settings;
  return (
    <section aria-labelledby="rules-heading" className="grid gap-4">
      <h3 id="rules-heading" className="text-md font-semibold">
        Enrollment rules
      </h3>
      <label className="flex items-start gap-3">
        <Switch
          className="mt-0.5"
          disabled={!canEdit}
          checked={s.allowSelfEnrollment}
          onCheckedChange={(v) => set({ allowSelfEnrollment: v })}
        />
        <span>
          <span className="block text-sm font-medium">People can enroll themselves</span>
          <span className="block text-xs text-text-tertiary">
            The program appears in the catalog for people in the audience.
          </span>
        </span>
      </label>
      <label className="flex items-start gap-3">
        <Switch
          className="mt-0.5"
          disabled={!canEdit}
          checked={s.autoEnrollAudience}
          onCheckedChange={(v) => set({ autoEnrollAudience: v })}
        />
        <span>
          <span className="block text-sm font-medium">Enroll the audience automatically</span>
          <span className="block text-xs text-text-tertiary">
            People who match the audience are enrolled when they join the team, role or location.
          </span>
        </span>
      </label>
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-full max-w-[260px]">
          <BoundedNumber
            label="Default due date (days after enrollment)"
            value={days}
            onChange={setDays}
            bounds={settingsBounds.defaultDueDays}
            disabled={!canEdit}
            placeholder="No due date"
            hint="Used when someone is enrolled without a due date."
          />
        </div>
        {canEdit && (
          <Button
            loading={update.isPending}
            disabled={days === s.defaultDueDays}
            onClick={() => set({ defaultDueDays: days })}
          >
            Save
          </Button>
        )}
      </div>
    </section>
  );
}

function Assignments({ program }: { program: learning.ProgramDetail }) {
  const canAssign = useCan('programs.assign');
  const canView = useCan('enrollments.view');
  const [page, setPage] = useState(1);
  const [assignOpen, setAssignOpen] = useState(false);
  const list = useProgramEnrollments(program.id, page, canView);
  return (
    <section aria-labelledby="assign-heading">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
        <h3 id="assign-heading" className="text-md font-semibold">
          People enrolled
        </h3>
        {canAssign && program.status === 'published' && (
          <Button leading={<Plus className="size-4" />} onClick={() => setAssignOpen(true)}>
            Assign people
          </Button>
        )}
      </div>
      {program.status !== 'published' && (
        <Notice tone="information" className="mb-3">
          Publish the program before enrolling people.
        </Notice>
      )}
      {!canView ? (
        <p className="text-sm text-text-secondary">You do not have access to enrollment lists.</p>
      ) : list.isPending ? (
        <Skeleton className="h-32 w-full" />
      ) : list.isError ? (
        <ErrorState message={errorMessage(list.error)} onRetry={() => list.refetch()} />
      ) : list.data.items.length === 0 ? (
        <EmptyState title="Nobody is enrolled yet" />
      ) : (
        <>
          <Table caption="People enrolled in this program">
            <THead>
              <tr>
                <Th>Person</Th>
                <Th>Progress</Th>
                <Th className="hidden sm:table-cell">Due</Th>
              </tr>
            </THead>
            <TBody>
              {list.data.items.map((e) => (
                <Tr key={e.id}>
                  <Td>
                    <Link
                      to={`/team?learner=${e.learner.id}`}
                      className="font-medium hover:underline"
                    >
                      {e.learner.displayName}
                    </Link>
                    <span className="block text-xs text-text-tertiary">
                      {e.status === 'completed'
                        ? 'Completed'
                        : e.learner.teams.map((t) => t.name).join(', ')}
                    </span>
                  </Td>
                  <Td className="min-w-[140px]">
                    <ProgressBar
                      value={e.progressPercent}
                      label={`${e.learner.displayName} progress`}
                      tone={e.status === 'completed' ? 'success' : 'accent'}
                      showValue
                    />
                  </Td>
                  <Td className="hidden text-sm text-text-secondary sm:table-cell">
                    {e.dueAt ? formatDate(e.dueAt) : '—'}
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
          <Pagination
            page={list.data.page}
            pageCount={list.data.pageCount}
            total={list.data.total}
            pageSize={list.data.pageSize}
            onPage={setPage}
            noun="people"
          />
        </>
      )}
      {canAssign && (
        <AssignDialog
          open={assignOpen}
          onOpenChange={setAssignOpen}
          initialProgramId={program.id}
        />
      )}
    </section>
  );
}

/** Who may join, who is enrolled automatically, prerequisites, and the current assignments. */
export function EnrollmentPanel({ program }: { program: learning.ProgramDetail }) {
  const canEdit = useCan('programs.update') && program.status !== 'archived';
  return (
    <div className="grid max-w-[760px] gap-9">
      <Rules program={program} canEdit={canEdit} />
      <Audiences program={program} canEdit={canEdit} />
      <Prerequisites program={program} canEdit={canEdit} />
      <Assignments program={program} />
    </div>
  );
}
