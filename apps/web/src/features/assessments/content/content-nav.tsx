import { NavLink } from 'react-router';
import { usePermissions } from '@/features/auth/session';
import { cn } from '@/lib/cn';

/** Section links shared by the assessment list pages. Each link appears only for people allowed to open it. */
export function ContentNav() {
  const can = usePermissions();
  const items = [
    { to: '/content/assessments', label: 'Assessments', show: can.has('assessments.view') },
    { to: '/content/questions', label: 'Question bank', show: can.has('assessments.view') },
    {
      to: '/content/assessments/attempts',
      label: 'Attempts',
      show: can.has('assessment_attempts.view'),
    },
  ].filter((i) => i.show);
  if (items.length < 2) return null;
  return (
    <nav
      aria-label="Assessment sections"
      className="mb-5 flex gap-5 overflow-x-auto border-b border-border"
    >
      {items.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end
          className={({ isActive }) =>
            cn(
              '-mb-px flex h-10 shrink-0 items-center border-b-2 text-base font-medium',
              isActive
                ? 'border-brand-secondary text-text-primary'
                : 'border-transparent text-text-secondary hover:text-text-primary',
            )
          }
        >
          {item.label}
        </NavLink>
      ))}
    </nav>
  );
}
