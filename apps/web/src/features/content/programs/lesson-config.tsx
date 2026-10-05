import { useState } from 'react';
import { learning } from '@a5/contracts';
import { Field, Input, Select, Switch, Textarea, Button } from '@/components/ui';
import { Markdown } from '@/components/markdown';
import { useMediaAsset } from '@/features/content/media/api';
import { MediaPicker } from '@/features/content/media/media-picker';
import { useAssessmentOptions, useScenarioOptions } from './api';
import { boundsOf, rangeHint, type FieldBounds } from './schema-bounds';

export type Config = Record<string, unknown>;
/** Field errors keyed by path, e.g. `config.mediaAssetId`. */
export type FieldErrors = Record<string, string>;

/** Starting config for a new lesson of this type: only what the contract itself defaults. */
export function defaultConfig(type: learning.LessonType): Config {
  const out: Config = {};
  for (const [name, b] of Object.entries(boundsOf(learning.lessonConfigSchemas[type]))) {
    if (b.default !== undefined && b.default !== null) out[name] = b.default;
  }
  return out;
}

interface Props {
  config: Config;
  set: (patch: Config) => void;
  errors: FieldErrors;
}

const err = (errors: FieldErrors, name: string) => errors[`config.${name}`];

/** Number input that stores a number (or null when empty and nullable). */
function NumberField({
  label,
  name,
  props,
  bounds,
  unit,
  hint,
  nullable,
  placeholder,
  step,
}: {
  label: string;
  name: string;
  props: Props;
  bounds?: FieldBounds;
  unit?: string;
  hint?: string;
  nullable?: boolean;
  placeholder?: string;
  step?: number | 'any';
}) {
  const value = props.config[name];
  const range = rangeHint(bounds, unit);
  return (
    <Field
      label={label}
      error={err(props.errors, name)}
      hint={[hint, range && `Allowed: ${range}`].filter(Boolean).join(' ') || undefined}
    >
      <Input
        type="number"
        inputMode="decimal"
        min={bounds?.min}
        max={bounds?.max}
        step={step ?? (bounds?.integer ? 1 : 'any')}
        placeholder={placeholder}
        value={typeof value === 'number' ? String(value) : ''}
        onChange={(e) => {
          const raw = e.target.value;
          props.set({ [name]: raw === '' ? (nullable ? null : undefined) : Number(raw) });
        }}
      />
    </Field>
  );
}

function SwitchField({
  label,
  hint,
  name,
  props,
}: {
  label: string;
  hint?: string;
  name: string;
  props: Props;
}) {
  return (
    <label className="flex items-start gap-3">
      <Switch
        className="mt-0.5"
        checked={props.config[name] === true}
        onCheckedChange={(v) => props.set({ [name]: v })}
      />
      <span>
        <span className="block text-sm font-medium">{label}</span>
        {hint && <span className="block text-xs text-text-tertiary">{hint}</span>}
      </span>
    </label>
  );
}

/** Markdown text with a write / preview switch. Raw HTML is never rendered. */
export function MarkdownField({
  label,
  value,
  onChange,
  error,
  rows = 10,
  hint,
  optional,
  required,
  maxLength,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  rows?: number;
  hint?: string;
  optional?: boolean;
  required?: boolean;
  maxLength?: number;
}) {
  const [preview, setPreview] = useState(false);
  return (
    <div className="grid gap-1.5">
      <div className="flex items-end justify-between gap-3">
        <span className="text-sm font-medium">
          {label}
          {required && (
            <span aria-hidden className="ml-0.5 text-danger">
              *
            </span>
          )}
          {optional && <span className="ml-1.5 font-normal text-text-tertiary">Optional</span>}
        </span>
        <div role="group" aria-label={`${label} view`} className="flex gap-1">
          <Button
            size="sm"
            variant={preview ? 'ghost' : 'secondary'}
            aria-pressed={!preview}
            onClick={() => setPreview(false)}
          >
            Write
          </Button>
          <Button
            size="sm"
            variant={preview ? 'secondary' : 'ghost'}
            aria-pressed={preview}
            onClick={() => setPreview(true)}
          >
            Preview
          </Button>
        </div>
      </div>
      {preview ? (
        <div className="min-h-[120px] rounded border border-border bg-surface px-4 py-3">
          {value.trim() ? (
            <Markdown>{value}</Markdown>
          ) : (
            <p className="text-sm text-text-tertiary">Nothing to preview yet.</p>
          )}
        </div>
      ) : (
        <Textarea
          aria-label={label}
          rows={rows}
          value={value}
          maxLength={maxLength}
          aria-invalid={error ? true : undefined}
          className="font-mono text-sm"
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {hint && !error && <p className="text-xs text-text-tertiary">{hint}</p>}
      {error && (
        <p role="alert" className="text-xs font-medium text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

function VideoFields(props: Props & { minutes: number; setMinutes: (m: number) => void }) {
  const b = boundsOf(learning.lessonConfigSchemas.video);
  const id = typeof props.config.mediaAssetId === 'string' ? props.config.mediaAssetId : null;
  const asset = useMediaAsset(id);
  const length = asset.data?.durationSeconds
    ? Math.max(1, Math.ceil(asset.data.durationSeconds / 60))
    : null;
  return (
    <>
      <Field label="Video" required error={err(props.errors, 'mediaAssetId')}>
        <MediaPicker
          kind="video"
          value={id}
          invalid={Boolean(err(props.errors, 'mediaAssetId'))}
          onChange={(v) => props.set({ mediaAssetId: v ?? undefined })}
        />
      </Field>
      {length !== null && props.minutes !== length && (
        <p className="text-sm text-text-secondary">
          The video is {length} {length === 1 ? 'minute' : 'minutes'} long.{' '}
          <button
            type="button"
            className="text-information underline"
            onClick={() => props.setMinutes(length)}
          >
            Use that as the estimated time
          </button>
        </p>
      )}
      <NumberField
        label="Minimum watched to finish"
        name="minWatchPercent"
        props={props}
        bounds={b.minWatchPercent}
        unit="%"
        nullable
        placeholder="Program default"
        hint="Leave empty to use the program's default."
      />
      <NumberField
        label="Fastest playback speed that counts"
        name="maxCreditedPlaybackRate"
        props={props}
        bounds={b.maxCreditedPlaybackRate}
        unit="×"
        step={0.25}
        hint="Watching faster than this earns no extra credit."
      />
      <SwitchField
        name="allowSkipping"
        props={props}
        label="Allow skipping ahead"
        hint="When off, learners cannot jump past what they have watched."
      />
      <Field label="Finishing" error={err(props.errors, 'completion')}>
        <Select
          value={props.config.completion === 'manual' ? 'manual' : 'auto'}
          onChange={(e) => props.set({ completion: e.target.value })}
        >
          <option value="auto">Complete automatically at the minimum</option>
          <option value="manual">Learner confirms once the minimum is reached</option>
        </Select>
      </Field>
    </>
  );
}

function DocumentFields(props: Props) {
  const id = typeof props.config.mediaAssetId === 'string' ? props.config.mediaAssetId : null;
  return (
    <>
      <Field label="File" required error={err(props.errors, 'mediaAssetId')}>
        <MediaPicker
          kind="document"
          value={id}
          invalid={Boolean(err(props.errors, 'mediaAssetId'))}
          onChange={(v) => props.set({ mediaAssetId: v ?? undefined })}
        />
      </Field>
      <SwitchField
        name="allowDownload"
        props={props}
        label="Allow download"
        hint="Learners can always read it in the page; this adds a download button."
      />
    </>
  );
}

function ExternalFields(props: Props) {
  const str = (n: string) =>
    typeof props.config[n] === 'string' ? (props.config[n] as string) : '';
  return (
    <>
      <Field
        label="Address"
        required
        error={err(props.errors, 'url')}
        hint="A full web address starting with https://"
      >
        <Input type="url" value={str('url')} onChange={(e) => props.set({ url: e.target.value })} />
      </Field>
      <Field label="Link text" optional error={err(props.errors, 'linkLabel')}>
        <Input
          value={str('linkLabel')}
          maxLength={120}
          onChange={(e) => props.set({ linkLabel: e.target.value || null })}
        />
      </Field>
      <SwitchField name="openInNewTab" props={props} label="Open in a new tab" />
    </>
  );
}

function AssessmentFields(props: Props) {
  const options = useAssessmentOptions();
  const value = typeof props.config.assessmentId === 'string' ? props.config.assessmentId : '';
  return (
    <Field
      label="Assessment"
      required
      error={err(props.errors, 'assessmentId')}
      hint="The lesson completes when the learner passes this assessment."
    >
      {options.data ? (
        <Select
          value={value}
          onChange={(e) => props.set({ assessmentId: e.target.value || undefined })}
        >
          <option value="">Choose a published assessment…</option>
          {options.data.items.map((a) => (
            <option key={a.id} value={a.id}>
              {a.title} · {a.kind} · pass at {a.passingPercent}%
            </option>
          ))}
          {value && !options.data.items.some((a) => a.id === value) && (
            <option value={value}>Unavailable assessment</option>
          )}
        </Select>
      ) : (
        <Input
          value={value}
          placeholder="Assessment ID"
          disabled={options.isPending && options.fetchStatus !== 'idle'}
          onChange={(e) => props.set({ assessmentId: e.target.value.trim() || undefined })}
        />
      )}
    </Field>
  );
}

function ScenarioFields(props: Props) {
  const b = boundsOf(learning.lessonConfigSchemas.ai_simulation);
  const options = useScenarioOptions();
  const value = typeof props.config.scenarioId === 'string' ? props.config.scenarioId : '';
  const picked = options.data?.items.find((s) => s.id === value);
  return (
    <>
      <Field label="AI scenario" required error={err(props.errors, 'scenarioId')}>
        {options.data ? (
          <Select
            value={value}
            onChange={(e) => {
              const s = options.data.items.find((x) => x.id === e.target.value);
              props.set({
                scenarioId: e.target.value || undefined,
                ...(s && props.config.minScore === undefined ? { minScore: s.passingScore } : {}),
              });
            }}
          >
            <option value="">Choose a published scenario…</option>
            {options.data.items.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title} · {s.category} · {s.difficulty}
              </option>
            ))}
            {value && !picked && <option value={value}>Unavailable scenario</option>}
          </Select>
        ) : (
          <Input
            value={value}
            placeholder="Scenario ID"
            onChange={(e) => props.set({ scenarioId: e.target.value.trim() || undefined })}
          />
        )}
      </Field>
      <NumberField
        label="Score needed to finish"
        name="minScore"
        props={props}
        bounds={b.minScore}
        hint={picked ? `The scenario's own pass score is ${picked.passingScore}.` : undefined}
      />
    </>
  );
}

function TextFields({
  props,
  name,
  label,
  rows,
  required,
  hint,
  max,
}: {
  props: Props;
  name: string;
  label: string;
  rows?: number;
  required?: boolean;
  hint?: string;
  max: number;
}) {
  return (
    <MarkdownField
      label={label}
      required={required}
      rows={rows}
      hint={hint}
      maxLength={max}
      value={typeof props.config[name] === 'string' ? (props.config[name] as string) : ''}
      onChange={(v) => props.set({ [name]: v })}
      error={err(props.errors, name)}
    />
  );
}

/** Type-specific fields. Limits and defaults come from the contract's per-type config schemas. */
export function ConfigFields({
  type,
  config,
  set,
  errors,
  minutes,
  setMinutes,
}: {
  type: learning.LessonType;
  config: Config;
  set: (patch: Config) => void;
  errors: FieldErrors;
  minutes: number;
  setMinutes: (m: number) => void;
}) {
  const props: Props = { config, set, errors };
  switch (type) {
    case 'video':
      return <VideoFields {...props} minutes={minutes} setMinutes={setMinutes} />;
    case 'article':
      return null;
    case 'pdf':
    case 'document':
      return <DocumentFields {...props} />;
    case 'external':
      return <ExternalFields {...props} />;
    case 'quiz':
    case 'final_assessment':
      return <AssessmentFields {...props} />;
    case 'ai_simulation':
    case 'scenario':
      return <ScenarioFields {...props} />;
    case 'assignment': {
      const b = boundsOf(learning.lessonConfigSchemas.assignment);
      return (
        <>
          <TextFields
            props={props}
            name="instructions"
            label="Instructions"
            required
            rows={8}
            max={20_000}
            hint="Shown to the learner. Markdown is supported."
          />
          <NumberField
            label="Minimum words"
            name="minWords"
            props={props}
            bounds={b.minWords}
            hint="Zero means no minimum."
          />
        </>
      );
    }
    case 'manager_approval':
      return (
        <TextFields
          props={props}
          name="instructions"
          label="What the manager confirms"
          required
          rows={5}
          max={5_000}
        />
      );
    case 'acknowledgment':
      return (
        <TextFields
          props={props}
          name="statement"
          label="Statement"
          required
          rows={8}
          max={20_000}
          hint="The learner acknowledges by typing their full name."
        />
      );
  }
}
