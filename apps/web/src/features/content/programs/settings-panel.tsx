import { useState } from 'react';
import { learning } from '@a5/contracts';
import { Button, Field, Input, Select, Switch, Textarea, toast } from '@/components/ui';
import { MediaPicker } from '@/features/content/media/media-picker';
import { PeoplePicker } from '@/features/people/people-picker';
import { ApiError, errorMessage } from '@/lib/api/errors';
import { useUpdateProgram } from './api';
import { fromLocalInput, toLocalInput } from './rule-editor';
import { boundsOf, rangeHint, type FieldBounds } from './schema-bounds';

const programBounds = boundsOf(learning.updateProgramRequestSchema);
const settingsBounds = boundsOf(learning.programSettingsPatchSchema);

/** Number input limited by the contract. An empty box means "no value" (null). */
export function BoundedNumber({
  label,
  value,
  onChange,
  bounds,
  unit,
  hint,
  error,
  disabled,
  placeholder,
}: {
  label: string;
  value: number | null;
  onChange: (v: number | null) => void;
  bounds?: FieldBounds;
  unit?: string;
  hint?: string;
  error?: string;
  disabled?: boolean;
  placeholder?: string;
}) {
  const range = rangeHint(bounds, unit);
  return (
    <Field
      label={label}
      error={error}
      hint={[hint, range && `Allowed: ${range}`].filter(Boolean).join(' ') || undefined}
    >
      <Input
        type="number"
        inputMode="numeric"
        min={bounds?.min}
        max={bounds?.max}
        step={bounds?.integer ? 1 : 'any'}
        disabled={disabled}
        placeholder={placeholder}
        value={value === null ? '' : String(value)}
        onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
      />
    </Field>
  );
}

/**
 * Program details and learning rules. Everything is edited together and saved with one button;
 * limits come from the contract schemas.
 */
export function SettingsPanel({
  program,
  canEdit,
}: {
  program: learning.ProgramDetail;
  canEdit: boolean;
}) {
  const update = useUpdateProgram(program.id);
  const s = program.settings;
  const [title, setTitle] = useState(program.title);
  const [slug, setSlug] = useState(program.slug);
  const [summary, setSummary] = useState(program.summary ?? '');
  const [description, setDescription] = useState(program.description ?? '');
  const [category, setCategory] = useState(program.category ?? '');
  const [phaseLabel, setPhaseLabel] = useState(program.phaseLabel);
  const [tags, setTags] = useState(program.tags.join(', '));
  const [cover, setCover] = useState<string | null>(program.coverMediaAssetId);
  const [owner, setOwner] = useState<string[]>(program.owner ? [program.owner.id] : []);
  const [minutes, setMinutes] = useState<number | null>(program.estimatedMinutes);
  const [days, setDays] = useState<number | null>(program.durationDays);
  const [starts, setStarts] = useState(toLocalInput(program.availabilityStartsAt));
  const [ends, setEnds] = useState(toLocalInput(program.availabilityEndsAt));
  const [navigationMode, setNavigationMode] = useState(s.navigationMode);
  const [allowSkipAhead, setAllowSkipAhead] = useState(s.allowSkipAhead);
  const [minWatch, setMinWatch] = useState<number | null>(s.defaultMinWatchPercent);
  const [inactivity, setInactivity] = useState<number | null>(s.inactivityAlertDays);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const err = (k: string) => errors[k] ?? errors[`settings.${k}`];
  const save = async () => {
    setErrors({});
    setFormError(null);
    try {
      await update.mutateAsync({
        title: title.trim(),
        slug: slug.trim(),
        summary: summary.trim() || null,
        description: description.trim() || null,
        category: category.trim() || null,
        phaseLabel: phaseLabel.trim(),
        coverMediaAssetId: cover,
        ownerUserId: owner[0] ?? null,
        estimatedMinutes: minutes,
        durationDays: days,
        availabilityStartsAt: starts ? fromLocalInput(starts) : null,
        availabilityEndsAt: ends ? fromLocalInput(ends) : null,
        tags: tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
        settings: {
          navigationMode,
          allowSkipAhead,
          ...(minWatch !== null && { defaultMinWatchPercent: minWatch }),
          ...(inactivity !== null && { inactivityAlertDays: inactivity }),
        },
      });
      toast.success('Program saved', 'Publish to show changes to learners.');
    } catch (e) {
      if (e instanceof ApiError && e.fields.length) {
        setErrors(Object.fromEntries(e.fields.map((f) => [f.path, f.message])));
        setFormError('Fix the highlighted fields and save again.');
      } else setFormError(errorMessage(e));
    }
  };

  return (
    <form
      className="grid max-w-[760px] gap-8"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <fieldset className="grid gap-4" disabled={!canEdit}>
        <legend className="mb-1 text-md font-semibold">Details</legend>
        <Field label="Title" required error={err('title')}>
          <Input value={title} maxLength={160} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field
          label="Web address name"
          error={err('slug')}
          hint="Lowercase letters, numbers and hyphens."
        >
          <Input value={slug} maxLength={80} onChange={(e) => setSlug(e.target.value)} />
        </Field>
        <Field label="Summary" optional error={err('summary')}>
          <Textarea
            rows={2}
            value={summary}
            maxLength={1000}
            onChange={(e) => setSummary(e.target.value)}
          />
        </Field>
        <Field
          label="Description"
          optional
          error={err('description')}
          hint="Markdown is supported."
        >
          <Textarea
            rows={5}
            value={description}
            maxLength={20_000}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Category" optional error={err('category')}>
            <Input value={category} maxLength={80} onChange={(e) => setCategory(e.target.value)} />
          </Field>
          <Field
            label="Name for its phases"
            error={err('phaseLabel')}
            hint="Shown as Week 1, Phase 1 and so on."
          >
            <Input
              value={phaseLabel}
              maxLength={30}
              onChange={(e) => setPhaseLabel(e.target.value)}
            />
          </Field>
        </div>
        <Field label="Tags" optional error={err('tags')} hint="Separate with commas.">
          <Input value={tags} onChange={(e) => setTags(e.target.value)} />
        </Field>
        <Field label="Owner" optional error={err('ownerUserId')}>
          <PeoplePicker
            value={owner}
            max={1}
            onChange={setOwner}
            initial={program.owner ? [program.owner] : []}
            placeholder="Search people"
          />
        </Field>
        <Field label="Cover image" optional error={err('coverMediaAssetId')}>
          <MediaPicker kind="image" value={cover} onChange={setCover} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <BoundedNumber
            label="Estimated minutes"
            value={minutes}
            onChange={setMinutes}
            bounds={programBounds.estimatedMinutes}
            error={err('estimatedMinutes')}
            hint={`Calculated from lessons: ${program.computedMinutes}.`}
          />
          <BoundedNumber
            label="Expected duration (days)"
            value={days}
            onChange={setDays}
            bounds={programBounds.durationDays}
            error={err('durationDays')}
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Available from" optional error={err('availabilityStartsAt')}>
            <Input
              type="datetime-local"
              value={starts}
              onChange={(e) => setStarts(e.target.value)}
            />
          </Field>
          <Field label="Available until" optional error={err('availabilityEndsAt')}>
            <Input type="datetime-local" value={ends} onChange={(e) => setEnds(e.target.value)} />
          </Field>
        </div>
      </fieldset>

      <fieldset className="grid gap-4" disabled={!canEdit}>
        <legend className="mb-1 text-md font-semibold">How learners move through it</legend>
        <Field label="Order" error={err('navigationMode')}>
          <Select
            value={navigationMode}
            onChange={(e) => setNavigationMode(e.target.value as typeof navigationMode)}
          >
            <option value="sequential">
              Sequential: finish each required item before the next opens
            </option>
            <option value="free">Free: only the unlock rules you set apply</option>
          </Select>
        </Field>
        <label className="flex items-start gap-3">
          <Switch className="mt-0.5" checked={allowSkipAhead} onCheckedChange={setAllowSkipAhead} />
          <span>
            <span className="block text-sm font-medium">
              Allow skipping ahead inside an open phase
            </span>
            <span className="block text-xs text-text-tertiary">
              Only matters in sequential programs: lessons of an unlocked phase can be taken in any
              order.
            </span>
          </span>
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          <BoundedNumber
            label="Default minimum watched for videos"
            value={minWatch}
            onChange={setMinWatch}
            bounds={settingsBounds.defaultMinWatchPercent}
            unit="%"
            error={err('defaultMinWatchPercent')}
            hint="A lesson can set its own."
          />
          <BoundedNumber
            label="Flag a learner after inactivity of (days)"
            value={inactivity}
            onChange={setInactivity}
            bounds={settingsBounds.inactivityAlertDays}
            error={err('inactivityAlertDays')}
            hint="Managers see an attention flag."
          />
        </div>
      </fieldset>

      {formError && (
        <p role="alert" className="rounded bg-danger-soft px-3 py-2 text-sm text-danger">
          {formError}
        </p>
      )}
      {canEdit && (
        <div>
          <Button
            type="submit"
            variant="primary"
            loading={update.isPending}
            disabled={!title.trim()}
          >
            Save changes
          </Button>
        </div>
      )}
    </form>
  );
}
