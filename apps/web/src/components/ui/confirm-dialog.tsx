import { useState, type ReactNode } from 'react';
import { AlertDialog } from 'radix-ui';
import { Button } from './button';
import { Field } from './field';
import { Input, Textarea } from './input';

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  tone?: 'danger' | 'primary';
  /** Require the user to type this phrase before confirming (destructive actions). */
  confirmPhrase?: string;
  /** Ask for a reason, passed to onConfirm. */
  reasonLabel?: string;
  reasonRequired?: boolean;
  loading?: boolean;
  error?: string | null;
  onConfirm: (reason: string) => void;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  tone = 'primary',
  confirmPhrase,
  reasonLabel,
  reasonRequired,
  loading,
  error,
  onConfirm,
}: ConfirmDialogProps) {
  const [typed, setTyped] = useState('');
  const [reason, setReason] = useState('');
  const phraseOk = !confirmPhrase || typed.trim() === confirmPhrase;
  const reasonOk = !reasonRequired || reason.trim().length >= 3;

  return (
    <AlertDialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setTyped('');
          setReason('');
        }
        onOpenChange(next);
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-40 bg-[rgb(28_27_25/0.36)]" />
        <AlertDialog.Content className="fixed top-1/2 left-1/2 z-50 w-[calc(100vw-24px)] max-w-[460px] -translate-x-1/2 -translate-y-1/2 rounded-lg bg-surface-elevated p-5 shadow-dialog">
          <AlertDialog.Title className="text-lg font-semibold">{title}</AlertDialog.Title>
          <AlertDialog.Description asChild>
            <div className="mt-1.5 text-base text-text-secondary">{description}</div>
          </AlertDialog.Description>
          <form
            className="mt-4 grid gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (phraseOk && reasonOk && !loading) onConfirm(reason.trim());
            }}
          >
            {reasonLabel && (
              <Field label={reasonLabel} required={reasonRequired}>
                <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
              </Field>
            )}
            {confirmPhrase && (
              <Field
                label={
                  <>
                    Type <span className="font-mono text-text-primary">{confirmPhrase}</span> to
                    confirm
                  </>
                }
              >
                <Input
                  autoComplete="off"
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                />
              </Field>
            )}
            {error && (
              <p role="alert" className="rounded bg-danger-soft px-3 py-2 text-sm text-danger">
                {error}
              </p>
            )}
            <div className="mt-1 flex justify-end gap-2">
              <AlertDialog.Cancel asChild>
                <Button disabled={loading}>Cancel</Button>
              </AlertDialog.Cancel>
              <Button
                type="submit"
                variant={tone === 'danger' ? 'danger' : 'primary'}
                loading={loading}
                disabled={!phraseOk || !reasonOk}
              >
                {confirmLabel}
              </Button>
            </div>
          </form>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
