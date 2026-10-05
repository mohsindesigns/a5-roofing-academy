import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { Check, Circle } from 'lucide-react';
import type { identity } from '@a5/contracts';
import { AuthLayout } from '@/app/auth-layout';
import { Button, Field, Input, Notice, Skeleton } from '@/components/ui';
import { api, apiRequest } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';
import { useAuth } from '@/lib/auth-store';
import { applyServerErrors } from '@/lib/forms';
import { cn } from '@/lib/cn';

interface Values {
  password: string;
  confirm: string;
}

function Requirement({ met, children }: { met: boolean; children: string }) {
  return (
    <li
      className={cn(
        'flex items-center gap-1.5 text-sm',
        met ? 'text-success' : 'text-text-tertiary',
      )}
    >
      {met ? <Check aria-hidden className="size-3.5" /> : <Circle aria-hidden className="size-3" />}
      <span>
        {children}
        <span className="sr-only">{met ? ' (met)' : ' (not met yet)'}</span>
      </span>
    </li>
  );
}

/** Account activation (invitation link) and password reset share this page. */
export function SetPasswordPage({ mode }: { mode: 'activate' | 'reset' }) {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const navigate = useNavigate();
  const [formError, setFormError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const info = useQuery({
    queryKey: ['auth', 'token', token],
    queryFn: () => api.get<identity.TokenInfo>(`/auth/tokens/${encodeURIComponent(token)}`),
    enabled: token.length >= 16,
    retry: false,
  });
  const { register, handleSubmit, watch, setError, formState } = useForm<Values>({
    defaultValues: { password: '', confirm: '' },
  });
  const password = watch('password');
  const confirm = watch('confirm');
  const minLength = info.data?.passwordPolicy.minLength ?? 12;

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    if (values.password.length < minLength) {
      setError('password', { message: `Use at least ${minLength} characters.` });
      return;
    }
    if (values.password !== values.confirm) {
      setError('confirm', { message: 'The passwords do not match.' });
      return;
    }
    try {
      if (mode === 'activate') {
        const session = await apiRequest<identity.LoginResponse>('/auth/activate', {
          method: 'POST',
          body: { token, password: values.password },
          skipRefresh: true,
        });
        useAuth.getState().setSession(session);
        navigate('/', { replace: true });
      } else {
        await api.post('/auth/password/reset', { token, password: values.password });
        setDone(true);
      }
    } catch (err) {
      setFormError(applyServerErrors(err, setError, ['password']));
    }
  });

  const title = mode === 'activate' ? 'Activate your account' : 'Choose a new password';

  if (!token || info.isError) {
    const message =
      info.error instanceof ApiError
        ? info.error.message
        : 'This link is incomplete. Open it again from your email.';
    return (
      <AuthLayout
        title={mode === 'activate' ? 'Activation link not valid' : 'Reset link not valid'}
      >
        <Notice tone="warning">
          {token ? message : 'This link is incomplete. Open it again from your email.'}
        </Notice>
        <Button asChild className="mt-5">
          <Link to={mode === 'activate' ? '/login' : '/forgot-password'}>
            {mode === 'activate' ? 'Go to sign in' : 'Request a new link'}
          </Link>
        </Button>
      </AuthLayout>
    );
  }

  if (done) {
    return (
      <AuthLayout title="Password updated">
        <Notice tone="success">
          Your password was changed and every other session was signed out.
        </Notice>
        <Button asChild variant="primary" className="mt-5">
          <Link to="/login">Sign in</Link>
        </Button>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title={title}
      description={
        info.data ? (
          <>
            {mode === 'activate' ? 'Welcome to A5 Roofing, ' : 'Resetting the password for '}
            <strong className="font-medium text-text-primary">
              {mode === 'activate' ? info.data.displayName.split(' ')[0] : info.data.email}
            </strong>
            {mode === 'activate' ? '. Set a password to start your training.' : '.'}
          </>
        ) : (
          <Skeleton className="h-4 w-60" />
        )
      }
    >
      <form onSubmit={onSubmit} className="grid gap-4" noValidate>
        {info.data && (
          <input type="email" autoComplete="username" value={info.data.email} readOnly hidden />
        )}
        <Field label="New password" error={formState.errors.password?.message}>
          <Input type="password" autoComplete="new-password" autoFocus {...register('password')} />
        </Field>
        <ul className="-mt-1 grid gap-1" aria-label="Password requirements">
          <Requirement
            met={password.length >= minLength}
          >{`At least ${minLength} characters`}</Requirement>
          <Requirement met={password.length > 0 && password === confirm}>
            Both entries match
          </Requirement>
        </ul>
        <Field label="Confirm password" error={formState.errors.confirm?.message}>
          <Input type="password" autoComplete="new-password" {...register('confirm')} />
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
          disabled={!info.data}
        >
          {mode === 'activate' ? 'Activate and continue' : 'Update password'}
        </Button>
        {info.isPending && <p className="text-sm text-text-tertiary">Checking your link…</p>}
      </form>
    </AuthLayout>
  );
}
