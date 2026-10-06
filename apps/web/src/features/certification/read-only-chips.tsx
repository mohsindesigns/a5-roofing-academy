/** A fixed list of chosen items for people who can look but not change (no remove buttons). */
export function ReadOnlyChips({
  ids,
  labels,
  empty,
}: {
  ids: readonly string[];
  labels: Readonly<Record<string, string>>;
  empty: string;
}) {
  if (ids.length === 0) return <p className="text-base text-text-secondary">{empty}</p>;
  return (
    <ul className="flex flex-wrap gap-1.5">
      {ids.map((id) => (
        <li
          key={id}
          className="inline-flex h-6 items-center rounded-sm bg-surface-sunken px-2 text-sm"
        >
          {labels[id] ?? 'Unknown'}
        </li>
      ))}
    </ul>
  );
}
