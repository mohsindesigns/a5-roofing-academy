const withSeconds = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
});
const short = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

/** Audit timestamps matter to the second; the list uses the short form, details the long one. */
export function formatTimestamp(value: string, long = false): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return (long ? withSeconds : short).format(date);
}
