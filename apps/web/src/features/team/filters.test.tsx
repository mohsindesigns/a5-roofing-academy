import { act, renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { MemoryRouter, useLocation } from 'react-router';
import { describe, expect, it } from 'vitest';
import { useSearchState } from '@/hooks/use-search-state';
import { TEAM_DEFAULTS, activeTeamFilters, isFiltered, toProgressParams } from './filters';

describe('toProgressParams', () => {
  it('uses API defaults for an untouched URL', () => {
    expect(toProgressParams(TEAM_DEFAULTS)).toEqual({
      q: undefined,
      programId: undefined,
      teamId: undefined,
      status: undefined,
      attention: false,
      sort: 'name',
      page: 1,
      pageSize: 25,
    });
  });

  it('passes filters through and ignores values the API would reject', () => {
    const params = toProgressParams({
      ...TEAM_DEFAULTS,
      q: '  marcus ',
      status: 'completed',
      attention: 'true',
      sort: '-progress',
      page: '3',
    });
    expect(params).toMatchObject({
      q: 'marcus',
      status: 'completed',
      attention: true,
      sort: '-progress',
      page: 3,
    });
    expect(
      toProgressParams({ ...TEAM_DEFAULTS, status: 'bogus', sort: 'hacker', page: '-4' }),
    ).toMatchObject({
      status: undefined,
      sort: 'name',
      page: 1,
    });
  });

  it('counts narrowing filters without the search box', () => {
    expect(activeTeamFilters(TEAM_DEFAULTS)).toBe(0);
    expect(activeTeamFilters({ ...TEAM_DEFAULTS, programId: 'p', attention: 'true' })).toBe(2);
    expect(isFiltered({ ...TEAM_DEFAULTS, q: 'x' })).toBe(true);
    expect(isFiltered(TEAM_DEFAULTS)).toBe(false);
  });
});

function wrapper(initial: string) {
  return ({ children }: { children: ReactNode }) =>
    createElement(MemoryRouter, { initialEntries: [initial] }, children);
}

describe('team filter URL state', () => {
  it('reads filters from the URL and writes changes back', () => {
    const { result } = renderHook(
      () => ({ search: useSearchState(TEAM_DEFAULTS), location: useLocation() }),
      { wrapper: wrapper('/team?attention=true&sort=-progress&page=2') },
    );
    expect(result.current.search[0]).toMatchObject({
      attention: 'true',
      sort: '-progress',
      page: '2',
    });
    act(() => result.current.search[1]({ programId: 'abc' }));
    expect(result.current.search[0].programId).toBe('abc');
    // Changing a filter returns to the first page.
    expect(result.current.location.search).not.toContain('page=');
    expect(result.current.location.search).toContain('programId=abc');
  });

  it('keeps the page when only the open drawer changes', () => {
    const { result } = renderHook(
      () => ({ search: useSearchState(TEAM_DEFAULTS), location: useLocation() }),
      { wrapper: wrapper('/team?page=3') },
    );
    act(() => result.current.search[1]({ learner: 'user-1', page: result.current.search[0].page }));
    expect(result.current.location.search).toContain('page=3');
    expect(result.current.location.search).toContain('learner=user-1');
    act(() => result.current.search[1]({ learner: '', page: result.current.search[0].page }));
    expect(result.current.location.search).toBe('?page=3');
  });

  it('removes a filter from the URL when it returns to its default', () => {
    const { result } = renderHook(
      () => ({ search: useSearchState(TEAM_DEFAULTS), location: useLocation() }),
      { wrapper: wrapper('/team?teamId=t1') },
    );
    act(() => result.current.search[1]({ teamId: '' }));
    expect(result.current.location.search).toBe('');
  });
});
