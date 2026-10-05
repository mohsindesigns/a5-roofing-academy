export interface FieldIssue {
  path: string;
  message: string;
}

/** Normalised API error. Messages come from the server and are written for end users. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fields: FieldIssue[] = [],
    readonly details: Record<string, unknown> = {},
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  static async fromResponse(res: Response): Promise<ApiError> {
    const body = (await res.json().catch(() => null)) as {
      error?: {
        code?: string;
        message?: string;
        fields?: FieldIssue[];
        details?: Record<string, unknown>;
        requestId?: string;
      };
    } | null;
    const e = body?.error;
    return new ApiError(
      res.status,
      e?.code ?? `HTTP_${res.status}`,
      e?.message ?? defaultMessage(res.status),
      e?.fields ?? [],
      e?.details ?? {},
      e?.requestId ?? res.headers.get('x-request-id') ?? undefined,
    );
  }

  get isNotFound() {
    return this.status === 404;
  }

  get isForbidden() {
    return this.status === 403;
  }
}

function defaultMessage(status: number): string {
  if (status === 401) return 'Your session expired. Sign in again.';
  if (status === 403) return 'You do not have permission to do this.';
  if (status === 404) return 'This item no longer exists or you no longer have access to it.';
  if (status === 413) return 'The file or request is too large.';
  if (status === 429) return 'Too many requests. Wait a moment and try again.';
  if (status >= 500) return 'The server could not complete the request. Try again in a moment.';
  return 'The request could not be completed.';
}

export const NETWORK_ERROR_MESSAGE =
  "Can't reach A5 Sales Academy. Check your connection and try again.";

/** Human message for any thrown value. */
export function errorMessage(
  err: unknown,
  fallback = 'The request could not be completed.',
): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}
