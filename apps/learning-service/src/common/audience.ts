import type { learning } from '@a5/contracts';

export interface AudienceSubject {
  roleKeys: readonly string[];
  teamIds: readonly string[];
  locationId: string | null;
  departmentId: string | null;
}

/** Does a person belong to any of the audience entries? An empty audience matches nobody. */
export function inAudience(audiences: ReadonlyArray<Pick<learning.Audience, 'kind' | 'ref'>>, subject: AudienceSubject): boolean {
  return audiences.some((a) => {
    switch (a.kind) {
      case 'role':
        return subject.roleKeys.includes(a.ref);
      case 'team':
        return subject.teamIds.includes(a.ref);
      case 'location':
        return subject.locationId === a.ref;
      case 'department':
        return subject.departmentId === a.ref;
    }
  });
}
