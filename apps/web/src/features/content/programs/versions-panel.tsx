import type { learning } from '@a5/contracts';
import {
  EmptyState,
  ErrorState,
  Skeleton,
  Table,
  TBody,
  Td,
  Th,
  THead,
  Tr,
  Tag,
} from '@/components/ui';
import { errorMessage } from '@/lib/api/errors';
import { formatDateTime } from '@/lib/format';
import { useProgramVersions } from './api';

/** Published versions, newest first. Each publish is a permanent snapshot with its change note. */
export function VersionsPanel({ program }: { program: learning.ProgramDetail }) {
  const versions = useProgramVersions(program.id);
  if (versions.isPending) return <Skeleton className="h-40 w-full" />;
  if (versions.isError)
    return <ErrorState message={errorMessage(versions.error)} onRetry={() => versions.refetch()} />;
  const items = [...versions.data.items].sort((a, b) => b.version - a.version);
  if (items.length === 0)
    return (
      <EmptyState
        title="Not published yet"
        description="Publishing records a version here with the note you write, so there is always a history of what learners were shown."
      />
    );
  return (
    <div className="max-w-[900px]">
      <p className="mb-3 text-sm text-text-secondary">
        Learners always see the latest published version. Earlier versions are kept as a record and
        cannot be restored from here.
      </p>
      <Table caption="Published versions">
        <THead>
          <tr>
            <Th>Version</Th>
            <Th>What changed</Th>
            <Th className="hidden md:table-cell">Contents</Th>
            <Th className="hidden sm:table-cell">Published</Th>
          </tr>
        </THead>
        <TBody>
          {items.map((v) => (
            <Tr key={v.version}>
              <Td className="align-top whitespace-nowrap">
                <span className="tabular font-medium">v{v.version}</span>
                {v.version === program.publishedVersion && (
                  <Tag tone="success" className="ml-2">
                    Live
                  </Tag>
                )}
              </Td>
              <Td className="max-w-[420px] align-top text-sm">{v.changeNote}</Td>
              <Td className="hidden align-top text-sm text-text-secondary md:table-cell">
                {v.stats.phases} {program.phaseLabel.toLowerCase()}s · {v.stats.modules} modules ·{' '}
                {v.stats.lessons} lessons ({v.stats.requiredLessons} required) ·{' '}
                {v.stats.estimatedMinutes} min
              </Td>
              <Td className="hidden align-top text-sm text-text-secondary sm:table-cell">
                {formatDateTime(v.publishedAt)}
                {v.publishedBy && <span className="block">{v.publishedBy.displayName}</span>}
              </Td>
            </Tr>
          ))}
        </TBody>
      </Table>
    </div>
  );
}
