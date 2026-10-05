import { useNavigate } from 'react-router';
import { ChevronsUpDown, LogOut, UserRound } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import {
  Avatar,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuRoot,
  MenuSeparator,
  MenuTrigger,
} from '@/components/ui';
import { signOut } from '@/lib/api/client';
import { useAuth } from '@/lib/auth-store';
import { cn } from '@/lib/cn';

export function UserMenu({
  collapsed = false,
  compact = false,
}: {
  collapsed?: boolean;
  compact?: boolean;
}) {
  const user = useAuth((s) => s.user);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  if (!user) return null;
  const roleNames = user.roles.map((r) => r.name).join(', ');
  return (
    <MenuRoot>
      <MenuTrigger
        className={cn(
          'flex w-full min-w-0 items-center gap-2.5 rounded p-1.5 text-left hover:bg-surface-hover',
          (collapsed || compact) && 'w-auto justify-center',
        )}
        aria-label="Account menu"
      >
        <Avatar name={user.displayName} size={compact ? 30 : 28} />
        {!collapsed && !compact && (
          <>
            <span className="min-w-0 flex-1 leading-tight">
              <span className="block truncate text-sm font-medium">{user.displayName}</span>
              <span className="block truncate text-xs text-text-tertiary">{roleNames}</span>
            </span>
            <ChevronsUpDown aria-hidden className="size-3.5 text-text-tertiary" />
          </>
        )}
      </MenuTrigger>
      <MenuContent align={compact ? 'end' : 'start'}>
        <MenuLabel>
          {user.email}
          <span className="block font-normal">{user.organizationName}</span>
        </MenuLabel>
        <MenuSeparator />
        <MenuItem icon={<UserRound />} onSelect={() => navigate('/account')}>
          Account & security
        </MenuItem>
        <MenuItem
          icon={<LogOut />}
          onSelect={async () => {
            await signOut();
            queryClient.clear();
            navigate('/login', { replace: true });
          }}
        >
          Sign out
        </MenuItem>
      </MenuContent>
    </MenuRoot>
  );
}
