import { useEffect, useState } from 'react';
import { Search } from 'lucide-react';
import { assessment } from '@a5/contracts';
import {
  Button,
  Checkbox,
  DialogContent,
  DialogRoot,
  EmptyState,
  ErrorState,
  Input,
  Pagination,
  Select,
  Skeleton,
  Tag,
  toast,
} from '@/components/ui';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { errorMessage } from '@/lib/api/errors';
import { useBank, useBanks, useQuestions, useReplaceItems } from '../api';
import { DIFFICULTY_LABELS, formatPoints } from '../labels';
import { appendQuestions, type Item } from './item-model';

/** Choose active questions from the bank and add them to an assessment as fixed items. */
export function QuestionPicker({
  assessmentId,
  items,
  open,
  onOpenChange,
}: {
  assessmentId: string;
  items: readonly Item[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const replace = useReplaceItems(assessmentId);
  const banks = useBanks();
  const [search, setSearch] = useState('');
  const q = useDebouncedValue(search, 250);
  const [bankId, setBankId] = useState('');
  const [type, setType] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [difficulty, setDifficulty] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const bank = useBank(bankId || undefined);
  const present = new Set(items.flatMap((i) => (i.kind === 'question' ? [i.question.id] : [])));

  useEffect(() => setPage(1), [q, bankId, type, categoryId, difficulty]);

  const list = useQuestions(
    {
      q: q || undefined,
      bankId: bankId || undefined,
      type: type || undefined,
      categoryId: categoryId || undefined,
      difficulty: difficulty || undefined,
      status: 'active',
      sort: 'prompt',
      page,
      pageSize: 10,
    },
    open,
  );

  const reset = () => {
    setSelected([]);
    setError(null);
    setSearch('');
    setBankId('');
    setType('');
    setCategoryId('');
    setDifficulty('');
  };

  const add = async () => {
    setError(null);
    try {
      await replace.mutateAsync(appendQuestions(items, selected));
      toast.success(
        selected.length === 1 ? 'Question added' : `${selected.length} questions added`,
      );
      reset();
      onOpenChange(false);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <DialogRoot
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent
        size="lg"
        title="Add questions"
        description="Pick specific questions from the bank. They appear in this order for every learner unless the assessment randomizes question order."
        footer={
          <>
            <p className="mr-auto text-sm text-text-secondary" aria-live="polite">
              {selected.length === 0 ? 'Nothing selected' : `${selected.length} selected`}
            </p>
            <Button onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={selected.length === 0}
              loading={replace.isPending}
              onClick={add}
            >
              Add {selected.length > 0 ? selected.length : ''}{' '}
              {selected.length === 1 ? 'question' : 'questions'}
            </Button>
          </>
        }
      >
        <div className="grid gap-3">
          <Input
            type="search"
            aria-label="Search questions"
            placeholder="Search question text or tags"
            leading={<Search className="size-4" />}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="grid gap-2 sm:grid-cols-4">
            <Select
              aria-label="Question bank"
              value={bankId}
              onChange={(e) => {
                setBankId(e.target.value);
                setCategoryId('');
              }}
            >
              <option value="">All banks</option>
              {banks.data?.items.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.title}
                </option>
              ))}
            </Select>
            <Select
              aria-label="Category"
              value={categoryId}
              disabled={!bankId}
              onChange={(e) => setCategoryId(e.target.value)}
            >
              <option value="">{bankId ? 'All categories' : 'Choose a bank first'}</option>
              {bank.data?.categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
            <Select
              aria-label="Question type"
              value={type}
              onChange={(e) => setType(e.target.value)}
            >
              <option value="">All types</option>
              {assessment.QUESTION_TYPES.map((t) => (
                <option key={t} value={t}>
                  {assessment.QUESTION_TYPE_LABELS[t]}
                </option>
              ))}
            </Select>
            <Select
              aria-label="Difficulty"
              value={difficulty}
              onChange={(e) => setDifficulty(e.target.value)}
            >
              <option value="">Any difficulty</option>
              {assessment.DIFFICULTIES.map((d) => (
                <option key={d} value={d}>
                  {DIFFICULTY_LABELS[d]}
                </option>
              ))}
            </Select>
          </div>

          {list.isPending ? (
            <div className="grid gap-2" aria-busy="true" aria-label="Loading questions">
              {Array.from({ length: 5 }, (_, i) => (
                <Skeleton key={i} className="h-14 w-full" />
              ))}
            </div>
          ) : list.isError ? (
            <ErrorState message={errorMessage(list.error)} onRetry={() => list.refetch()} />
          ) : list.data.items.length === 0 ? (
            <EmptyState
              title="No questions match"
              description="Try another search, or add the question to the bank first."
            />
          ) : (
            <>
              <ul className="divide-y divide-divider overflow-hidden rounded-lg border border-border">
                {list.data.items.map((question) => {
                  const included = present.has(question.id);
                  const checked = included || selected.includes(question.id);
                  return (
                    <li key={question.id}>
                      <label
                        className={`flex items-start gap-3 px-4 py-3 ${included ? 'cursor-not-allowed bg-surface-sunken/50' : 'cursor-pointer hover:bg-surface-hover'}`}
                      >
                        <Checkbox
                          className="mt-0.5"
                          checked={checked}
                          disabled={included}
                          onCheckedChange={(c) =>
                            setSelected((s) =>
                              c ? [...s, question.id] : s.filter((id) => id !== question.id),
                            )
                          }
                        />
                        <span className="min-w-0 flex-1">
                          <span className="line-clamp-2 block font-medium">{question.prompt}</span>
                          <span className="mt-0.5 block text-sm text-text-secondary">
                            {assessment.QUESTION_TYPE_LABELS[question.type]} ·{' '}
                            {DIFFICULTY_LABELS[question.difficulty]} ·{' '}
                            {question.category?.name ?? 'No category'} ·{' '}
                            <span className="tabular">{formatPoints(question.points)}</span>{' '}
                            {question.points === 1 ? 'point' : 'points'}
                          </span>
                        </span>
                        {included && <Tag>Already added</Tag>}
                      </label>
                    </li>
                  );
                })}
              </ul>
              <Pagination
                page={list.data.page}
                pageCount={list.data.pageCount}
                total={list.data.total}
                pageSize={list.data.pageSize}
                onPage={setPage}
                noun="questions"
              />
            </>
          )}
          {error && (
            <p role="alert" className="rounded bg-danger-soft px-3 py-2 text-sm text-danger">
              {error}
            </p>
          )}
        </div>
      </DialogContent>
    </DialogRoot>
  );
}
