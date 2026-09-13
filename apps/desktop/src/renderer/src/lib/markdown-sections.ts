/**
 * Split an Obsidian Markdown document into preview sections at H2 boundaries so
 * a long note can be folded without hiding content by default.
 *
 * Rules that matter for truthfulness:
 * - A `## ` line inside a fenced code block never starts a section.
 * - Only level-2 headings split; H1 stays the document title and H3+ stays
 *   inside its parent section.
 * - The heading line itself is represented by `title`, never duplicated into
 *   `lines`, so rendered output cannot lose or repeat the heading text.
 * - Line content is preserved in order; nothing is trimmed or truncated.
 *
 * Dependency-free on purpose: the renderer imports it and the focused test can
 * exercise it without a DOM.
 */

export type MarkdownSectionLines = {
  /** Stable key for React and for the collapsed-section set. */
  key: string
  /** Foldable H2 title, or null for the preamble before the first H2. */
  title: string | null
  /** Raw lines of the section, excluding its own H2 heading line. */
  lines: string[]
}

const headingPattern = /^(#{1,6})\s+(.+)$/

export function splitMarkdownSections(source: string): MarkdownSectionLines[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const sections: MarkdownSectionLines[] = [{ key: 'section-0', title: null, lines: [] }]
  let fenceOpen = false
  for (const line of lines) {
    if (line.trimStart().startsWith('```')) {
      fenceOpen = !fenceOpen
    } else if (!fenceOpen) {
      const heading = headingPattern.exec(line)
      if (heading && heading[1]!.length === 2) {
        sections.push({ key: `section-${sections.length}`, title: heading[2]!, lines: [] })
        continue
      }
    }
    sections[sections.length - 1]!.lines.push(line)
  }
  return sections
}
