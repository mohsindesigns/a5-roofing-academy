import { useState } from 'react';
import { Link } from 'react-router';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { identity } from '@a5/contracts';
import { AuthLayout } from '@/app/auth-layout';
import { Button, Field, Input, Notice } from '@/components/ui';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';

export function ForgotPasswordPage() {
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { register, handleSubmit, formState } = useForm<{ email: string }>({
    resolver: zodResolver(identity.forgotPasswordRequestSchema),
    defaultValues: { email: '' },
  });

  const onSubmit = handleSubmit(async (values) => {
    setError(null);
    try {
      await api.post('/auth/password/forgot', values);
      setSentTo(values.email);
    } catch (err) {
      setError(errorMessage(err));
    }
  });

  return (
    <AuthLayout
      title="Reset your password"
      description="Enter your work email. If it matches an active account, we'll send a link that is valid for 30 minutes."
      footer={
        <Link to="/login" className="text-information hover:underline">
          Back to sign in
        </Link>
      }
    >
      {sentTo ? (
        <Notice tone="success" title="Check your email">
          If <strong>{sentTo}</strong> belongs to an active account, a reset link is on its way. It
          can take a minute to arrive.
        </Notice>
      ) : (
        <form onSubmit={onSubmit} className="grid gap-4" noValidate>
          <Field label="Email" error={formState.errors.email?.message}>
            <Input
              type="email"
              autoComplete="username"
              inputMode="email"
              autoFocus
              {...register('email')}
            />
          </Field>
          {error && (
            <p role="alert" className="rounded bg-danger-soft px-3 py-2 text-sm text-danger">
              {error}
            </p>
          )}
          <Button type="submit" variant="primary" size="lg" block loading={formState.isSubmitting}>
            Send reset link
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}
