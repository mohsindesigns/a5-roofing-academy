import { isRouteErrorResponse, Link, useRouteError } from 'react-router';
import { Button } from '@/components/ui';
import { ApiError } from '@/lib/api/errors';

/** Error boundary for route modules (failed lazy chunk, render error). */
export function RouteError() {
  const error = useRouteError();
  const chunkFailed =
    error instanceof Error && /dynamically imported module|Failed to fetch/i.test(error.message);
  let title = 'This page could not be displayed';
  let message =
    'An unexpected problem occurred. Reload the page; if it keeps happening, contact support.';
  if (chunkFailed) {
    title = 'A newer version is available';
    message = 'The app was updated while you were using it. Reload to continue.';
  } else if (isRouteErrorResponse(error) && error.status === 404) {
    title = 'Page not found';
    message = 'The link may be outdated, or the page was moved.';
  } else if (error instanceof ApiError) {
    message = error.message;
  }
  return (
    <div role="alert" className="mx-auto mt-16 max-w-md px-4">
      <h1 className="text-xl font-semibold">{title}</h1>
      <p className="mt-2 text-base text-text-secondary">{message}</p>
      <div className="mt-5 flex gap-2">
        <Button variant="primary" onClick={() => window.location.reload()}>
          Reload
        </Button>
        <Button asChild>
          <Link to="/">Go to home</Link>
        </Button>
      </div>
    </div>
  );
}

export function NotFoundPage() {
  return (
    <div className="mt-10 max-w-md">
      <h1 className="text-xl font-semibold">Page not found</h1>
      <p className="mt-2 text-base text-text-secondary">
        The link may be outdated, or the page was moved.
      </p>
      <Button asChild className="mt-5">
        <Link to="/">Go to home</Link>
      </Button>
    </div>
  );
}
