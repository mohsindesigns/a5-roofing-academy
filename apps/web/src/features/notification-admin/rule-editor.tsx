import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { notification } from '@a5/contracts';
import {
  Button,
  Checkbox,
  DialogRoot,
  Field,
  IconButton,
  Input,
  Notice,
  Select,
  SheetContent,
  Switch,
  toast,
} from '@/components/ui';
import { useRoleOptions } from '@/features/analytics/options';
import { ApiError, errorMessage } from '@/lib/api/errors';
import {
  CONDITION_OPERATORS,
  conditionsToRows,
  describeConditions,
  joinDelay,
  rowsToConditions,
  splitDelay,
  validateRows,
  type ConditionOperator,
  type ConditionRow,
} from './conditions';
import { useUpdateRule } from './api';

const RECIPIENT_LABEL: Record<string, string> = {
  subject: 'The person it is about',
  managers: 'Their managers',
  team_managers: 'Their team managers',
  trainers: 'Their trainers',
  enrolled_learners: 'Everyone enrolled in the program',
};

const CHANNEL_LABEL: Record<notification.NotificationChannel, string> = {
  in_app: 'In-app notification',
  email: 'Email',
};

export function recipientLabel(r: string, roleNames: Map<string, string> = new Map()): string {
  if (r.startsWith('role:')) {
    const key = r.slice(5);
    return `Everyone with the ${roleNames.get(key) ?? key} role`;
  }
  return RECIPIENT_LABEL[r] ?? r;
}

function toggle<T>(list: T[], item: T): T[] {
  return list.includes(item) ? list.filter((x) => x !== item) : [...list, item];
}

/**
 * Edits who gets a notification, how, after what delay and under which conditions. Required
 * account-security rules are shown but locked. Every save is recorded in the audit log.
 */
export function RuleEditor({
  rule,
  onClose,
}: {
  rule: notification.NotificationRule | null;
  onClose: () => void;
}) {
  return (
    <DialogRoot open={Boolean(rule)} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        title={rule?.typeLabel ?? 'Rule'}
        description={rule?.description}
        className="sm:w-[min(640px,94vw)]"
      >
        {rule && <Form key={rule.id} rule={rule} onClose={onClose} />}
      </SheetContent>
    </DialogRoot>
  );
}

function Form({ rule, onClose }: { rule: notification.NotificationRule; onClose: () => void }) {
  const update = useUpdateRule(rule.id);
  const roles = useRoleOptions();
  const locked = rule.mandatory;

  const [recipients, setRecipients] = useState<string[]>(rule.recipients);
  const [channels, setChannels] = useState<notification.NotificationChannel[]>(rule.channels);
  const [priority, setPriority] = useState(rule.priority);
  const [enabled, setEnabled] = useState(rule.enabled);
  const initialDelay = splitDelay(rule.delayMinutes);
  const [delayValue, setDelayValue] = useState(String(initialDelay.value));
  const [delayUnit, setDelayUnit] = useState(initialDelay.unit);
  const [rows, setRows] = useState<ConditionRow[]>(() => conditionsToRows(rule.conditions));
  const [error, setError] = useState<string | null>(null);

  const rowErrors = validateRows(rows);
  const delay = Number(delayValue);
  const delayMinutes = joinDelay(delay, delayUnit);
  const delayError =
    delayValue.trim() === '' || !Number.isInteger(delay) || delay < 0
      ? 'Enter a whole number of zero or more.'
      : delayMinutes > 10_080
        ? 'The delay can be at most 7 days.'
        : undefined;
  const plainRecipients = rule.allowedRecipients.filter((r) => !r.startsWith('role:'));
  const roleRecipients = recipients.filter((r) => r.startsWith('role:'));

  const valid = rowErrors.size === 0 && !delayError && recipients.length > 0 && channels.length > 0;

  const save = async () => {
    setError(null);
    try {
      await update.mutateAsync({
        recipients,
        channels,
        priority,
        enabled,
        delayMinutes,
        conditions: rowsToConditions(rows),
      });
      toast.success('Rule saved', 'It applies to events from now on.');
      onClose();
    } catch (err) {
      setError(
        err instanceof ApiError && err.fields.length
          ? err.fields.map((f) => f.message).join(' ')
          : errorMessage(err),
      );
    }
  };

  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid && !locked) void save();
      }}
    >
      {locked && (
        <Notice tone="warning" title="Required for account security">
          This message always goes to the person by email. You can change its wording under
          Templates.
        </Notice>
      )}
      <p className="text-sm text-text-secondary">
        Sent when <span className="font-mono text-xs">{rule.eventType}</span> happens
        {rule.fixedConditions && Object.keys(rule.fixedConditions).length > 0 && (
          <> and {describeConditions(rule.fixedConditions).join(' and ')}</>
        )}
        .
      </p>

      <fieldset className="grid gap-2" disabled={locked}>
        <legend className="mb-1 text-sm font-medium">Who receives it</legend>
        {plainRecipients.map((r) => (
          <label key={r} className="flex items-center gap-2.5 text-base">
            <Checkbox
              checked={recipients.includes(r)}
              onCheckedChange={() => setRecipients((l) => toggle(l, r))}
            />
            {recipientLabel(r)}
          </label>
        ))}
        {roles.data && roles.data.items.length > 0 && (
          <details className="mt-1" open={roleRecipients.length > 0}>
            <summary className="cursor-pointer text-sm text-text-secondary">
              Everyone with a role{roleRecipients.length > 0 && ` (${roleRecipients.length})`}
            </summary>
            <div className="mt-2 grid gap-2 pl-1">
              {roles.data.items
                .filter((r) => !r.archived)
                .map((r) => (
                  <label key={r.id} className="flex items-center gap-2.5 text-base">
                    <Checkbox
                      checked={recipients.includes(`role:${r.key}`)}
                      onCheckedChange={() => setRecipients((l) => toggle(l, `role:${r.key}`))}
                    />
                    {r.name}
                  </label>
                ))}
            </div>
          </details>
        )}
        {recipients.length === 0 && (
          <p role="alert" className="text-xs font-medium text-danger">
            Choose at least one recipient.
          </p>
        )}
      </fieldset>

      <fieldset className="grid gap-2" disabled={locked}>
        <legend className="mb-1 text-sm font-medium">How it is sent</legend>
        {rule.supportedChannels.map((c) => (
          <label key={c} className="flex items-center gap-2.5 text-base">
            <Checkbox
              checked={channels.includes(c)}
              onCheckedChange={() => setChannels((l) => toggle(l, c))}
            />
            {CHANNEL_LABEL[c]}
          </label>
        ))}
        {channels.length === 0 && (
          <p role="alert" className="text-xs font-medium text-danger">
            Choose at least one channel.
          </p>
        )}
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Wait before sending" hint="Use 0 to send straight away." error={delayError}>
          <div className="flex gap-2">
            <Input
              type="number"
              min={0}
              inputMode="numeric"
              value={delayValue}
              disabled={locked}
              onChange={(e) => setDelayValue(e.target.value)}
            />
            <div className="w-32 shrink-0">
              <Select
                aria-label="Delay unit"
                value={delayUnit}
                disabled={locked}
                onChange={(e) => setDelayUnit(e.target.value as typeof delayUnit)}
              >
                <option value="minutes">minutes</option>
                <option value="hours">hours</option>
                <option value="days">days</option>
              </Select>
            </div>
          </div>
        </Field>
        <Field label="Priority">
          <Select
            value={priority}
            disabled={locked}
            onChange={(e) => setPriority(e.target.value as typeof priority)}
          >
            <option value="low">Low</option>
            <option value="normal">Normal</option>
            <option value="high">High</option>
          </Select>
        </Field>
      </div>

      <fieldset className="grid gap-2" disabled={locked}>
        <legend className="mb-1 text-sm font-medium">Only when</legend>
        {rows.length === 0 && (
          <p className="text-sm text-text-secondary">
            No extra conditions. Every matching event sends a notification.
          </p>
        )}
        {rows.map((row, i) => (
          <div key={i} className="grid gap-1">
            <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2 sm:grid-cols-[minmax(0,1fr)_150px_minmax(0,1fr)_auto]">
              <Input
                aria-label={`Condition ${i + 1} field`}
                placeholder="Event field"
                value={row.field}
                className="col-span-2 sm:col-span-1"
                onChange={(e) =>
                  setRows((l) => l.map((r, j) => (j === i ? { ...r, field: e.target.value } : r)))
                }
              />
              <Select
                aria-label={`Condition ${i + 1} comparison`}
                value={row.op}
                onChange={(e) =>
                  setRows((l) =>
                    l.map((r, j) =>
                      j === i ? { ...r, op: e.target.value as ConditionOperator } : r,
                    ),
                  )
                }
              >
                {CONDITION_OPERATORS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
              <Input
                aria-label={`Condition ${i + 1} value`}
                placeholder={row.op === 'in' || row.op === 'notIn' ? 'a, b, c' : 'Value'}
                value={row.value}
                onChange={(e) =>
                  setRows((l) => l.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))
                }
              />
              <IconButton
                label={`Remove condition ${i + 1}`}
                onClick={() => setRows((l) => l.filter((_, j) => j !== i))}
              >
                <Trash2 className="size-4" />
              </IconButton>
            </div>
            {rowErrors.get(i) && (
              <p role="alert" className="text-xs font-medium text-danger">
                {rowErrors.get(i)}
              </p>
            )}
          </div>
        ))}
        <div>
          <Button
            size="sm"
            leading={<Plus className="size-3.5" />}
            disabled={rows.length >= 10}
            onClick={() => setRows((l) => [...l, { field: '', op: 'eq', value: '' }])}
          >
            Add condition
          </Button>
        </div>
        <p className="text-xs text-text-tertiary">
          Fields come from the event, for example passed or daysRemaining. Values can be true,
          false, a number or text.
        </p>
      </fieldset>

      <label className="flex items-center gap-2.5 text-base">
        <Switch checked={enabled} disabled={locked} onCheckedChange={setEnabled} />
        Rule is on
      </label>

      {error && (
        <p role="alert" className="rounded bg-danger-soft px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2 border-t border-divider pt-4">
        <Button onClick={onClose}>Cancel</Button>
        <Button
          type="submit"
          variant="primary"
          loading={update.isPending}
          disabled={locked || !valid}
        >
          Save rule
        </Button>
      </div>
    </form>
  );
}
