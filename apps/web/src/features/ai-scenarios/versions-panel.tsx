import { useMemo, useState } from 'react';
import type { ai } from '@a5/contracts';
import {
  Button,
  DialogRoot,
  EmptyState,
  ErrorState,
  Field,
  Notice,
  Select,
  SheetContent,
  Skeleton,
  Tag,
} from '@/components/ui';
import { errorMessage } from '@/lib/api/errors';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/cn';
import {
  usePromptVersion,
  usePromptVersionDiff,
  usePromptVersions,
  type PromptVersionSummary,
} from './api';
import { diffLines, displayValue, fieldLabel, type DiffLine } from './diff';

const CONTEXT = 2;

/** Changed lines with a little context; long unchanged runs collapse into a count. */
function collapse(lines: DiffLine[]): Array<DiffLine | { kind: 'gap'; count: number }> {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((l, i) => {
    if (l.kind === 'same') return;
    for (let k = Math.max(0, i - CONTEXT); k <= Math.min(lines.length - 1, i + CONTEXT); k++)
      keep[k] = true;
  });
  const out: Array<DiffLine | { kind: 'gap'; count: number }> = [];
  let gap = 0;
  lines.forEach((l, i) => {
    if (keep[i]) {
      if (gap) out.push({ kind: 'gap', count: gap });
      gap = 0;
      out.push(l);
    } else gap++;
  });
  if (gap) out.push({ kind: 'gap', count: gap });
  return out;
}

function DiffBlock({ before, after }: { before: string; after: string }) {
  const rows = useMemo(() => collapse(diffLines(before, after)), [before, after]);
  return (
    <div className="overflow-x-auto rounded border border-border bg-surface font-mono text-xs leading-5">
      {rows.map((r, i) =>
        r.kind === 'gap' ? (
          <p key={i} className="bg-surface-sunken px-3 py-0.5 text-text-secondary">
            {r.count} unchanged {r.count === 1 ? 'line' : 'lines'}
          </p>
        ) : (
          <p
            key={i}
            className={cn(
              'flex min-w-max gap-2 px-3 py-px whitespace-pre-wrap',
              r.kind === 'added' && 'bg-success-soft',
              r.kind === 'removed' && 'bg-danger-soft',
            )}
          >
            <span aria-hidden className="w-3 shrink-0 text-text-secondary select-none">
              {r.kind === 'added' ? '+' : r.kind === 'removed' ? '−' : ' '}
            </span>
            {r.kind !== 'same' && (
              <span className="sr-only">{r.kind === 'added' ? 'Added: ' : 'Removed: '}</span>
            )}
            <span className="min-w-0 break-words">{r.text || ' '}</span>
          </p>
        ),
      )}
    </div>
  );
}

function VersionDiff({ scenarioId, from, to }: { scenarioId: string; from: string; to: string }) {
  const diff = usePromptVersionDiff(scenarioId, from, to);
  if (diff.isPending) return <Skeleton className="h-40 w-full" />;
  if (diff.isError)
    return <ErrorState message={errorMessage(diff.error)} onRetry={() => diff.refetch()} />;
  const changes = diff.data.changes;
  if (changes.length === 0)
    return (
      <Notice tone="information">
        These versions have the same prompts, persona, scenario and model settings.
      </Notice>
    );
  return (
    <div className="grid gap-5" aria-live="polite">
      <p className="text-sm text-text-secondary">
        Version {diff.data.from.version} to version {diff.data.to.version}: {changes.length}{' '}
        {changes.length === 1 ? 'field' : 'fields'} changed.
      </p>
      {changes.map((c) => {
        const { group, label } = fieldLabel(c.field);
        return (
          <section key={c.field} aria-label={`${group}: ${label}`}>
            <h4 className="mb-1.5 text-sm font-semibold">
              <span className="font-normal text-text-secondary">{group} · </span>
              {label}
            </h4>
            <DiffBlock before={displayValue(c.before)} after={displayValue(c.after)} />
          </section>
        );
      })}
    </div>
  );
}

function VersionSheet({
  scenarioId,
  versionId,
  onClose,
}: {
  scenarioId: string;
  versionId: string;
  onClose: () => void;
}) {
  const version = usePromptVersion(scenarioId, versionId);
  const v = version.data;
  return (
    <DialogRoot open onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        title={v ? `Version ${v.version}` : 'Prompt version'}
        description={v?.changeNote ?? undefined}
        className="sm:w-[min(720px,92vw)]"
      >
        {version.isPending ? (
          <Skeleton className="h-64 w-full" />
        ) : version.isError || !v ? (
          <ErrorState message={errorMessage(version.error)} onRetry={() => version.refetch()} />
        ) : (
          <div className="grid gap-6">
            <p className="text-sm text-text-secondary">
              Saved {formatDateTime(v.createdAt)}
              {v.createdBy ? ` by ${v.createdBy.displayName}` : ''}. Used by{' '}
              {v.sessionCount.toLocaleString()}{' '}
              {v.sessionCount === 1 ? 'conversation' : 'conversations'}. Versions never change after
              they are saved.
            </p>
            <section>
              <h3 className="mb-1.5 text-sm font-semibold">Homeowner prompt</h3>
              <pre className="max-h-96 overflow-auto rounded border border-border bg-surface-sunken p-3 font-mono text-xs leading-5 whitespace-pre-wrap">
                {v.homeownerSystemPrompt}
              </pre>
            </section>
            <section>
              <h3 className="mb-1.5 text-sm font-semibold">Scoring prompt</h3>
              <pre className="max-h-96 overflow-auto rounded border border-border bg-surface-sunken p-3 font-mono text-xs leading-5 whitespace-pre-wrap">
                {v.evaluatorSystemPrompt}
              </pre>
            </section>
            <section>
              <h3 className="mb-1.5 text-sm font-semibold">Model</h3>
              <p className="text-sm text-text-secondary">
                {v.provider ?? 'Organization default provider'}
                {v.model ? `, ${v.model}` : ''}
                {v.evaluationModel ? `. Scoring: ${v.evaluationModel}` : ''}
              </p>
              {Object.keys(v.modelSettings).length > 0 && (
                <pre className="mt-2 overflow-auto rounded border border-border bg-surface-sunken p-3 font-mono text-xs">
                  {JSON.stringify(v.modelSettings, null, 2)}
                </pre>
              )}
            </section>
          </div>
        )}
      </SheetContent>
    </DialogRoot>
  );
}

function VersionRow({ v, onView }: { v: PromptVersionSummary; onView: () => void }) {
  return (
    <li className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2 px-4 py-3.5">
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-2 font-medium">
          Version {v.version}
          {v.current && <Tag tone="success">Current</Tag>}
        </p>
        <p className="mt-0.5 max-w-[70ch] text-sm">
          {v.changeNote ?? <span className="text-text-secondary">No note</span>}
        </p>
        <p className="mt-1 text-xs text-text-secondary">
          {formatDateTime(v.createdAt)}
          {v.createdBy ? ` · ${v.createdBy.displayName}` : ''}
          {' · '}
          {v.sessionCount.toLocaleString()} {v.sessionCount === 1 ? 'session' : 'sessions'}
          {v.model ? ` · ${v.model}` : ''}
        </p>
      </div>
      <Button size="sm" onClick={onView}>
        View <span className="sr-only">version {v.version}</span>
      </Button>
    </li>
  );
}

export function VersionsPanel({ scenario }: { scenario: ai.ScenarioDetail }) {
  const versions = usePromptVersions(scenario.id);
  const [viewing, setViewing] = useState<string | null>(null);
  const [pick, setPick] = useState<{ from: string; to: string } | null>(null);
  const items = versions.data?.items ?? [];
  const compare = pick ?? (items.length >= 2 ? { from: items[1]!.id, to: items[0]!.id } : null);

  if (versions.isPending) return <Skeleton className="h-48 w-full" />;
  if (versions.isError)
    return <ErrorState message={errorMessage(versions.error)} onRetry={() => versions.refetch()} />;
  if (items.length === 0)
    return (
      <EmptyState
        title="No versions yet"
        description="A version is saved with the scenario and again whenever its prompt, persona, rubric or model changes."
      />
    );

  return (
    <div className="grid gap-8">
      <p className="max-w-[70ch] text-sm text-text-secondary">
        Every change that affects the conversation or its scoring saves a new, unchangeable version.{' '}
        {scenario.status === 'published'
          ? 'New conversations use the current version; '
          : 'Once published, new conversations use the current version; '}
        conversations already started keep theirs.
      </p>

      <section aria-labelledby="versions-heading">
        <h3 id="versions-heading" className="mb-2 text-md font-semibold">
          History
        </h3>
        <ul className="divide-y divide-divider overflow-hidden rounded-lg border border-border bg-surface">
          {items.map((v) => (
            <VersionRow key={v.id} v={v} onView={() => setViewing(v.id)} />
          ))}
        </ul>
      </section>

      {compare && (
        <section aria-labelledby="compare-heading">
          <h3 id="compare-heading" className="mb-2 text-md font-semibold">
            Compare versions
          </h3>
          <div className="mb-4 grid gap-3 sm:grid-cols-2">
            <Field label="From">
              <Select
                value={compare.from}
                onChange={(e) => setPick({ ...compare, from: e.target.value })}
              >
                {items.map((v) => (
                  <option key={v.id} value={v.id}>
                    Version {v.version}
                    {v.current ? ' (current)' : ''}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="To">
              <Select
                value={compare.to}
                onChange={(e) => setPick({ ...compare, to: e.target.value })}
              >
                {items.map((v) => (
                  <option key={v.id} value={v.id}>
                    Version {v.version}
                    {v.current ? ' (current)' : ''}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          {compare.from === compare.to ? (
            <p className="text-sm text-text-secondary">Choose two different versions to compare.</p>
          ) : (
            <VersionDiff scenarioId={scenario.id} from={compare.from} to={compare.to} />
          )}
        </section>
      )}

      {viewing && (
        <VersionSheet
          scenarioId={scenario.id}
          versionId={viewing}
          onClose={() => setViewing(null)}
        />
      )}
    </div>
  );
}
