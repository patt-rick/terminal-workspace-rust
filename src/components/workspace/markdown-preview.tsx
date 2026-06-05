import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

export function MarkdownPreview({ source }: { source: string }) {
  return (
    <div className="md-body h-full overflow-auto px-8 py-6 text-sm leading-relaxed">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{source}</ReactMarkdown>
    </div>
  )
}
