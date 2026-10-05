import { useState } from 'react';
import { learning } from '@a5/contracts';
import { Button, DialogContent, DialogRoot, Field, Textarea, toast } from '@/components/ui';
import { ApiError, errorMessage } from '@/lib/api/errors';
import { pluralize } from '@/lib/format';
import { usePublishProgram } from './api';
import { boundsOf } from './schema-bounds';

/** Counts of items that differ from what learners currently see. */
export function pendingChanges(program: learning.ProgramDetail): {
  phases: number;
  modules: number;
  lessons: number;
} {
  const changed = (n: { status: learning.NodeStatus; hasUnpublishedChanges: boolean }) =>
    n.hasUnpublishedChanges || n.status === 'draft';
  const phases = program.phases.filter(changed);
  const modules = program.phases.flatMap((p) => p.modules).filter(changed);
  const lessons = program.phases
    .flatMap((p) => p.modules.flatMap((m) => m.lessons))
    .filter(changed);
  return { phases: phases.length, modules: modules.length, lessons: lessons.length };
}

/** The minimum note length is part of the contract; read it instead of repeating the number. */
const NOTE = boundsOf(learning.publishProgramRequestSchema).changeNote;
const MIN_NOTE = NOTE?.minLength ?? 1;

/**
 * Publishing makes the working copy the live version and records an immutable snapshot with the
 * change note. It is refused while the program has blocking issues.
 */
export function PublishDialog({
  program,
  open,
  onOpenChange,
}: {
  program: learning.ProgramDetail;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const publish = usePublishProgram(program.id);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const pending = pendingChanges(program);
  const first = program.publishedVersion === 0 || program.status === 'draft';
  const tooShort = note.trim().length < MIN_NOTE;
  return (
    <DialogRoot
      open={open}
      onOpenChange={(o) => {
        if (!o) setError(null);
        onOpenChange(o);
      }}
    >
      <DialogContent
        title={first ? 'Publish program' : `Publish version ${program.publishedVersion + 1}`}
        description={
          first
            ? 'Learners who are enrolled or eligible will see it straight away.'
            : 'Learners already in the program see the changes straight away. Their progress is kept.'
        }
        footer={
          <>
            <Button onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button
              variant="primary"
              loading={publish.isPending}
              disabled={tooShort || program.publishIssues.length > 0}
              onClick={async () => {
                setError(null);
                try {
                  const result = await publish.mutateAsync(note.trim());
                  toast.success(`Version ${result.version.version} is live`, result.program.title);
                  setNote('');
                  onOpenChange(false);
                } catch (err) {
                  setError(
                    err instanceof ApiError && err.fields.length
                      ? err.fields.map((f) => f.message).join(' ')
                      : errorMessage(err),
                  );
                }
              }}
            >
              Publish
            </Button>
          </>
        }
      >
        <p className="mb-4 text-sm text-text-secondary">
          Changes since the last version:{' '}
          {pending.lessons + pending.modules + pending.phases === 0
            ? 'program details only.'
            : `${pluralize(pending.lessons, 'lesson')}, ${pluralize(pending.modules, 'module')}, ${pluralize(pending.phases, program.phaseLabel.toLowerCase())}.`}
        </p>
        <Field
          label="What changed for learners?"
          required
          error={error ?? undefined}
          hint={`Kept with the version as a permanent record. At least ${MIN_NOTE} characters.`}
        >
          <Textarea
            rows={4}
            value={note}
            maxLength={2000}
            onChange={(e) => setNote(e.target.value)}
          />
        </Field>
      </DialogContent>
    </DialogRoot>
  );
}
