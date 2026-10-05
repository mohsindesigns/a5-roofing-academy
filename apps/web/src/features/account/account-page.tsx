import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { identity } from '@a5/contracts';
import {
  Button,
  DescriptionList,
  Field,
  Input,
  PageHeader,
  Panel,
  Section,
  StatusText,
  Table,
  TBody,
  Td,
  Th,
  THead,
  Tr,
  toast,
} from '@/components/ui';
import { useMe } from '@/features/auth/session';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import { applyServerErrors } from '@/lib/forms';
import { describeUserAgent, formatDateTime, formatRelative } from '@/lib/format';

function ChangePassword() {
  const [formError, setFormError] = useState<string | null>(null);
  const { register, handleSubmit, setError, reset, formState } =
    useForm<identity.ChangePasswordRequest>({
      resolver: zodResolver(identity.changePasswordRequestSchema),
      defaultValues: { currentPassword: '', newPassword: '' },
    });
  return (
    <form
      className="grid max-w-[420px] gap-4"
      onSubmit={handleSubmit(async (v) => {
        setFormError(null);
        try {
          await api.post('/auth/password/change', v);
          reset();
          toast.success('Password changed', 'Your other devices were signed out.');
        } catch (err) {
          setFormError(applyServerErrors(err, setError, ['currentPassword', 'newPassword']));
        }
      })}
    >
      <Field label="Current password" error={formState.errors.currentPassword?.message}>
        <Input type="password" autoComplete="current-password" {...register('currentPassword')} />
      </Field>
      <Field
        label="New password"
        error={formState.errors.newPassword?.message}
        hint="At least 12 characters. Avoid your name or email."
      >
        <Input type="password" autoComplete="new-password" {...register('newPassword')} />
      </Field>
      {formError && (
        <p role="alert" className="rounded bg-danger-soft px-3 py-2 text-sm text-danger">
          {formError}
        </p>
      )}
      <div>
        <Button type="submit" variant="primary" loading={formState.isSubmitting}>
          Change password
        </Button>
      </div>
    </form>
  );
}

function Sessions() {
  const qc = useQueryClient();
  const sessions = useQuery({
    queryKey: ['account', 'sessions'],
    queryFn: () => api.get<{ items: identity.SessionInfo[] }>('/auth/sessions'),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.delete(`/auth/sessions/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['account', 'sessions'] }),
  });
  if (!sessions.data) return null;
  return (
    <Table caption="Your sessions">
      <THead>
        <tr>
          <Th>Device</Th>
          <Th className="hidden sm:table-cell">Last active</Th>
          <Th className="hidden md:table-cell">IP address</Th>
          <Th className="text-right">
            <span className="sr-only">Actions</span>
          </Th>
        </tr>
      </THead>
      <TBody>
        {sessions.data.items.map((s) => (
          <Tr key={s.id}>
            <Td>
              {describeUserAgent(s.userAgent)}
              {s.current && (
                <StatusText tone="success" className="ml-2">
                  This device
                </StatusText>
              )}
            </Td>
            <Td className="hidden sm:table-cell">{formatRelative(s.lastSeenAt)}</Td>
            <Td className="hidden font-mono text-sm md:table-cell">{s.ip ?? '—'}</Td>
            <Td className="text-right">
              {!s.current && (
                <Button
                  size="sm"
                  variant="ghost"
                  loading={revoke.isPending && revoke.variables === s.id}
                  onClick={() =>
                    revoke.mutate(s.id, {
                      onSuccess: () => toast.success('Device signed out'),
                      onError: (err) => toast.error('Could not sign out device', errorMessage(err)),
                    })
                  }
                >
                  Sign out
                </Button>
              )}
            </Td>
          </Tr>
        ))}
      </TBody>
    </Table>
  );
}

export function AccountPage() {
  const me = useMe();
  const u = me.data?.user;
  const logins = useQuery({
    queryKey: ['account', 'logins'],
    queryFn: () => api.get<{ items: identity.LoginHistoryEntry[] }>('/auth/login-history'),
  });
  return (
    <>
      <PageHeader
        title="Account & security"
        description="Your profile is managed by your administrator. Keep your password private."
      />
      {u && (
        <Section title="Profile">
          <DescriptionList
            columns={3}
            items={[
              { label: 'Name', value: u.displayName },
              { label: 'Email', value: u.email },
              { label: 'Job title', value: u.jobTitle },
              { label: 'Organization', value: u.organizationName },
              { label: 'Roles', value: u.roles.map((r) => r.name).join(', ') },
            ]}
          />
        </Section>
      )}
      <Section title="Password">
        <Panel>
          <ChangePassword />
        </Panel>
      </Section>
      <Section title="Signed-in devices">
        <Sessions />
      </Section>
      {logins.data && logins.data.items.length > 0 && (
        <Section title="Recent sign-ins">
          <ul className="divide-y divide-divider rounded-lg border border-border bg-surface text-sm">
            {logins.data.items.slice(0, 8).map((l) => (
              <li
                key={l.id}
                className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5"
              >
                <span>{formatDateTime(l.occurredAt)}</span>
                <span className="text-text-secondary">{describeUserAgent(l.userAgent)}</span>
                {l.success ? (
                  <StatusText tone="success">Signed in</StatusText>
                ) : (
                  <StatusText tone="danger">Failed</StatusText>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}
    </>
  );
}
