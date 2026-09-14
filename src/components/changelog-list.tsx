import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ChangelogEntry } from '../lib/changelog'

/** Renders a list of changelog entries as markdown. Used by the What's New
 *  recap and the Settings → Updates release-history viewer. */
export function ChangelogList({ entries }: { entries: ChangelogEntry[] }) {
  return (
    <div className="md-body text-xs text-foreground/80">
      {entries.map((e) => (
        <div key={e.version} className="mb-4 last:mb-0">
          <div className="mb-1 text-xs font-medium text-foreground/90">
            v{e.version}
            {e.date ? ` — ${e.date}` : ''}
          </div>
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{e.body}</ReactMarkdown>
        </div>
      ))}
    </div>
  )
}
