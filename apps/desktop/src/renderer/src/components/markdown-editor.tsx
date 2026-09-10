import { useRef, type ReactNode } from 'react'
import { Copy } from 'lucide-react'
import { cn } from '../lib/utils'

function inlineMarkdown(value: string): ReactNode[] {
  const tokens = value.split(/(`[^`]*`|\*\*[^*]+\*\*|__[^_]+__)/g)
  return tokens.map((token, index) => {
    if (token.startsWith('`') && token.endsWith('`')) {
      return <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.9em]" key={`${index}-code`}>{token.slice(1, -1)}</code>
    }
    if ((token.startsWith('**') && token.endsWith('**')) || (token.startsWith('__') && token.endsWith('__'))) {
      return <strong key={`${index}-strong`}>{token.slice(2, -2)}</strong>
    }
    return token
  })
}

function CodeBlock({ code, language, blockKey }: { code: string; language?: string; blockKey: string }): React.JSX.Element {
  return (
    <div className="relative overflow-hidden rounded-md border border-border bg-muted" key={blockKey}>
      <div className="flex items-center justify-between border-b border-border/70 px-3 py-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
        <span>{language || 'code'}</span>
        <button
          aria-label="复制代码"
          className="inline-flex items-center gap-1 rounded border border-border bg-surface px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground"
          onClick={() => { void navigator.clipboard?.writeText(code) }}
          type="button"
        >
          <Copy aria-hidden="true" className="size-3" />
          复制
        </button>
      </div>
      <pre className="overflow-x-auto p-3 text-xs leading-5"><code>{code}</code></pre>
    </div>
  )
}

/** A dependency-free, inert Markdown preview for local-first content. */
export function MarkdownPreview({ source }: { source: string }): React.JSX.Element {
  const blocks: ReactNode[] = []
  let code: string[] | null = null
  let language = ''
  let codeIndex = 0
  source.replace(/\r\n?/g, '\n').split('\n').forEach((line, index) => {
    const fence = /^\s*```\s*([^\s]*)\s*$/.exec(line)
    if (fence) {
      if (code === null) {
        code = []
        language = fence[1] ?? ''
      } else {
        blocks.push(<CodeBlock blockKey={`code-${codeIndex++}`} code={code.join('\n')} language={language} key={`code-${index}`} />)
        code = null
        language = ''
      }
      return
    }
    if (code !== null) {
      code.push(line)
      return
    }
    if (!line.trim()) return
    const heading = /^(#{1,6})\s+(.+)$/.exec(line)
    if (heading) {
      const level = heading[1]!.length
      const Tag = `h${level}` as keyof React.JSX.IntrinsicElements
      blocks.push(<Tag className={cn(level === 1 ? 'text-xl font-bold' : level === 2 ? 'text-lg font-bold' : 'text-base font-semibold')} key={`heading-${index}`}>{inlineMarkdown(heading[2]!)}</Tag>)
      return
    }
    const unordered = /^\s*[-*+]\s+(.+)$/.exec(line)
    if (unordered) {
      blocks.push(<p className="pl-5 leading-6 before:mr-2 before:content-['•']" key={`li-${index}`}>{inlineMarkdown(unordered[1]!)}</p>)
      return
    }
    const ordered = /^\s*\d+[.)]\s+(.+)$/.exec(line)
    if (ordered) {
      const number = /^\s*(\d+)[.)]/.exec(line)?.[1] ?? '1'
      blocks.push(<p className="pl-5 leading-6" key={`oli-${index}`}><span className="mr-2 text-muted-foreground">{number}.</span>{inlineMarkdown(ordered[1]!)}</p>)
      return
    }
    if (line.startsWith('>')) {
      blocks.push(<blockquote className="border-l-2 border-primary/50 pl-3 italic text-muted-foreground" key={`quote-${index}`}>{inlineMarkdown(line.replace(/^>\s?/, ''))}</blockquote>)
      return
    }
    blocks.push(<p className="whitespace-pre-wrap leading-6" key={`p-${index}`}>{inlineMarkdown(line)}</p>)
  })
  const trailingCode = code as string[] | null
  if (trailingCode !== null) blocks.push(<CodeBlock blockKey={`code-${codeIndex}`} code={trailingCode.join('\n')} language={language} key={`code-${codeIndex}`} />)
  return <div aria-label="Markdown 实时预览" className="grid content-start gap-3 overflow-auto p-4 text-sm text-foreground">{blocks.length > 0 ? blocks : <p className="text-sm text-muted-foreground">暂无内容，开始编辑后将在这里预览。</p>}</div>
}

/**
 * Obsidian-style editor: editing and preview are always visible together.
 * The `preview={false}` compatibility option keeps an edit-only layout for
 * callers that explicitly request it; there is no mode switch in the UI.
 */
export function MarkdownEditor({ value, onChange, placeholder, className, preview = true }: { value: string; onChange: (value: string) => void; placeholder?: string; className?: string; preview?: boolean }): React.JSX.Element {
  const editorRef = useRef<HTMLTextAreaElement | null>(null)
  return (
    <div className={cn('grid min-h-0', preview ? 'lg:grid-cols-2' : 'grid-cols-1', className)}>
      <textarea ref={editorRef} aria-label="Markdown 编辑器" className="markdown-editor min-h-[24rem]" onChange={(event) => onChange(event.target.value)} placeholder={placeholder} spellCheck value={value} />
      {preview ? <MarkdownPreview source={value} /> : null}
    </div>
  )
}
