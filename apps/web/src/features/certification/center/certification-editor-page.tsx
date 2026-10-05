import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Archive, CirclePlay } from 'lucide-react';
import {
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Notice,
  PageHeader,
  Skeleton,
  toast,
} from '@/components/ui';
import { RequirePermission } from '@/app/guards';
import { UnsavedBar } from '@/app/shell/unsaved-bar';
import { useMe, usePermissions } from '@/features/auth/session';
import { ApiError, errorMessage } from '@/lib/api/errors';
import {
  useActivateDefinition,
  useArchiveDefinition,
  useCertificationSettings,
  useCreateDefinition,
  useDefinition,
  useUpdateDefinition,
} from '../api';
import { CertificationFormSections } from '../certification-form';
import {
  changedFields,
  emptyValues,
  fieldForPath,
  fromDetail,
  requestOf,
  validateForm,
  type DefinitionFormValues,
} from '../definition-form';
import { DefinitionStatusText } from '../status';
import type { CertificationDetail } from '../types';
import { useUnsavedGuard } from '../unsaved-guard';
import { CENTER_ROOT } from './nav';

type Errors = Record<string, string>;

/** Keys of the form whose server-side error clears when the person edits the field. */
function clearedBy(patchKeys: string[]): string[] {
  const keys = [...patchKeys];
  if (keys.includes('signatory1') || keys.includes('signatory2')) keys.push('signatories');
  return keys;
}

function useDefinitionForm(initial: DefinitionFormValues) {
  const [values, setValues] = useState(initial);
  const [serverErrors, setServerErrors] = useState<Errors>({});
  const [showProblems, setShowProblems] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const dirty = JSON.stringify(values) !== JSON.stringify(initial);
  const local = useMemo(() => validateForm(values), [values]);

  const patch = (p: Partial<DefinitionFormValues>) => {
    setValues((v) => ({ ...v, ...p }));
    const cleared = clearedBy(Object.keys(p));
    setServerErrors((e) => {
      if (!cleared.some((k) => k in e || Object.keys(e).some((x) => x.startsWith(`${k}.`))))
        return e;
      return Object.fromEntries(
        Object.entries(e).filter(([k]) => !cleared.some((c) => k === c || k.startsWith(`${c}.`))),
      );
    });
  };

  /** Show the API's field messages next to the fields; returns text for anything not tied to a field. */
  const applyApiError = (err: unknown): string | null => {
    if (!(err instanceof ApiError)) return errorMessage(err);
    const next: Errors = {};
    for (const f of err.fields) next[fieldForPath(f.path.split('.'))] ??= f.message;
    setServerErrors(next);
    return err.fields.length === 0 || Object.keys(next).length === 0 ? err.message : null;
  };

  const errors: Errors = showProblems ? { ...local.errors, ...serverErrors } : serverErrors;
  return {
    values,
    patch,
    errors,
    local,
    dirty,
    showProblems,
    setShowProblems,
    formError,
    setFormError,
    applyApiError,
    setValues,
  };
}

// ------------------------------------------------------------------ create

function CreateCertification() {
  const navigate = useNavigate();
  const me = useMe();
  const settings = useCertificationSettings();
  const create = useCreateDefinition();
  const initial = useMemo(() => emptyValues(me.data?.user.organizationName ?? ''), [me.data]);
  const form = useDefinitionForm(initial);
  const guard = useUnsavedGuard(form.dirty);

  const submit = () => {
    form.setFormError(null);
    if (!form.local.request) {
      form.setShowProblems(true);
      toast.error('Some fields need attention', 'The first one is marked below.');
      return;
    }
    create.mutate(form.local.request, {
      onSuccess: (created) => {
        guard.markClean();
        toast.success(`${created.name} created as a draft`);
        navigate(`${CENTER_ROOT}/certifications/${created.id}`, { replace: true });
      },
      onError: (err) => form.setFormError(form.applyApiError(err)),
    });
  };

  return (
    <>
      <PageHeader
        breadcrumbs={[
          { label: 'Certification center', to: CENTER_ROOT },
          { label: 'Certifications', to: `${CENTER_ROOT}/certifications` },
          { label: 'New' },
        ]}
        title="New certification"
        description="Start with the details and requirements. It stays a draft until you activate it."
      />
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <CertificationFormSections
          values={form.values}
          patch={form.patch}
          errors={form.errors}
          showProblems={form.showProblems}
          readOnly={false}
          active={false}
          canEditTemplates={false}
          organizationCode={settings.data?.organizationCode ?? null}
        />
        {form.formError && (
          <p role="alert" className="mb-4 rounded bg-danger-soft px-3 py-2 text-sm text-danger">
            {form.formError}
          </p>
        )}
        <div className="flex gap-2 pb-8">
          <Button type="submit" variant="primary" loading={create.isPending}>
            Create certification
          </Button>
          <Button asChild>
            <Link to={`${CENTER_ROOT}/certifications`}>Cancel</Link>
          </Button>
        </div>
      </form>
      {guard.dialog}
    </>
  );
}

// ------------------------------------------------------------------ edit

function EditCertification({ detail }: { detail: CertificationDetail }) {
  const permissions = usePermissions();
  const settings = useCertificationSettings();
  const update = useUpdateDefinition(detail.id);
  const activate = useActivateDefinition(detail.id);
  const archive = useArchiveDefinition(detail.id);
  const initial = useMemo(() => fromDetail(detail), [detail]);
  const baseline = useMemo(() => requestOf(detail), [detail]);
  const form = useDefinitionForm(initial);
  const guard = useUnsavedGuard(form.dirty);
  const [confirm, setConfirm] = useState<'activate' | 'archive' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const canUpdate = permissions.has('certifications.update');
  const archived = detail.status === 'archived';
  const readOnly = !canUpdate || archived;
  const active = detail.status === 'active';

  const save = () => {
    form.setFormError(null);
    const request = form.local.request;
    if (!request) {
      form.setShowProblems(true);
      toast.error('Some fields need attention', 'The first one is marked below.');
      return;
    }
    const body = baseline ? changedFields(baseline, request) : request;
    if (Object.keys(body).length === 0) {
      toast.info('There is nothing new to save');
      return;
    }
    update.mutate(body, {
      onSuccess: () => {
        guard.markClean();
        toast.success('Changes saved');
      },
      onError: (err) => form.setFormError(form.applyApiError(err)),
    });
  };

  const run = (kind: 'activate' | 'archive') => {
    setActionError(null);
    const mutation = kind === 'activate' ? activate : archive;
    mutation.mutate(undefined, {
      onSuccess: () => {
        setConfirm(null);
        toast.success(
          kind === 'activate' ? `${detail.name} is now active` : `${detail.name} was archived`,
        );
      },
      onError: (err) => setActionError(errorMessage(err)),
    });
  };

  return (
    <>
      <PageHeader
        breadcrumbs={[
          { label: 'Certification center', to: CENTER_ROOT },
          { label: 'Certifications', to: `${CENTER_ROOT}/certifications` },
          { label: detail.name },
        ]}
        title={detail.name}
        meta={
          <>
            <DefinitionStatusText status={detail.status} />
            <span className="font-mono">{detail.code}</span>
            <span>
              {detail.counts.active} active · {detail.counts.inProgress} in progress
            </span>
          </>
        }
        actions={
          canUpdate && !archived ? (
            <>
              {detail.status === 'draft' && (
                <Button
                  variant="primary"
                  leading={<CirclePlay className="size-4" />}
                  disabled={form.dirty}
                  title={form.dirty ? 'Save your changes first' : undefined}
                  onClick={() => {
                    setActionError(null);
                    setConfirm('activate');
                  }}
                >
                  Activate
                </Button>
              )}
              <Button
                leading={<Archive className="size-4" />}
                onClick={() => {
                  setActionError(null);
                  setConfirm('archive');
                }}
              >
                Archive
              </Button>
            </>
          ) : null
        }
      />
      {archived && (
        <Notice
          tone="information"
          title="This certification is archived"
          className="mb-6 max-w-3xl"
        >
          Archived certifications cannot be edited or activated again. Certificates already issued
          stay valid until they expire or are revoked.
        </Notice>
      )}
      {!canUpdate && !archived && (
        <Notice tone="information" className="mb-6 max-w-3xl">
          You can view this certification but not change it.
        </Notice>
      )}
      {detail.status === 'draft' && canUpdate && (
        <Notice tone="information" title="Draft" className="mb-6 max-w-3xl">
          Nothing is issued while a certification is a draft. Activate it once it has requirements,
          a template and any signatures it needs.
        </Notice>
      )}

      <form
        noValidate
        className="pb-24"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <CertificationFormSections
          values={form.values}
          patch={form.patch}
          errors={form.errors}
          showProblems={form.showProblems}
          readOnly={readOnly}
          detail={detail}
          active={active}
          canEditTemplates={permissions.has('certificate_templates.view')}
          organizationCode={settings.data?.organizationCode ?? null}
        />
      </form>

      {form.dirty && !readOnly && (
        <UnsavedBar
          actions={
            <>
              <Button
                onClick={() => {
                  form.setValues(initial);
                  form.setFormError(null);
                  form.setShowProblems(false);
                }}
                disabled={update.isPending}
              >
                Discard
              </Button>
              <Button variant="primary" loading={update.isPending} onClick={save}>
                Save changes
              </Button>
            </>
          }
        >
          {form.formError ? (
            <span role="alert" className="font-medium text-danger">
              {form.formError}
            </span>
          ) : (
            'You have unsaved changes.'
          )}
        </UnsavedBar>
      )}

      <ConfirmDialog
        open={confirm === 'activate'}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={`Activate ${detail.name}?`}
        description="People are evaluated against the requirements right away. Anyone who already qualifies receives a certificate (or an approval request) without further action."
        confirmLabel="Activate"
        loading={activate.isPending}
        error={actionError}
        onConfirm={() => run('activate')}
      />
      <ConfirmDialog
        open={confirm === 'archive'}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={`Archive ${detail.name}?`}
        description="No new certificates are issued and pending approvals are cancelled. Certificates already issued stay valid until they expire or are revoked. This cannot be undone."
        confirmLabel="Archive certification"
        tone="danger"
        confirmPhrase={detail.code}
        loading={archive.isPending}
        error={actionError}
        onConfirm={() => run('archive')}
      />
      {guard.dialog}
    </>
  );
}

function EditLoader({ id }: { id: string }) {
  const definition = useDefinition(id);
  if (definition.isPending) {
    return (
      <div aria-busy="true" aria-label="Loading certification" className="grid gap-4">
        <Skeleton className="h-8 w-72" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (definition.isError) {
    if (definition.error instanceof ApiError && definition.error.isNotFound) {
      return (
        <EmptyState
          title="Certification not found"
          description="It may have been removed, or it belongs to another organization."
          action={
            <Button asChild variant="primary">
              <Link to={`${CENTER_ROOT}/certifications`}>Back to certifications</Link>
            </Button>
          }
        />
      );
    }
    return (
      <ErrorState message={errorMessage(definition.error)} onRetry={() => definition.refetch()} />
    );
  }
  // Remount when the saved revision changes so the form starts from the saved values.
  return (
    <EditCertification
      key={`${definition.data.id}-${definition.data.revision}`}
      detail={definition.data}
    />
  );
}

export function CertificationEditorPage() {
  const { id = '' } = useParams();
  const creating = id === 'new';
  return (
    <RequirePermission any={creating ? ['certifications.create'] : ['certifications.view']}>
      {creating ? <CreateCertification /> : <EditLoader id={id} />}
    </RequirePermission>
  );
}
