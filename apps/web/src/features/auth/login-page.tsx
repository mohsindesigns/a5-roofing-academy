import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { identity } from '@a5/contracts';
import { AuthLayout } from '@/app/auth-layout';
import { Button, Field, Input, Notice } from '@/components/ui';
import { signIn } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';
import { useAuth } from '@/lib/auth-store';

type Values = { email: string; password: string };

export function LoginPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const signedOutReason = useAuth((s) => s.signedOutReason);
  const [formError, setFormError] = useState<string | null>(null);
  const { register, handleSubmit, formState } = useForm<Values>({
    resolver: zodResolver(identity.loginRequestSchema),
    defaultValues: { email: '', password: '' },
  });

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      await signIn(values.email, values.password);
      const next = params.get('next');
      navigate(next && next.startsWith('/') && !next.startsWith('//') ? next : '/', {
        replace: true,
      });
    } catch (err) {
      setFormError(
        err instanceof ApiError
          ? err.message
          : 'Sign-in failed. Check your connection and try again.',
      );
    }
  });

  return (
    <AuthLayout
      title="Sign in"
      description="Use the email address your A5 manager registered for you."
      footer={<>New to A5? Your manager sends an invitation link to activate your account.</>}
    >
      {signedOutReason && !formError && (
        <Notice tone="warning" className="mb-5" title={signedOutReason} />
      )}
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
        <Field
          label={
            <span className="flex w-full items-center justify-between">
              Password
              <Link
                to="/forgot-password"
                className="text-sm font-normal text-information hover:underline"
              >
                Forgot password?
              </Link>
            </span>
          }
          error={formState.errors.password?.message}
        >
          <Input type="password" autoComplete="current-password" {...register('password')} />
        </Field>
        {formError && (
          <p role="alert" className="rounded bg-danger-soft px-3 py-2 text-sm text-danger">
            {formError}
          </p>
        )}
        <Button
          type="submit"
          variant="primary"
          size="lg"
          block
          loading={formState.isSubmitting}
          className="mt-1"
        >
          Sign in
        </Button>
      </form>
    </AuthLayout>
  );
}
