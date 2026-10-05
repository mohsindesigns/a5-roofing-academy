import { type ReactNode } from 'react';
import { BrandMark } from './shell/brand';

/** Minimal layout for sign-in, activation and public verification pages. */
export function AuthLayout({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex h-16 items-center gap-2.5 px-5 sm:px-8">
        <BrandMark />
        <span className="text-sm font-semibold">
          A5 Roofing <span className="font-normal text-text-tertiary">Sales Academy</span>
        </span>
      </header>
      <main className="flex flex-1 items-start justify-center px-4 pt-[6vh] pb-16 sm:items-center sm:pt-0">
        <div className="w-full max-w-[400px]">
          <h1 className="text-2xl font-semibold tracking-[-0.01em]">{title}</h1>
          {description && <p className="mt-1.5 text-base text-text-secondary">{description}</p>}
          <div className="mt-7">{children}</div>
          {footer && <div className="mt-6 text-sm text-text-secondary">{footer}</div>}
        </div>
      </main>
    </div>
  );
}
