import { useState } from 'react';
import { Link } from 'react-router';
import { ArrowDown, ArrowUp, Pencil, Plus, Shuffle, Trash2 } from 'lucide-react';
import { assessment } from '@a5/contracts';
import { Button, ConfirmDialog, EmptyState, IconButton, Notice, Tag, toast } from '@/components/ui';
import { errorMessage } from '@/lib/api/errors';
import { useDeleteItem, useReplaceItems } from '../api';
import { DIFFICULTY_LABELS, formatPoints } from '../labels';
import { describePoolFilters, moveRequestItem, type Item } from './item-model';
import { PoolRuleDialog } from './pool-rule-dialog';
import { QuestionPicker } from './question-picker';

type PoolItem = Extract<Item, { kind: 'pool' }>;

function ItemRow({
  item,
  index,
  total,
  canEdit,
  busy,
  onMove,
  onEdit,
  onRemove,
}: {
  item: Item;
  index: number;
  total: number;
  canEdit: boolean;
  busy: boolean;
  onMove: (delta: -1 | 1) => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const label = item.kind === 'question' ? 'this question' : 'this random draw';
  return (
    <li className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-2 px-4 py-3.5 sm:grid-cols-[auto_minmax(0,1fr)_auto]">
      <span
        aria-hidden
        className="tabular mt-0.5 flex size-6 items-center justify-center rounded-full bg-surface-sunken text-sm font-medium text-text-secondary"
      >
        {index + 1}
      </span>
      <div className="min-w-0">
        {item.kind === 'question' ? (
          <>
            <Link
              to={`/content/questions/${item.question.id}`}
              className="line-clamp-2 font-medium hover:underline"
            >
              {item.question.prompt}
            </Link>
            <p className="mt-0.5 text-sm text-text-secondary">
              {assessment.QUESTION_TYPE_LABELS[item.question.type]} ·{' '}
              {DIFFICULTY_LABELS[item.question.difficulty]} ·{' '}
              {item.question.category?.name ?? 'No category'} ·{' '}
              <span className="tabular">{formatPoints(item.points ?? item.question.points)}</span>{' '}
              {(item.points ?? item.question.points) === 1 ? 'point' : 'points'}
              {item.points !== null && ' (set here)'}
            </p>
            {item.question.status === 'archived' && (
              <p className="mt-1">
                <Tag tone="warning">Archived question</Tag>
                <span className="ml-2 text-sm text-text-secondary">
                  Restore it or replace it before learners can start this assessment.
                </span>
              </p>
            )}
          </>
        ) : (
          <>
            <p className="flex items-start gap-2 font-medium">
              <Shuffle aria-hidden className="mt-1 size-4 shrink-0 text-text-tertiary" />
              <span>
                Draw {item.count} at random from {item.bank.title}
              </span>
            </p>
            <p className="mt-0.5 text-sm text-text-secondary">
              {describePoolFilters(item)}
              {item.points !== null && (
                <>
                  {' '}
                  · <span className="tabular">{formatPoints(item.points)}</span> points each
                </>
              )}
            </p>
            <p
              className={`mt-0.5 text-sm ${item.available < item.count ? 'font-medium text-danger' : 'text-text-tertiary'}`}
            >
              {item.available < item.count
                ? `Only ${item.available} active ${item.available === 1 ? 'question matches' : 'questions match'}, so this rule cannot fill ${item.count}.`
                : `${item.available} active ${item.available === 1 ? 'question matches' : 'questions match'}.`}
            </p>
          </>
        )}
      </div>
      {canEdit && (
        <div className="col-start-2 -ml-1.5 flex items-center gap-0.5 sm:col-start-3 sm:row-start-1 sm:ml-0">
          <IconButton
            label={`Move ${label} up`}
            size="sm"
            disabled={busy || index === 0}
            onClick={() => onMove(-1)}
          >
            <ArrowUp className="size-4" />
          </IconButton>
          <IconButton
            label={`Move ${label} down`}
            size="sm"
            disabled={busy || index === total - 1}
            onClick={() => onMove(1)}
          >
            <ArrowDown className="size-4" />
          </IconButton>
          {item.kind === 'pool' ? (
            <IconButton label="Edit random draw" size="sm" disabled={busy} onClick={onEdit}>
              <Pencil className="size-4" />
            </IconButton>
          ) : (
            <span aria-hidden className="hidden w-[var(--a5-control-height-sm)] sm:block" />
          )}
          <IconButton label={`Remove ${label}`} size="sm" disabled={busy} onClick={onRemove}>
            <Trash2 className="size-4" />
          </IconButton>
        </div>
      )}
    </li>
  );
}

export function AssessmentItems({
  assessmentId,
  items,
  status,
  canEdit,
}: {
  assessmentId: string;
  items: readonly Item[];
  status: assessment.AssessmentStatus;
  canEdit: boolean;
}) {
  const replace = useReplaceItems(assessmentId);
  const remove = useDeleteItem(assessmentId);
  const [picking, setPicking] = useState(false);
  const [poolFor, setPoolFor] = useState<PoolItem | 'new' | null>(null);
  const [removing, setRemoving] = useState<Item | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const editable = canEdit && status !== 'archived';

  return (
    <div>
      {editable && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <p className="max-w-[60ch] text-sm text-text-secondary">
            Add specific questions, or a random draw that picks questions from a bank for each
            attempt. Order here is the order learners see unless question order is randomized in
            Settings.
          </p>
          <div className="flex gap-2">
            <Button leading={<Shuffle className="size-4" />} onClick={() => setPoolFor('new')}>
              Add random draw
            </Button>
            <Button
              variant="primary"
              leading={<Plus className="size-4" />}
              onClick={() => setPicking(true)}
            >
              Add questions
            </Button>
          </div>
        </div>
      )}
      {status === 'published' && editable && (
        <Notice tone="information" className="mb-4">
          This assessment is published. Changes apply to attempts that start after you save;
          attempts in progress keep their questions.
        </Notice>
      )}
      {items.length === 0 ? (
        <EmptyState
          title="No questions yet"
          description={
            editable
              ? 'Add questions from the bank before you publish.'
              : 'This assessment has no questions.'
          }
          action={
            editable ? (
              <Button variant="primary" onClick={() => setPicking(true)}>
                Add questions
              </Button>
            ) : undefined
          }
        />
      ) : (
        <ol
          aria-label="Assessment items"
          className="divide-y divide-divider overflow-hidden rounded-lg border border-border bg-surface"
        >
          {items.map((item, i) => (
            <ItemRow
              key={item.id}
              item={item}
              index={i}
              total={items.length}
              canEdit={editable}
              busy={replace.isPending || remove.isPending}
              onMove={(delta) =>
                replace.mutate(moveRequestItem(items, i, delta), {
                  onError: (err) => toast.error('Could not reorder', errorMessage(err)),
                })
              }
              onEdit={() => item.kind === 'pool' && setPoolFor(item)}
              onRemove={() => {
                setRemoveError(null);
                setRemoving(item);
              }}
            />
          ))}
        </ol>
      )}

      <QuestionPicker
        assessmentId={assessmentId}
        items={items}
        open={picking}
        onOpenChange={setPicking}
      />
      <PoolRuleDialog
        key={poolFor === 'new' ? 'new' : (poolFor?.id ?? 'none')}
        assessmentId={assessmentId}
        item={poolFor && poolFor !== 'new' ? poolFor : undefined}
        open={poolFor !== null}
        onOpenChange={(o) => !o && setPoolFor(null)}
      />
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title="Remove from this assessment?"
        description={
          removing?.kind === 'question'
            ? 'The question stays in the bank. Past attempts keep the question they were given.'
            : 'The random draw is removed. Questions in the bank are not affected.'
        }
        confirmLabel="Remove"
        tone="danger"
        loading={remove.isPending}
        error={removeError}
        onConfirm={() => {
          if (!removing) return;
          remove.mutate(removing.id, {
            onSuccess: () => {
              toast.success('Removed');
              setRemoving(null);
            },
            onError: (err) => setRemoveError(errorMessage(err)),
          });
        }}
      />
    </div>
  );
}
