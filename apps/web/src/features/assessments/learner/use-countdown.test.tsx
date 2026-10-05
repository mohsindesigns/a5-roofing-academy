import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useServerCountdown } from './use-countdown';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-05T15:00:00.000Z'));
});
afterEach(() => vi.useRealTimers());

describe('useServerCountdown', () => {
  it('counts down from the server value', () => {
    const { result } = renderHook(() => useServerCountdown(90, () => undefined));
    expect(result.current.remaining).toBe(90);
    act(() => void vi.advanceTimersByTime(30_000));
    expect(result.current.remaining).toBe(60);
  });

  it('calls onExpire once when time runs out', () => {
    const onExpire = vi.fn();
    const { result } = renderHook(() => useServerCountdown(3, onExpire));
    act(() => void vi.advanceTimersByTime(2_900));
    expect(onExpire).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(200));
    expect(result.current.remaining).toBe(0);
    expect(onExpire).toHaveBeenCalledTimes(1);
    act(() => void vi.advanceTimersByTime(5_000));
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it('follows the server when it reports a different remaining time', () => {
    const { result } = renderHook(() => useServerCountdown(600, () => undefined));
    act(() => void vi.advanceTimersByTime(10_000));
    expect(result.current.remaining).toBe(590);
    act(() => result.current.sync(540));
    expect(result.current.remaining).toBe(540);
    act(() => void vi.advanceTimersByTime(40_000));
    expect(result.current.remaining).toBe(500);
  });

  it('keeps counting while the tab is in the background', () => {
    const { result } = renderHook(() => useServerCountdown(120, () => undefined));
    // Timers are throttled in background tabs; the wall clock still moves.
    act(() => {
      vi.setSystemTime(Date.now() + 100_000);
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(result.current.remaining).toBe(20);
  });

  it('stays null for an untimed attempt', () => {
    const onExpire = vi.fn();
    const { result } = renderHook(() => useServerCountdown(null, onExpire));
    act(() => void vi.advanceTimersByTime(60_000));
    expect(result.current.remaining).toBeNull();
    expect(onExpire).not.toHaveBeenCalled();
  });
});
