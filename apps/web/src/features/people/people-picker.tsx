import { useMemo, useState } from 'react';
import { MultiSelect } from '@/components/ui';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { usePeopleOptions } from './api';

/** Async people search for manager/trainer/member selection. */
export function PeoplePicker({
  value,
  onChange,
  initial = [],
  excludeIds = [],
  placeholder = 'Search people',
  max,
  ...aria
}: {
  value: string[];
  onChange: (ids: string[]) => void;
  initial?: Array<{ id: string; displayName: string }>;
  excludeIds?: string[];
  placeholder?: string;
  max?: number;
  id?: string;
  'aria-invalid'?: boolean;
  'aria-describedby'?: string;
}) {
  const [query, setQuery] = useState('');
  const q = useDebouncedValue(query, 250);
  const [open] = useState(true);
  const people = usePeopleOptions(q, open);
  const [known, setKnown] = useState<Record<string, string>>(() =>
    Object.fromEntries(initial.map((p) => [p.id, p.displayName])),
  );
  const options = useMemo(
    () =>
      (people.data?.items ?? [])
        .filter((p) => !excludeIds.includes(p.id))
        .map((p) => ({
          value: p.id,
          label: p.displayName,
          description: [p.jobTitle, p.teams.map((t) => t.name).join(', ')]
            .filter(Boolean)
            .join(' · '),
        })),
    [people.data, excludeIds],
  );
  return (
    <MultiSelect
      {...aria}
      options={options}
      value={value}
      max={max}
      placeholder={placeholder}
      loading={people.isFetching}
      selectedLabels={known}
      onQueryChange={setQuery}
      onChange={(ids) => {
        const labels = { ...known };
        for (const o of options) labels[o.value] = o.label;
        setKnown(labels);
        onChange(ids);
      }}
    />
  );
}
