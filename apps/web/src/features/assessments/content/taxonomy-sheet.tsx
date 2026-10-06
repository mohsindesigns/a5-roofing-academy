import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import {
  Archive,
  ArrowDown,
  ArrowUp,
  ArchiveRestore,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react';
import type { assessment } from '@a5/contracts';
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
  MenuSeparator,
  MenuTrigger,
  Notice,
  Select,
  SheetContent,
  Skeleton,
  Tag,
  TabsContent,
  TabsList,
  TabsRoot,
  Textarea,
  toast,
} from '@/components/ui';
import { useCan } from '@/features/auth/session';
import { applyServerErrors } from '@/lib/forms';
import { errorMessage } from '@/lib/api/errors';
import {
  useBank,
  useBankArchive,
  useBanks,
  useCreateBank,
  useDeleteBank,
  useDeleteTaxonomy,
  useSaveTaxonomy,
  useUpdateBank,
  type TaxonomyKind,
} from '../api';

type Entry = assessment.QuestionCategory | assessment.Competency;

interface TextValues {
  name: string;
  description: string;
}

/** Name and description dialog shared by banks (title), categories and competencies (name). */
function TextDialog({
  open,
  onOpenChange,
  title,
  nameLabel,
  initial,
  submitLabel,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  nameLabel: string;
  initial: TextValues;
  submitLabel: string;
  onSubmit: (values: { name: string; description: string | null }) => Promise<void>;
}) {
  const [formError, setFormError] = useState<string | null>(null);
  const { register, handleSubmit, setError, formState } = useForm<TextValues>({ values: initial });
  return (
    <DialogRoot
      open={open}
      onOpenChange={(o) => {
        setFormError(null);
        onOpenChange(o);
      }}
    >
      <DialogContent title={title}>
        <form
          className="grid gap-4"
          noValidate
          onSubmit={handleSubmit(async (v) => {
            setFormError(null);
            const name = v.name.trim();
            if (!name) return setError('name', { message: `Give it a ${nameLabel.toLowerCase()}` });
            try {
              await onSubmit({ name, description: v.description.trim() || null });
              onOpenChange(false);
            } catch (err) {
              setFormError(applyServerErrors(err, setError, ['name', 'title', 'description']));
            }
          })}
        >
          <Field label={nameLabel} required error={formState.errors.name?.message}>
            <Input autoFocus maxLength={160} {...register('name')} />
          </Field>
          <Field label="Description" optional error={formState.errors.description?.message}>
            <Textarea rows={3} maxLength={1000} {...register('description')} />
          </Field>
          {formError && (
            <p role="alert" className="rounded bg-danger-soft px-3 py-2 text-sm text-danger">
              {formError}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" variant="primary" loading={formState.isSubmitting}>
              {submitLabel}
            </Button>
          </div>
        </form>
      </DialogContent>
    </DialogRoot>
  );
}

function TaxonomyList({
  bank,
  kind,
  canEdit,
}: {
  bank: assessment.QuestionBankDetail;
  kind: TaxonomyKind;
  canEdit: boolean;
}) {
  const save = useSaveTaxonomy(bank.id, kind);
  const remove = useDeleteTaxonomy(bank.id, kind);
  const [editing, setEditing] = useState<Entry | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Entry | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const noun = kind === 'categories' ? 'category' : 'competency';
  const entries: Entry[] =
    kind === 'categories'
      ? [...bank.categories].sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))
      : [...bank.competencies].sort((a, b) => a.name.localeCompare(b.name));

  const move = async (index: number, delta: -1 | 1) => {
    const a = entries[index];
    const b = entries[index + delta];
    if (!a || !b) return;
    try {
      // Positions are renumbered from the list order so neighbours with equal positions still swap.
      await Promise.all([
        save.mutateAsync({ id: a.id, body: { position: index + delta } }),
        save.mutateAsync({ id: b.id, body: { position: index } }),
      ]);
    } catch (err) {
      toast.error('Could not reorder', errorMessage(err));
    }
  };

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-[48ch] text-sm text-text-secondary">
          {kind === 'categories'
            ? 'Categories group questions by topic. Random draws can pull from one category.'
            : 'Competencies tag the skill a question tests, so results can be read by skill.'}
        </p>
        {canEdit && (
          <Button size="sm" leading={<Plus className="size-4" />} onClick={() => setEditing('new')}>
            Add {noun}
          </Button>
        )}
      </div>
      {entries.length === 0 ? (
        <EmptyState
          title={`No ${kind} yet`}
          description={canEdit ? `Add one to start organising this bank.` : undefined}
        />
      ) : (
        <ul className="divide-y divide-divider overflow-hidden rounded-lg border border-border bg-surface">
          {entries.map((e, i) => (
            <li key={e.id} className="flex items-start gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="font-medium">{e.name}</p>
                {e.description && <p className="text-sm text-text-secondary">{e.description}</p>}
                <p className="tabular text-xs text-text-tertiary">
                  {e.questionCount} {e.questionCount === 1 ? 'question' : 'questions'}
                </p>
              </div>
              {canEdit && (
                <div className="flex shrink-0 items-center gap-0.5">
                  {kind === 'categories' && (
                    <>
                      <IconButton
                        label={`Move ${e.name} up`}
                        size="sm"
                        disabled={i === 0 || save.isPending}
                        onClick={() => void move(i, -1)}
                      >
                        <ArrowUp className="size-4" />
                      </IconButton>
                      <IconButton
                        label={`Move ${e.name} down`}
                        size="sm"
                        disabled={i === entries.length - 1 || save.isPending}
                        onClick={() => void move(i, 1)}
                      >
                        <ArrowDown className="size-4" />
                      </IconButton>
                    </>
                  )}
                  <IconButton label={`Edit ${e.name}`} size="sm" onClick={() => setEditing(e)}>
                    <Pencil className="size-4" />
                  </IconButton>
                  <IconButton
                    label={`Delete ${e.name}`}
                    size="sm"
                    onClick={() => {
                      setDeleteError(null);
                      setDeleting(e);
                    }}
                  >
                    <Trash2 className="size-4" />
                  </IconButton>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <TextDialog
        open={editing !== null}
        onOpenChange={(o) => !o && setEditing(null)}
        title={editing === 'new' || editing === null ? `New ${noun}` : `Edit ${editing.name}`}
        nameLabel="Name"
        submitLabel={editing === 'new' || editing === null ? `Add ${noun}` : 'Save'}
        initial={{
          name: editing && editing !== 'new' ? editing.name : '',
          description: editing && editing !== 'new' ? (editing.description ?? '') : '',
        }}
        onSubmit={async (v) => {
          const target = editing && editing !== 'new' ? editing : null;
          await save.mutateAsync({ id: target?.id, body: v });
          toast.success(target ? 'Saved' : `${noun[0]!.toUpperCase()}${noun.slice(1)} added`);
        }}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete ${deleting?.name ?? noun}?`}
        description={`A ${noun} that questions, earlier question versions or random draws still use cannot be deleted. Rename it instead, or move those questions first.`}
        confirmLabel="Delete"
        tone="danger"
        loading={remove.isPending}
        error={deleteError}
        onConfirm={() => {
          if (!deleting) return;
          remove.mutate(deleting.id, {
            onSuccess: () => {
              toast.success('Deleted');
              setDeleting(null);
            },
            onError: (err) => setDeleteError(errorMessage(err)),
          });
        }}
      />
    </div>
  );
}

export function TaxonomySheet({
  open,
  onOpenChange,
  initialBankId,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  initialBankId?: string;
}) {
  const canCreate = useCan('assessments.create');
  const canEdit = useCan('assessments.update');
  const banks = useBanks(true, open);
  const [bankId, setBankId] = useState(initialBankId ?? '');
  const [tab, setTab] = useState<TaxonomyKind>('categories');
  const [bankDialog, setBankDialog] = useState<'new' | 'edit' | null>(null);
  const [bankAction, setBankAction] = useState<'archive' | 'delete' | null>(null);
  const [bankError, setBankError] = useState<string | null>(null);

  // Follow the first bank when nothing is chosen yet or the chosen one disappears.
  const first = banks.data?.items.find((b) => !b.archived)?.id ?? banks.data?.items[0]?.id ?? '';
  useEffect(() => {
    if (!banks.data) return;
    if (!bankId || !banks.data.items.some((b) => b.id === bankId))
      setBankId(
        initialBankId && banks.data.items.some((b) => b.id === initialBankId)
          ? initialBankId
          : first,
      );
  }, [banks.data, bankId, first, initialBankId]);

  const bank = useBank(bankId || undefined);
  const create = useCreateBank();
  const update = useUpdateBank(bankId);
  const archive = useBankArchive(bankId);
  const remove = useDeleteBank(bankId);
  const selected = banks.data?.items.find((b) => b.id === bankId);

  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <SheetContent
        title="Banks and categories"
        description="Questions belong to a bank. Categories and competencies belong to a bank too."
      >
        {banks.isPending ? (
          <Skeleton className="h-32 w-full" />
        ) : banks.isError ? (
          <ErrorState message={errorMessage(banks.error)} onRetry={() => banks.refetch()} />
        ) : (
          <div className="grid gap-6">
            <div>
              <div className="flex items-end gap-2">
                <Field label="Question bank" className="min-w-0 flex-1">
                  <Select
                    value={bankId}
                    onChange={(e) => setBankId(e.target.value)}
                    disabled={banks.data.items.length === 0}
                  >
                    {banks.data.items.length === 0 && <option value="">No banks yet</option>}
                    {banks.data.items.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.title}
                        {b.archived ? ' (archived)' : ''}
                      </option>
                    ))}
                  </Select>
                </Field>
                {canCreate && (
                  <Button
                    leading={<Plus className="size-4" />}
                    onClick={() => setBankDialog('new')}
                  >
                    New bank
                  </Button>
                )}
                {canEdit && selected && (
                  <MenuRoot>
                    <MenuTrigger asChild>
                      <IconButton label="Bank actions" variant="secondary">
                        <MoreHorizontal className="size-4" />
                      </IconButton>
                    </MenuTrigger>
                    <MenuContent>
                      <MenuItem
                        icon={<Pencil className="size-4" />}
                        onSelect={() => setBankDialog('edit')}
                      >
                        Rename or describe
                      </MenuItem>
                      <MenuItem
                        icon={
                          selected.archived ? (
                            <ArchiveRestore className="size-4" />
                          ) : (
                            <Archive className="size-4" />
                          )
                        }
                        onSelect={() => {
                          setBankError(null);
                          if (selected.archived)
                            archive.mutate(false, {
                              onSuccess: () => toast.success('Bank restored'),
                              onError: (err) => toast.error('Could not restore', errorMessage(err)),
                            });
                          else setBankAction('archive');
                        }}
                      >
                        {selected.archived ? 'Restore' : 'Archive'}
                      </MenuItem>
                      <MenuSeparator />
                      <MenuItem
                        tone="danger"
                        icon={<Trash2 className="size-4" />}
                        onSelect={() => {
                          setBankError(null);
                          setBankAction('delete');
                        }}
                      >
                        Delete
                      </MenuItem>
                    </MenuContent>
                  </MenuRoot>
                )}
              </div>
              {selected && (
                <p className="tabular mt-2 text-sm text-text-secondary">
                  {selected.activeQuestionCount} active of {selected.questionCount} questions
                  {selected.archived && (
                    <>
                      {' '}
                      <Tag tone="warning">Archived</Tag>
                    </>
                  )}
                </p>
              )}
              {selected?.description && (
                <p className="mt-1 max-w-[60ch] text-sm text-text-secondary">
                  {selected.description}
                </p>
              )}
            </div>

            {banks.data.items.length === 0 ? (
              <EmptyState
                title="No question banks yet"
                description={
                  canCreate
                    ? 'Create the first bank to start adding questions.'
                    : 'Ask a training administrator to create one.'
                }
              />
            ) : bank.isPending ? (
              <Skeleton className="h-40 w-full" />
            ) : bank.isError ? (
              <ErrorState message={errorMessage(bank.error)} onRetry={() => bank.refetch()} />
            ) : (
              <TabsRoot value={tab} onValueChange={(t) => setTab(t as TaxonomyKind)}>
                <TabsList
                  className="mb-4"
                  items={[
                    {
                      value: 'categories',
                      label: 'Categories',
                      count: bank.data.categories.length,
                    },
                    {
                      value: 'competencies',
                      label: 'Competencies',
                      count: bank.data.competencies.length,
                    },
                  ]}
                />
                {bank.data.archived && (
                  <Notice tone="warning" className="mb-4">
                    This bank is archived. Restore it before adding questions to it.
                  </Notice>
                )}
                <TabsContent value="categories">
                  <TaxonomyList
                    key={`${bank.data.id}-categories`}
                    bank={bank.data}
                    kind="categories"
                    canEdit={canEdit}
                  />
                </TabsContent>
                <TabsContent value="competencies">
                  <TaxonomyList
                    key={`${bank.data.id}-competencies`}
                    bank={bank.data}
                    kind="competencies"
                    canEdit={canEdit}
                  />
                </TabsContent>
              </TabsRoot>
            )}
          </div>
        )}

        <TextDialog
          open={bankDialog !== null}
          onOpenChange={(o) => !o && setBankDialog(null)}
          title={bankDialog === 'edit' ? 'Edit question bank' : 'New question bank'}
          nameLabel="Title"
          submitLabel={bankDialog === 'edit' ? 'Save' : 'Create bank'}
          initial={{
            name: bankDialog === 'edit' ? (selected?.title ?? '') : '',
            description: bankDialog === 'edit' ? (selected?.description ?? '') : '',
          }}
          onSubmit={async (v) => {
            if (bankDialog === 'edit') {
              await update.mutateAsync({ title: v.name, description: v.description });
              toast.success('Bank updated');
            } else {
              const created = await create.mutateAsync({
                title: v.name,
                description: v.description,
              });
              setBankId(created.id);
              toast.success('Bank created');
            }
          }}
        />
        <ConfirmDialog
          open={bankAction === 'archive'}
          onOpenChange={(o) => !o && setBankAction(null)}
          title={`Archive ${selected?.title ?? 'this bank'}?`}
          description="Nobody can add questions to an archived bank. Questions already in assessments keep working."
          confirmLabel="Archive"
          tone="danger"
          loading={archive.isPending}
          error={bankError}
          onConfirm={() =>
            archive.mutate(true, {
              onSuccess: () => {
                toast.success('Bank archived');
                setBankAction(null);
              },
              onError: (err) => setBankError(errorMessage(err)),
            })
          }
        />
        <ConfirmDialog
          open={bankAction === 'delete'}
          onOpenChange={(o) => !o && setBankAction(null)}
          title={`Delete ${selected?.title ?? 'this bank'}?`}
          description="This removes the bank. A bank that still has questions cannot be deleted; archive it instead."
          confirmLabel="Delete bank"
          tone="danger"
          loading={remove.isPending}
          error={bankError}
          onConfirm={() =>
            remove.mutate(undefined, {
              onSuccess: () => {
                toast.success('Bank deleted');
                setBankAction(null);
                setBankId('');
              },
              onError: (err) => setBankError(errorMessage(err)),
            })
          }
        />
      </SheetContent>
    </DialogRoot>
  );
}
