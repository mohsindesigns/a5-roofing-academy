import { Avatar } from '@/components/ui';

/** Name with an optional second line (job title, employee ID) for table rows and lists. */
export function PersonCell({
  name,
  detail,
  size = 28,
}: {
  name: string;
  detail?: string | null;
  size?: number;
}) {
  return (
    <span className="flex min-w-0 items-center gap-3">
      <Avatar name={name} size={size} />
      <span className="min-w-0">
        <span className="block truncate font-medium">{name}</span>
        {detail && <span className="block truncate text-sm text-text-tertiary">{detail}</span>}
      </span>
    </span>
  );
}
