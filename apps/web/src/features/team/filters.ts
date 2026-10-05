import type { TeamProgressParams } from './api';

/** URL state of the team progress table. Every value is a string; empty means "not set". */
export const TEAM_DEFAULTS = {
  q: '',
  programId: '',
  teamId: '',
  /** '' = active and completed enrollments (the API default). */
  status: '',
  /** 'true' shows only people the API flagged. */
  attention: '',
  sort: 'name',
  page: '1',
  /** Person whose detail drawer is open. */
  learner: '',
};
export type TeamState = typeof TEAM_DEFAULTS;

export const TEAM_STATUS_OPTIONS = [
  { value: '', label: 'Active and completed' },
  { value: 'active', label: 'In progress' },
  { value: 'completed', label: 'Completed' },
  { value: 'withdrawn', label: 'Withdrawn' },
] as const;

const SORTS = new Set(['name', 'progress', 'lastActivity', 'dueAt']);

/** Translate URL state into the progress API query, ignoring values the API would reject. */
export function toProgressParams(state: TeamState, pageSize = 25): TeamProgressParams {
  const sortKey = state.sort.replace(/^-/, '');
  const page = Number.parseInt(state.page, 10);
  return {
    q: state.q.trim() || undefined,
    programId: state.programId || undefined,
    teamId: state.teamId || undefined,
    status: ['active', 'completed', 'withdrawn'].includes(state.status) ? state.status : undefined,
    attention: state.attention === 'true',
    sort: SORTS.has(sortKey) ? state.sort : TEAM_DEFAULTS.sort,
    page: Number.isFinite(page) && page > 0 ? page : 1,
    pageSize,
  };
}

/** Number of narrowing filters (search excluded), for the phone filter toggle. */
export function activeTeamFilters(state: TeamState): number {
  return [state.programId, state.teamId, state.status, state.attention].filter(Boolean).length;
}

export function isFiltered(state: TeamState): boolean {
  return Boolean(state.q.trim()) || activeTeamFilters(state) > 0;
}
