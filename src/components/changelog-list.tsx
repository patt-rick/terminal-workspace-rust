import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ChangelogEntry } from '../lib/changelog'

/** Renders a list of changelog entries as markdown. Used by the What's New
 *  recap and the Settings → Updates release-history viewer. */
export function ChangelogList({ entries, large = false }: { entries: ChangelogEntry[]; large?: boolean }) {
  return (
    <div className={`md-body text-foreground/80 ${large ? 'text-sm leading-relaxed' : 'text-xs'}`}>
      {entries.map((e) => (
        <div key={e.version} className="mb-4 last:mb-0">
          <div className={`mb-1 font-medium text-foreground/90 ${large ? 'text-base' : 'text-xs'}`}>
            v{e.version}
            {e.date ? ` — ${e.date}` : ''}
          </div>
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{e.body}</ReactMarkdown>
        </div>
      ))}
    </div>
  )
}
