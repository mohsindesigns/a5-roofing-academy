import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Plus, Search } from 'lucide-react';
import {
  Button,
  EmptyState,
  ErrorState,
  FilterBar,
  Input,
  PageHeader,
  Pagination,
  Select,
  Table,
  TableSkeleton,
  TBody,
  Tag,
  Td,
  Th,
  THead,
  Tr,
} from '@/components/ui';
import { RequirePermission } from '@/app/guards';
import { usePermissions } from '@/features/auth/session';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { useSearchState } from '@/hooks/use-search-state';
import { errorMessage } from '@/lib/api/errors';
import { formatRelative } from '@/lib/format';
import { useTemplates } from '../api';
import { CreateTemplateDialog } from '../template-dialogs';
import { CENTER_ROOT } from './nav';

const DEFAULTS = { q: '', status: 'active', page: '1' };

function Templates() {
  const navigate = useNavigate();
  const permissions = usePermissions();
  const [creating, setCreating] = useState(false);
  const [state, setState] = useSearchState(DEFAULTS);
  const [search, setSearch] = useState(state.q ?? '');
  const q = useDebouncedValue(search, 300);
  useEffect(() => {
    if (q !== (state.q ?? '')) setState({ q });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);
  const templates = useTemplates({
    q: state.q || undefined,
    status: state.status,
    page: Number(state.page) || 1,
    pageSize: 25,
  });
  const filtered = Boolean(state.q || state.status !== DEFAULTS.status);
  const canCreate = permissions.has('certificate_templates.create');

  return (
    <>
      <PageHeader
        title="Certificate templates"
        description="How certificates look. Each save creates a new version; issued certificates keep the version they were issued with."
        actions={
          canCreate && (
            <Button
              variant="primary"
              leading={<Plus className="size-4" />}
              onClick={() => setCreating(true)}
            >
              New template
            </Button>
          )
        }
      />
      <FilterBar
        activeCount={state.status !== DEFAULTS.status ? 1 : 0}
        search={
          <Input
            type="search"
            aria-label="Search templates"
            placeholder="Search templates"
            leading={<Search className="size-4" />}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        }
      >
        <Select
          aria-label="Status"
          value={state.status}
          onChange={(e) => setState({ status: e.target.value })}
        >
          <option value="active">Active</option>
          <option value="archived">Archived</option>
          <option value="active,archived">All</option>
        </Select>
      </FilterBar>

      {templates.isPending ? (
        <TableSkeleton columns={4} />
      ) : templates.isError ? (
        <ErrorState message={errorMessage(templates.error)} onRetry={() => templates.refetch()} />
      ) : templates.data.items.length === 0 ? (
        <EmptyState
          title={filtered ? 'No templates match' : 'No templates yet'}
          description={
            filtered
              ? 'Try a different search or status.'
              : 'Create a template from a starter design to begin.'
          }
          action={
            !filtered && canCreate ? (
              <Button variant="primary" onClick={() => setCreating(true)}>
                New template
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <Table caption="Certificate templates">
            <THead>
              <tr>
                <Th>Template</Th>
                <Th className="hidden sm:table-cell">Page</Th>
                <Th className="hidden text-right md:table-cell">Version</Th>
                <Th className="hidden lg:table-cell">Used by</Th>
                <Th className="hidden md:table-cell">Updated</Th>
              </tr>
            </THead>
            <TBody>
              {templates.data.items.map((t) => (
                <Tr key={t.id} onClick={() => navigate(`${CENTER_ROOT}/templates/${t.id}`)}>
                  <Td>
                    <Link
                      to={`${CENTER_ROOT}/templates/${t.id}`}
                      className="font-medium hover:underline"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {t.name}
                    </Link>
                    {t.isDefault && (
                      <Tag tone="accent" className="ml-2">
                        Default
                      </Tag>
                    )}
                    {t.status === 'archived' && <Tag className="ml-2">Archived</Tag>}
                    {t.description && (
                      <span className="mt-0.5 line-clamp-1 block max-w-[52ch] text-sm text-text-secondary">
                        {t.description}
                      </span>
                    )}
                  </Td>
                  <Td className="hidden text-text-secondary sm:table-cell">
                    {t.page.size === 'LETTER' ? 'US Letter' : 'A4'}, {t.page.orientation}
                  </Td>
                  <Td className="tabular hidden text-right md:table-cell">{t.currentVersion}</Td>
                  <Td className="hidden text-text-secondary lg:table-cell">
                    {t.usedBy.length > 0 ? (
                      t.usedBy.map((u) => u.name).join(', ')
                    ) : (
                      <span className="text-text-secondary">Not assigned</span>
                    )}
                  </Td>
                  <Td className="hidden text-text-secondary md:table-cell">
                    {formatRelative(t.updatedAt)}
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
          <Pagination
            page={templates.data.page}
            pageCount={templates.data.pageCount}
            total={templates.data.total}
            pageSize={templates.data.pageSize}
            onPage={(page) => setState({ page: String(page) })}
            noun="templates"
          />
        </>
      )}
      {creating && <CreateTemplateDialog open onOpenChange={setCreating} />}
    </>
  );
}

export function TemplatesPage() {
  return (
    <RequirePermission all={['certificate_templates.view']}>
      <Templates />
    </RequirePermission>
  );
}
