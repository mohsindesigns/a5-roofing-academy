import { useAuth } from '../auth-store';
import { buildUrl, refreshSession } from './client';
import { ApiError, NETWORK_ERROR_MESSAGE } from './errors';

type Query = Record<string, string | number | boolean | null | undefined>;

function filenameFrom(res: Response, fallback: string): string {
  const header = res.headers.get('content-disposition') ?? '';
  const match = /filename\*=UTF-8''([^;]+)|filename="([^"]+)"/i.exec(header);
  const raw = match?.[1] ?? match?.[2];
  if (!raw) return fallback;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * Download a file from an authenticated API endpoint (the bearer token cannot be sent by a plain
 * link). Resolves with the blob and the server-suggested file name; rejects with `ApiError`.
 */
export async function apiDownload(
  path: string,
  query: Query = {},
  fallbackName = 'download',
): Promise<{ blob: Blob; fileName: string }> {
  const attempt = async (): Promise<Response> => {
    const token = useAuth.getState().accessToken;
    try {
      return await fetch(buildUrl(path, query), {
        credentials: 'same-origin',
        headers: { ...(token && { authorization: `Bearer ${token}` }) },
      });
    } catch {
      throw new ApiError(0, 'NETWORK_ERROR', NETWORK_ERROR_MESSAGE);
    }
  };
  const auth = useAuth.getState();
  if (auth.accessToken && auth.expiresAt && auth.expiresAt - Date.now() < 15_000) {
    await refreshSession();
  }
  let res = await attempt();
  if (res.status === 401 && (await refreshSession())) res = await attempt();
  if (!res.ok) throw await ApiError.fromResponse(res);
  return { blob: await res.blob(), fileName: filenameFrom(res, fallbackName) };
}

/** Offer a blob to the user as a file download. */
export function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  // Give the browser a moment to start the download before releasing the object URL.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
