import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/cn';

/**
 * Renders administrator-authored lesson content. Raw HTML is never rendered (react-markdown
 * escapes it), links open safely and only http(s)/mailto URLs are allowed.
 */
export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn('prose-a5', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={(url) => (/^(https?:|mailto:|\/)/i.test(url) ? url : '')}
        components={{
          a: ({ href, children: c }) => (
            <a
              href={href}
              target={href?.startsWith('/') ? undefined : '_blank'}
              rel="noopener noreferrer"
            >
              {c}
            </a>
          ),
          h1: ({ children: c }) => <h2>{c}</h2>,
          img: () => null,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
