import { create } from 'zustand';
import type { identity } from '@a5/contracts';

export type AuthStatus = 'loading' | 'authenticated' | 'anonymous';

interface AuthState {
  status: AuthStatus;
  accessToken: string | null;
  expiresAt: number | null;
  sessionId: string | null;
  user: identity.SessionUser | null;
  /** Why the user was signed out, shown on the sign-in page. */
  signedOutReason: string | null;
  setSession: (session: identity.LoginResponse) => void;
  clear: (reason?: string | null) => void;
}

/** Access token lives in memory only; the refresh token is an HttpOnly cookie. */
export const useAuth = create<AuthState>((set) => ({
  status: 'loading',
  accessToken: null,
  expiresAt: null,
  sessionId: null,
  user: null,
  signedOutReason: null,
  setSession: (s) =>
    set({
      status: 'authenticated',
      accessToken: s.accessToken,
      expiresAt: Date.now() + s.expiresIn * 1000,
      sessionId: s.sessionId,
      user: s.user,
      signedOutReason: null,
    }),
  clear: (reason = null) =>
    set({
      status: 'anonymous',
      accessToken: null,
      expiresAt: null,
      sessionId: null,
      user: null,
      signedOutReason: reason,
    }),
}));
