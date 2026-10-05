import { useState } from 'react';
import { Pencil } from 'lucide-react';
import type { notification } from '@a5/contracts';
import {
  Button,
  EmptyState,
  ErrorState,
  Skeleton,
  StatusText,
  Switch,
  Table,
  TBody,
  Td,
  Th,
  THead,
  Tr,
  toast,
} from '@/components/ui';
import { useRoles } from '@/features/access/api';
import { categoryLabel } from '@/features/notifications/notification-item';
import { errorMessage } from '@/lib/api/errors';
import { useRules, useToggleRule } from './api';
import { describeConditions, describeDelay } from './conditions';
import { RuleEditor, recipientLabel } from './rule-editor';

const CHANNEL: Record<notification.NotificationChannel, string> = {
  in_app: 'In-app',
  email: 'Email',
};

/** Who gets each notification, how, and when. */
export function RulesPanel() {
  const rules = useRules();
  const roles = useRoles();
  const toggle = useToggleRule();
  const [editing, setEditing] = useState<notification.NotificationRule | null>(null);
  const roleNames = new Map(roles.data?.items.map((r) => [r.key, r.name]) ?? []);

  if (rules.isPending) return <Skeleton className="h-96 w-full" />;
  if (rules.isError)
    return <ErrorState message={errorMessage(rules.error)} onRetry={() => rules.refetch()} />;
  if (rules.data.items.length === 0) return <EmptyState title="No notification rules yet" />;

  return (
    <>
      <Table caption="Notification rules">
        <THead>
          <tr>
            <Th>Notification</Th>
            <Th className="hidden md:table-cell">Sent to</Th>
            <Th className="hidden sm:table-cell">Channels</Th>
            <Th className="hidden lg:table-cell">Timing</Th>
            <Th>On</Th>
            <Th className="sr-only">Edit</Th>
          </tr>
        </THead>
        <TBody>
          {rules.data.items.map((r) => {
            const conditions = describeConditions(r.conditions);
            return (
              <Tr key={r.id}>
                <Td className="min-w-[200px]">
                  <span className="block font-medium">{r.typeLabel}</span>
                  <span className="block max-w-[46ch] text-xs text-text-secondary">
                    {categoryLabel(r.category)} · {r.description}
                  </span>
                  {conditions.length > 0 && (
                    <span className="block text-xs text-text-tertiary">
                      Only when {conditions.join(' and ')}
                    </span>
                  )}
                </Td>
                <Td className="hidden text-sm text-text-secondary md:table-cell">
                  {r.recipients.map((x) => recipientLabel(x, roleNames)).join(', ')}
                </Td>
                <Td className="hidden text-sm text-text-secondary sm:table-cell">
                  {r.channels.map((c) => CHANNEL[c]).join(' + ')}
                </Td>
                <Td className="hidden text-sm text-text-secondary lg:table-cell">
                  {describeDelay(r.delayMinutes)}
                </Td>
                <Td>
                  {r.mandatory ? (
                    <StatusText tone="neutral">Required</StatusText>
                  ) : (
                    <Switch
                      checked={r.enabled}
                      aria-label={`${r.typeLabel} is ${r.enabled ? 'on' : 'off'}`}
                      disabled={toggle.isPending}
                      onCheckedChange={async (enabled) => {
                        try {
                          await toggle.mutateAsync({ id: r.id, enabled });
                          toast.success(`${r.typeLabel} turned ${enabled ? 'on' : 'off'}`);
                        } catch (err) {
                          toast.error('Could not change the rule', errorMessage(err));
                        }
                      }}
                    />
                  )}
                </Td>
                <Td className="text-right">
                  <Button
                    size="sm"
                    variant="ghost"
                    leading={<Pencil className="size-3.5" />}
                    onClick={() => setEditing(r)}
                  >
                    {r.mandatory ? 'View' : 'Edit'}
                    <span className="sr-only"> {r.typeLabel}</span>
                  </Button>
                </Td>
              </Tr>
            );
          })}
        </TBody>
      </Table>
      <RuleEditor rule={editing} onClose={() => setEditing(null)} />
    </>
  );
}
