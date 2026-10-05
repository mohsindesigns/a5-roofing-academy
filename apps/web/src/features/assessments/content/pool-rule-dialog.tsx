import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { assessment } from '@a5/contracts';
import { Button, DialogContent, DialogRoot, Field, Input, Select, toast } from '@/components/ui';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { errorMessage } from '@/lib/api/errors';
import { useAddItem, useBank, useBanks, useQuestions, useUpdateItem } from '../api';
import { DIFFICULTY_LABELS } from '../labels';

type PoolItem = Extract<assessment.AssessmentItem, { kind: 'pool' }>;

interface Values {
  bankId: string;
  categoryId: string;
  difficulty: string;
  tags: string;
  count: string;
  points: string;
}

export function parseTags(text: string): string[] {
  return [
    ...new Set(
      text
        .split(',')
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}

const FIELDS: Record<string, keyof Values> = {
  bankId: 'bankId',
  categoryId: 'categoryId',
  difficulty: 'difficulty',
  tags: 'tags',
  count: 'count',
  points: 'points',
};

/** Add or edit a random draw: "pick N questions from this bank that match these filters". */
export function PoolRuleDialog({
  assessmentId,
  item,
  open,
  onOpenChange,
}: {
  assessmentId: string;
  /** Present when editing an existing rule. */
  item?: PoolItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const banks = useBanks();
  const add = useAddItem(assessmentId);
  const update = useUpdateItem(assessmentId);
  const [formError, setFormError] = useState<string | null>(null);
  const defaultBank = item?.bank.id ?? banks.data?.items.find((b) => !b.archived)?.id ?? '';
  const { register, handleSubmit, setError, setValue, watch, formState } = useForm<Values>({
    values: {
      bankId: defaultBank,
      categoryId: item?.category?.id ?? '',
      difficulty: item?.difficulty ?? '',
      tags: item?.tags.join(', ') ?? '',
      count: String(item?.count ?? 5),
      points: item?.points == null ? '' : String(item.points),
    },
  });
  const bankId = watch('bankId');
  const categoryId = watch('categoryId');
  const difficulty = watch('difficulty');
  const tags = useDebouncedValue(watch('tags'), 300);
  const bank = useBank(bankId || undefined);
  const matching = useQuestions(
    {
      bankId,
      categoryId: categoryId || undefined,
      difficulty: difficulty || undefined,
      tags: parseTags(tags).join(',') || undefined,
      status: 'active',
      pageSize: 1,
    },
    Boolean(bankId),
  );

  const save = handleSubmit(async (v) => {
    setFormError(null);
    const payload = {
      kind: 'pool' as const,
      bankId: v.bankId,
      categoryId: v.categoryId || null,
      difficulty: (v.difficulty || null) as assessment.Difficulty | null,
      tags: parseTags(v.tags),
      count: v.count.trim() === '' ? Number.NaN : Number(v.count),
      points: v.points.trim() === '' ? null : Number(v.points),
    };
    const parsed = assessment.assessmentItemInputSchema.safeParse(payload);
    if (!parsed.success) {
      let unmapped: string | null = null;
      for (const issue of parsed.error.issues) {
        const field = FIELDS[String(issue.path[0])];
        if (field)
          setError(field, {
            message: field === 'count' ? 'Enter a whole number from 1 to 200' : issue.message,
          });
        else unmapped = issue.message;
      }
      if (unmapped) setFormError(unmapped);
      return;
    }
    try {
      if (item)
        await update.mutateAsync({
          itemId: item.id,
          body: { ...payload, position: item.position },
        });
      else await add.mutateAsync(payload);
      toast.success(item ? 'Random draw updated' : 'Random draw added');
      onOpenChange(false);
    } catch (err) {
      setFormError(errorMessage(err));
    }
  });

  const count = Number(watch('count'));
  const available = matching.data?.total;
  return (
    <DialogRoot
      open={open}
      onOpenChange={(o) => {
        setFormError(null);
        onOpenChange(o);
      }}
    >
      <DialogContent
        title={item ? 'Edit random draw' : 'Add a random draw'}
        description="Each attempt draws this many questions at random from the matching ones, so learners do not all see the same set."
      >
        <form className="grid gap-4" noValidate onSubmit={save}>
          <Field label="Question bank" required error={formState.errors.bankId?.message}>
            <Select
              {...register('bankId', { onChange: () => setValue('categoryId', '') })}
              disabled={banks.isPending}
            >
              {banks.data?.items.length === 0 && <option value="">No question banks yet</option>}
              {banks.data?.items.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.title}
                  {b.archived ? ' (archived)' : ''}
                </option>
              ))}
            </Select>
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Category" optional error={formState.errors.categoryId?.message}>
              <Select {...register('categoryId')}>
                <option value="">Any category</option>
                {bank.data?.categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Difficulty" optional error={formState.errors.difficulty?.message}>
              <Select {...register('difficulty')}>
                <option value="">Any difficulty</option>
                {assessment.DIFFICULTIES.map((d) => (
                  <option key={d} value={d}>
                    {DIFFICULTY_LABELS[d]}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field
            label="Tags"
            optional
            hint="Separate tags with commas. A question must carry every tag listed."
            error={formState.errors.tags?.message}
          >
            <Input {...register('tags')} autoComplete="off" />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Questions to draw" required error={formState.errors.count?.message}>
              <Input type="number" inputMode="numeric" min={1} max={200} {...register('count')} />
            </Field>
            <Field
              label="Points per question"
              optional
              hint="Leave empty to use each question's own points."
              error={formState.errors.points?.message}
            >
              <Input type="number" inputMode="decimal" min={0} step="any" {...register('points')} />
            </Field>
          </div>
          {bankId && (
            <p aria-live="polite" className="text-sm text-text-secondary">
              {matching.isPending ? (
                'Counting matching questions'
              ) : matching.isError ? (
                'Could not count matching questions.'
              ) : available !== undefined && Number.isFinite(count) && available < count ? (
                <span className="font-medium text-danger">
                  Only {available} active {available === 1 ? 'question matches' : 'questions match'}
                  . Learners could not start this assessment until there are at least {count}.
                </span>
              ) : (
                <>
                  {available} active {available === 1 ? 'question matches' : 'questions match'}{' '}
                  these filters. Questions already added individually are not drawn twice.
                </>
              )}
            </p>
          )}
          {formError && (
            <p role="alert" className="rounded bg-danger-soft px-3 py-2 text-sm text-danger">
              {formError}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button
              type="submit"
              variant="primary"
              loading={formState.isSubmitting}
              disabled={!bankId}
            >
              {item ? 'Save changes' : 'Add random draw'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </DialogRoot>
  );
}
