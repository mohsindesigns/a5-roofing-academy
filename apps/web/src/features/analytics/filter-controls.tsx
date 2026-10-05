import { useState } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import { Button, Field, Input, Select } from '@/components/ui';
import { useLocations, useTeams } from '@/features/organization/api';
import { useProgramOptions, useCertificationOptions } from './options';
import {
  activeFilterCount,
  activePreset,
  localIsoDate,
  presetRange,
  rangeError,
  DATE_PRESETS,
  type AnalyticsFilterState,
  type DatePresetKey,
} from './filters';

const PRESET_OPTIONS: Array<{ value: DatePresetKey | 'all' | 'custom'; label: string }> = [
  { value: 'all', label: 'All time' },
  ...DATE_PRESETS.map((p) => ({ value: p.value, label: p.label })),
  { value: 'ytd', label: 'Year to date' },
  { value: 'custom', label: 'Custom range' },
];

/** Preset picker plus explicit dates. Dates are inclusive calendar days. */
export function DateRangeControl({
  from,
  to,
  onChange,
}: {
  from: string;
  to: string;
  onChange: (range: { from: string; to: string }) => void;
}) {
  const today = localIsoDate();
  const preset = activePreset({ from, to }, today);
  const [forceCustom, setForceCustom] = useState(false);
  const custom = forceCustom || preset === 'custom';
  const error = rangeError({ from, to });
  return (
    <div className="flex flex-col gap-2">
      <Select
        aria-label="Date range"
        value={custom ? 'custom' : preset}
        onChange={(e) => {
          const next = e.target.value as DatePresetKey | 'all' | 'custom';
          if (next === 'custom') {
            setForceCustom(true);
            return;
          }
          setForceCustom(false);
          onChange(next === 'all' ? { from: '', to: '' } : presetRange(next, today));
        }}
      >
        {PRESET_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </Select>
      {custom && (
        <div className="grid grid-cols-2 gap-2">
          <Field label="From" hideLabel error={error ?? undefined}>
            <Input
              type="date"
              aria-label="From date"
              value={from}
              max={to || undefined}
              onChange={(e) => onChange({ from: e.target.value, to })}
            />
          </Field>
          <Field label="To" hideLabel>
            <Input
              type="date"
              aria-label="To date"
              value={to}
              min={from || undefined}
              onChange={(e) => onChange({ from, to: e.target.value })}
            />
          </Field>
        </div>
      )}
    </div>
  );
}

/**
 * Date range + program / team / location (+ certification) filters over URL state. Selects whose
 * options the caller may not read (the API answers 403) simply do not appear. On phones the
 * controls collapse behind a "Filters" button.
 */
export function AnalyticsFilterBar({
  state,
  setState,
  showCertification = false,
}: {
  state: AnalyticsFilterState;
  setState: (patch: Partial<AnalyticsFilterState>) => void;
  showCertification?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const programs = useProgramOptions();
  const teams = useTeams();
  const locations = useLocations();
  const certifications = useCertificationOptions(showCertification);
  const count = activeFilterCount(state) + (state.from || state.to ? 1 : 0);
  return (
    <div className="mb-4 flex flex-col gap-2">
      <div className="sm:hidden">
        <Button
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          leading={<SlidersHorizontal className="size-4" />}
        >
          Filters
          {count > 0 && <span className="tabular text-text-tertiary">{count}</span>}
        </Button>
      </div>
      <div
        className={`items-start gap-2 sm:grid sm:grid-cols-[repeat(auto-fit,minmax(170px,1fr))] ${open ? 'grid' : 'hidden'}`}
      >
        <DateRangeControl
          from={state.from}
          to={state.to}
          onChange={(r) => setState({ from: r.from, to: r.to })}
        />
        {programs.data && programs.data.items.length > 0 && (
          <Select
            aria-label="Program"
            value={state.programId}
            onChange={(e) => setState({ programId: e.target.value })}
          >
            <option value="">All programs</option>
            {programs.data.items.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
          </Select>
        )}
        {teams.data && teams.data.items.length > 0 && (
          <Select
            aria-label="Team"
            value={state.teamId}
            onChange={(e) => setState({ teamId: e.target.value })}
          >
            <option value="">All teams</option>
            {teams.data.items.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        )}
        {locations.data && locations.data.items.length > 1 && (
          <Select
            aria-label="Location"
            value={state.locationId}
            onChange={(e) => setState({ locationId: e.target.value })}
          >
            <option value="">All locations</option>
            {locations.data.items.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </Select>
        )}
        {showCertification && certifications.data && certifications.data.items.length > 0 && (
          <Select
            aria-label="Certification"
            value={state.certificationId}
            onChange={(e) => setState({ certificationId: e.target.value })}
          >
            <option value="">All certifications</option>
            {certifications.data.items.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        )}
      </div>
    </div>
  );
}
