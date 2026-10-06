import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import {
  Copy,
  Download,
  Ellipsis,
  FileText,
  Pencil,
  RefreshCw,
  Save,
  Star,
  Archive,
  Users,
} from 'lucide-react';
import {
  Button,
  ConfirmDialog,
  DialogContent,
  DialogRoot,
  EmptyState,
  ErrorState,
  Field,
  MenuContent,
  MenuItem,
  MenuRoot,
  MenuSeparator,
  MenuTrigger,
  Notice,
  PageHeader,
  Skeleton,
  Switch,
  TabsContent,
  TabsList,
  TabsRoot,
  Tag,
  Textarea,
  toast,
} from '@/components/ui';
import { RequirePermission } from '@/app/guards';
import { usePermissions } from '@/features/auth/session';
import { api } from '@/lib/api/client';
import { ApiError, errorMessage } from '@/lib/api/errors';
import { certification as c } from '@a5/contracts';
import {
  useArchiveTemplate,
  usePreviewTemplate,
  useSaveTemplateDesign,
  useSetDefaultTemplate,
  useTemplate,
} from '../api';
import { CertificatePreview } from '../certificate-preview';
import {
  addElement,
  designIssues,
  duplicateElement,
  moveElement,
  newElement,
  nudgeElement,
  removeElement,
  reorderElement,
  updateElement,
  type NewElementKind,
} from '../design-model';
import { ElementList, ElementProperties, PageThemePanel, VersionsPanel } from '../designer-panels';
import {
  FALLBACK_SOURCES,
  buildPreviewModel,
  imageFingerprint,
  sourcesFromPreview,
  type PreviewSources,
} from '../template-preview';
import { AssignTemplateDialog, NameTemplateDialog } from '../template-dialogs';
import type {
  CertificationAsset,
  DesignElement,
  TemplateDesign,
  TemplateDetail,
  TemplatePreview,
  TemplateVersion,
  TemplateVersionDetail,
} from '../types';
import { useUnsavedGuard } from '../unsaved-guard';
import { CENTER_ROOT } from './nav';

type Dialog = 'rename' | 'clone' | 'assign' | 'archive' | 'default' | null;

interface PreviewState {
  data: TemplatePreview;
  /** The design that was sent, to resolve element ids back to design elements. */
  design: TemplateDesign;
  key: string;
}

function Designer({ template }: { template: TemplateDetail }) {
  const permissions = usePermissions();
  const canEdit = permissions.has('certificate_templates.update') && template.status === 'active';
  const canClone = permissions.has('certificate_templates.create');
  const canAssign = canEdit && permissions.has('certifications.update');

  const [design, setDesign] = useState<TemplateDesign>(template.design);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [uploaded, setUploaded] = useState<Record<string, string>>({});
  const [showSafe, setShowSafe] = useState(false);
  const [tab, setTab] = useState('design');
  const [dialog, setDialog] = useState<Dialog>(null);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState('');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const save = useSaveTemplateDesign(template.id);
  const archive = useArchiveTemplate(template.id);
  const makeDefault = useSetDefaultTemplate(template.id);
  const previewRequest = usePreviewTemplate(template.id);

  const serialized = JSON.stringify(design);
  const dirty = serialized !== JSON.stringify(template.design);
  const guard = useUnsavedGuard(dirty);
  const issues = useMemo(() => designIssues(design), [design]);
  const valid = issues.count === 0;

  // ---- server sample (values, images, PDF)
  const latest = useRef({ design, valid });
  latest.current = { design, valid };
  const requestPreview = () => {
    const { design: sent, valid: ok } = latest.current;
    if (!ok) return;
    previewRequest.mutate(
      { design: sent },
      {
        onSuccess: (data) => {
          setPreview({ data, design: sent, key: JSON.stringify(sent) });
          setPreviewError(null);
        },
        onError: (err) => setPreviewError(errorMessage(err)),
      },
    );
  };
  const fingerprint = useMemo(() => imageFingerprint(design), [design]);
  const firstRender = useRef(true);
  useEffect(() => {
    const timer = window.setTimeout(requestPreview, firstRender.current ? 0 : 700);
    firstRender.current = false;
    return () => window.clearTimeout(timer);
    // The sample is refreshed when the images it must resolve change, not on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fingerprint]);

  const sources: PreviewSources = useMemo(() => {
    const base = preview ? sourcesFromPreview(preview.data, preview.design) : FALLBACK_SOURCES;
    return { ...base, assetUrls: { ...base.assetUrls, ...uploaded } };
  }, [preview, uploaded]);
  const model = useMemo(() => buildPreviewModel(design, sources), [design, sources]);
  const pdfStale = preview ? preview.key !== serialized : false;

  const selected = design.elements.find((e) => e.id === selectedId) ?? null;
  const customKeys = c.customPlaceholdersOf(design);
  const registerAsset = (asset: CertificationAsset) =>
    setUploaded((u) => ({ ...u, [asset.id]: asset.previewUrl }));
  const edit = (fn: (d: TemplateDesign) => TemplateDesign) => {
    if (canEdit) setDesign(fn);
  };

  const firstProblemId = [...issues.byElement.keys()][0];

  const loadVersion = async (v: TemplateVersion) => {
    setRestoring(v.id);
    try {
      const detail = await api.get<TemplateVersionDetail>(
        `/certificate-templates/${template.id}/versions/${v.id}`,
      );
      setDesign(detail.design);
      setSelectedId(null);
      setTab('design');
      toast.info(`Version ${v.version} loaded`, 'Save to make it the current version.');
    } catch (err) {
      toast.error('Could not load that version', errorMessage(err));
    } finally {
      setRestoring(null);
    }
  };

  const submitSave = () => {
    setSaveError(null);
    save.mutate(
      { design, changeNote: note.trim() || null },
      {
        onSuccess: (saved) => {
          guard.markClean();
          setSaving(false);
          toast.success(`Saved as version ${saved.currentVersion}`);
        },
        onError: (err) => setSaveError(errorMessage(err)),
      },
    );
  };

  const runDialog = (kind: 'archive' | 'default') => {
    setDialogError(null);
    const mutation = kind === 'archive' ? archive : makeDefault;
    mutation.mutate(undefined, {
      onSuccess: () => {
        setDialog(null);
        toast.success(
          kind === 'archive' ? 'Template archived' : `${template.name} is now the default`,
        );
      },
      onError: (err) => setDialogError(errorMessage(err)),
    });
  };

  const hasMenu = canEdit || canClone;
  return (
    <>
      <PageHeader
        breadcrumbs={[
          { label: 'Certification center', to: CENTER_ROOT },
          { label: 'Templates', to: `${CENTER_ROOT}/templates` },
          { label: template.name },
        ]}
        title={template.name}
        meta={
          <>
            <span>Version {template.currentVersion}</span>
            {template.isDefault && <Tag tone="accent">Default</Tag>}
            {template.status === 'archived' && <Tag>Archived</Tag>}
            <span>
              {template.usedBy.length > 0
                ? `Used by ${template.usedBy.map((u) => u.name).join(', ')}`
                : 'Not assigned to a certification'}
            </span>
          </>
        }
        actions={
          <>
            {canEdit && (
              <Button
                variant="primary"
                leading={<Save className="size-4" />}
                disabled={!dirty || !valid}
                title={
                  !valid ? 'Fix the problems first' : !dirty ? 'No changes to save' : undefined
                }
                onClick={() => {
                  setSaveError(null);
                  setSaving(true);
                }}
              >
                Save version
              </Button>
            )}
            <Button
              leading={<FileText className="size-4" />}
              onClick={() => {
                setTab('pdf');
                if (!preview || pdfStale) requestPreview();
              }}
            >
              Sample PDF
            </Button>
            {hasMenu && (
              <MenuRoot>
                <MenuTrigger asChild>
                  <Button aria-label="More actions" leading={<Ellipsis className="size-4" />}>
                    More
                  </Button>
                </MenuTrigger>
                <MenuContent>
                  {canEdit && (
                    <MenuItem
                      icon={<Pencil className="size-4" />}
                      onSelect={() => setDialog('rename')}
                    >
                      Rename
                    </MenuItem>
                  )}
                  {canClone && (
                    <MenuItem
                      icon={<Copy className="size-4" />}
                      onSelect={() => setDialog('clone')}
                    >
                      Clone
                    </MenuItem>
                  )}
                  {canAssign && (
                    <MenuItem
                      icon={<Users className="size-4" />}
                      onSelect={() => setDialog('assign')}
                    >
                      Use for certifications
                    </MenuItem>
                  )}
                  {canEdit && !template.isDefault && (
                    <MenuItem
                      icon={<Star className="size-4" />}
                      onSelect={() => setDialog('default')}
                    >
                      Make default
                    </MenuItem>
                  )}
                  {canEdit && (
                    <>
                      <MenuSeparator />
                      <MenuItem
                        tone="danger"
                        icon={<Archive className="size-4" />}
                        onSelect={() => setDialog('archive')}
                      >
                        Archive
                      </MenuItem>
                    </>
                  )}
                </MenuContent>
              </MenuRoot>
            )}
          </>
        }
      />
      {template.status === 'archived' && (
        <Notice tone="information" title="This template is archived" className="mb-4 max-w-3xl">
          Archived templates cannot be edited. Clone it to start a new design.
        </Notice>
      )}
      {template.status === 'active' && !canEdit && (
        <Notice tone="information" className="mb-4 max-w-3xl">
          You can look at this template but not change it.
        </Notice>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px] lg:items-start">
        <div className="min-w-0 lg:sticky lg:top-4">
          <CertificatePreview
            model={model}
            interactive={canEdit}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onMove={(id, x, y) => edit((d) => moveElement(d, id, x, y))}
            onNudge={(id, dx, dy, mode) => edit((d) => nudgeElement(d, id, dx, dy, mode))}
            showSafeArea={showSafe}
            label={`Preview of ${template.name}`}
          />
          <div className="mt-3 flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
            <div className="flex items-center gap-2">
              <Switch
                id="safe-area"
                aria-labelledby="safe-area-label"
                checked={showSafe}
                onCheckedChange={setShowSafe}
              />
              <label id="safe-area-label" htmlFor="safe-area" className="text-sm">
                Show printable area
              </label>
            </div>
            {canEdit && (
              <p className="text-xs text-text-secondary">
                Drag an element, or select it and use the arrow keys. Shift moves faster, Alt
                resizes.
              </p>
            )}
          </div>
          <p className="mt-2 text-xs text-text-secondary">
            Sample names and numbers are fictional. Text that does not fit its box is shrunk in the
            PDF, so check the sample PDF before saving.
          </p>
        </div>

        <div className="min-w-0">
          {!valid && (
            <Notice
              tone="warning"
              title={`${issues.count} ${issues.count === 1 ? 'problem' : 'problems'} to fix before saving`}
              className="mb-4"
              action={
                firstProblemId ? (
                  <Button
                    size="sm"
                    onClick={() => {
                      setSelectedId(firstProblemId);
                      setTab('design');
                    }}
                  >
                    Show first
                  </Button>
                ) : undefined
              }
            >
              {issues.general.length > 0 && (
                <ul className="list-disc pl-5">
                  {issues.general.map((m) => (
                    <li key={m}>{m}</li>
                  ))}
                </ul>
              )}
            </Notice>
          )}
          {preview && preview.data.warnings.length > 0 && (
            <Notice tone="warning" title="Heads up from the sample render" className="mb-4">
              <ul className="list-disc pl-5">
                {preview.data.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </Notice>
          )}

          <TabsRoot value={tab} onValueChange={setTab}>
            <TabsList
              items={[
                { value: 'design', label: 'Design' },
                { value: 'page', label: 'Page' },
                { value: 'versions', label: 'Versions' },
                { value: 'pdf', label: 'Sample PDF' },
              ]}
            />
            <TabsContent value="design" className="grid gap-6 pt-4">
              <ElementList
                design={design}
                selectedId={selectedId}
                issues={issues}
                readOnly={!canEdit}
                onSelect={setSelectedId}
                onAdd={(kind: NewElementKind) => {
                  const el = newElement(kind, design.elements);
                  edit((d) => addElement(d, el));
                  setSelectedId(el.id);
                }}
                onReorder={(id, dir) => edit((d) => reorderElement(d, id, dir))}
                onDuplicate={(id) => {
                  const next = duplicateElement(design, id);
                  edit(() => next.design);
                  if (next.id) setSelectedId(next.id);
                }}
                onRemove={(id) => {
                  edit((d) => removeElement(d, id));
                  setSelectedId(null);
                }}
              />
              {selected ? (
                <div className="border-t border-divider pt-5">
                  <ElementProperties
                    key={selected.id}
                    element={selected}
                    problems={issues.byElement.get(selected.id) ?? []}
                    customKeys={customKeys}
                    readOnly={!canEdit}
                    onAsset={registerAsset}
                    onChange={(patch: Partial<DesignElement>) =>
                      edit((d) => updateElement(d, selected.id, patch))
                    }
                  />
                </div>
              ) : (
                <p className="text-sm text-text-secondary">
                  Select an element on the page or in the list to change its text, position and
                  style.
                </p>
              )}
            </TabsContent>
            <TabsContent value="page" className="pt-4">
              <PageThemePanel
                design={design}
                readOnly={!canEdit}
                onChange={(next) => edit(() => next)}
                onAsset={registerAsset}
                backgroundUrl={model.backgroundImageUrl}
              />
            </TabsContent>
            <TabsContent value="versions" className="pt-4">
              <VersionsPanel
                templateId={template.id}
                currentVersion={template.currentVersion}
                onRestore={(v) => void loadVersion(v)}
                restoring={restoring}
                readOnly={!canEdit}
              />
            </TabsContent>
            <TabsContent value="pdf" className="grid gap-3 pt-4">
              <p className="text-sm text-text-secondary">
                A real PDF rendered by the same engine that prints certificates, with sample data
                and a PREVIEW watermark.
              </p>
              {previewError && (
                <p role="alert" className="rounded bg-danger-soft px-3 py-2 text-sm text-danger">
                  {previewError}
                </p>
              )}
              {!valid && (
                <p className="text-sm text-warning">Fix the design problems to render a sample.</p>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  leading={<RefreshCw className="size-4" />}
                  loading={previewRequest.isPending}
                  disabled={!valid}
                  onClick={requestPreview}
                >
                  {pdfStale ? 'Update sample PDF' : 'Refresh sample PDF'}
                </Button>
                {preview && (
                  <Button asChild variant="primary">
                    <a href={preview.data.pdfUrl} download="certificate-preview.pdf">
                      <Download aria-hidden className="size-4" />
                      Download sample PDF
                    </a>
                  </Button>
                )}
              </div>
              {pdfStale && (
                <p className="text-sm text-warning">
                  The last sample shows the design as of the previous refresh, not your latest
                  changes. Update it before downloading.
                </p>
              )}
              {preview && (
                <p className="text-xs text-text-secondary">
                  The download link expires after a short time. Refresh the sample to get a new one.
                </p>
              )}
              {!preview && previewRequest.isPending && <Skeleton className="h-10 w-48" />}
            </TabsContent>
          </TabsRoot>
        </div>
      </div>

      <DialogRoot open={saving} onOpenChange={(o) => !save.isPending && setSaving(o)}>
        <DialogContent
          size="sm"
          title="Save as a new version"
          description={`Version ${template.currentVersion + 1} becomes the design used for new certificates.`}
          dismissible={!save.isPending}
          footer={
            <>
              <Button onClick={() => setSaving(false)} disabled={save.isPending}>
                Cancel
              </Button>
              <Button variant="primary" loading={save.isPending} onClick={submitSave}>
                Save version
              </Button>
            </>
          }
        >
          <Field label="What changed" optional hint="Shown in the version history.">
            <Textarea
              rows={3}
              maxLength={300}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </Field>
          {saveError && (
            <p role="alert" className="mt-3 rounded bg-danger-soft px-3 py-2 text-sm text-danger">
              {saveError}
            </p>
          )}
        </DialogContent>
      </DialogRoot>

      {(dialog === 'rename' || dialog === 'clone') && (
        <NameTemplateDialog
          template={template}
          mode={dialog}
          open
          onOpenChange={(o) => !o && setDialog(null)}
        />
      )}
      {dialog === 'assign' && (
        <AssignTemplateDialog
          template={template}
          open
          onOpenChange={(o) => !o && setDialog(null)}
        />
      )}
      <ConfirmDialog
        open={dialog === 'archive'}
        onOpenChange={(o) => !o && setDialog(null)}
        title={`Archive ${template.name}?`}
        description="It can no longer be edited or assigned. Certificates already issued keep their copy of the design."
        confirmLabel="Archive template"
        tone="danger"
        loading={archive.isPending}
        error={dialogError}
        onConfirm={() => runDialog('archive')}
      />
      <ConfirmDialog
        open={dialog === 'default'}
        onOpenChange={(o) => !o && setDialog(null)}
        title={`Make ${template.name} the default?`}
        description="New certifications start with the default template."
        confirmLabel="Make default"
        loading={makeDefault.isPending}
        error={dialogError}
        onConfirm={() => runDialog('default')}
      />
      {guard.dialog}
    </>
  );
}

function TemplateLoader({ id }: { id: string }) {
  const template = useTemplate(id);
  if (template.isPending) {
    return (
      <div aria-busy="true" aria-label="Loading template" className="grid gap-4">
        <Skeleton className="h-8 w-72" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }
  if (template.isError) {
    if (template.error instanceof ApiError && template.error.isNotFound) {
      return (
        <EmptyState
          title="Template not found"
          description="It may have been removed, or it belongs to another organization."
          action={
            <Button asChild variant="primary">
              <Link to={`${CENTER_ROOT}/templates`}>Back to templates</Link>
            </Button>
          }
        />
      );
    }
    return <ErrorState message={errorMessage(template.error)} onRetry={() => template.refetch()} />;
  }
  return (
    <Designer
      key={`${template.data.id}-${template.data.currentVersion}`}
      template={template.data}
    />
  );
}

export function TemplateDesignerPage() {
  const { id = '' } = useParams();
  return (
    <RequirePermission all={['certificate_templates.view']}>
      <TemplateLoader id={id} />
    </RequirePermission>
  );
}
