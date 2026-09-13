import { describe, it } from 'node:test'
import { deepEqual, equal, match, throws } from 'node:assert/strict'
import {
  ObsidianLayoutError,
  MANAGED_FRONTMATTER_FIELDS,
  normalizeVaultRelativePath,
  parseObsidianFrontmatter,
  sanitizeProjectSlug,
  updateManagedFrontmatter
} from '../src/obsidian-layout.ts'

const PROJECT_ID = 'project-0001'

describe('parseObsidianFrontmatter', () => {
  it('reads the controlled keys, keeps unknown keys and never infers a project from the path', () => {
    const parsed = parseObsidianFrontmatter([
      '---',
      'title: Renamed by the user',
      'workbench_project_id: project-0001',
      'workbench_kind: literature_review',
      'labels: ["review", "project:project-0001"]',
      'custom_score: 7',
      'nested:',
      '  keep: true',
      '---',
      '',
      '正文'
    ].join('\n'))
    equal(parsed.present, true)
    equal(parsed.projectId, PROJECT_ID)
    equal(parsed.kind, 'literature_review')
    equal(parsed.title, 'Renamed by the user')
    deepEqual(parsed.tags, ['review'])
    // The parser flattens YAML nesting into dotted entry keys, so a nested
    // block contributes both `nested` and `nested.keep`; either way the raw
    // lines survive the patch untouched.
    deepEqual(Object.keys(parsed.unknownFields).sort(), ['custom_score', 'keep', 'nested'])
    deepEqual(Object.keys(parsed.unknownRaw).sort(), ['custom_score', 'keep', 'nested'])
  })

  it('reports an invalid project binding as a warning instead of throwing', () => {
    const parsed = parseObsidianFrontmatter('---\nworkbench_project_id: ""\n---\n')
    equal(parsed.projectId, null)
    match(parsed.warnings.join('\n'), /无效/u)
  })
})

describe('updateManagedFrontmatter', () => {
  it('preserves unknown fields, both label aliases and the body', () => {
    const source = [
      '---',
      'title: 原有标题',
      'tags: ["reading"]',
      'labels:',
      '  - reading',
      'custom_score: 7',
      '---',
      '',
      '## 正文',
      '内容'
    ].join('\n')
    const next = updateManagedFrontmatter(source, { projectId: PROJECT_ID, kind: 'literature_review' })
    const parsed = parseObsidianFrontmatter(next)
    equal(parsed.projectId, PROJECT_ID)
    equal(parsed.kind, 'literature_review')
    deepEqual(parsed.tags, ['reading'])
    deepEqual(parsed.unknownFields.custom_score, 7)
    match(next, /## 正文\n内容$/u)
    // Both alias names carry the reserved project label so the connector's tag
    // projection and the frontmatter parser agree.
    match(next, /tags: \["reading","project:project-0001"\]/u)
    match(next, /labels: \["reading","project:project-0001"\]/u)
  })

  it('removes the project label when the binding is cleared', () => {
    const source = '---\ntags: ["reading","project:project-0001"]\n---\n\n正文\n'
    const parsed = parseObsidianFrontmatter(updateManagedFrontmatter(source, { projectId: null }))
    equal(parsed.projectId, null)
    deepEqual(parsed.tags, ['reading'])
  })

  it('does not rewrite managed aliases when the patch is empty', () => {
    const source = '---\ntitle: 原文\n---\n\n正文\n'
    equal(updateManagedFrontmatter(source, {}), source)
  })

  it('creates a controlled frontmatter block for a file without one', () => {
    const next = updateManagedFrontmatter('正文只有内容', { parent: '文献综述/父笔记.md', kind: 'literature_review' })
    match(next, /^---\n/u)
    const parsed = parseObsidianFrontmatter(next)
    equal(parsed.parent, '文献综述/父笔记.md')
    equal(parsed.kind, 'literature_review')
    match(next, /正文只有内容$/u)
  })

  it('fails closed on duplicate managed keys and unsafe values', () => {
    throws(
      () => updateManagedFrontmatter('---\nworkbench_project_id: a\nworkbench_project_id: b\n---\n', { projectId: PROJECT_ID }),
      (error: unknown) => error instanceof ObsidianLayoutError && error.code === 'FRONTMATTER_INVALID'
    )
    throws(
      () => updateManagedFrontmatter('---\n---\n', { parent: '../escape.md' }),
      (error: unknown) => error instanceof ObsidianLayoutError && error.code === 'OUTSIDE_ROOT'
    )
    throws(
      () => updateManagedFrontmatter('---\n---\n', { labels: ['bad\nlabel'] }),
      (error: unknown) => error instanceof ObsidianLayoutError && error.code === 'FRONTMATTER_INVALID'
    )
  })

  it('exposes the managed field names used by the preview projection', () => {
    deepEqual(MANAGED_FRONTMATTER_FIELDS.projectId, ['workbench_project_id', 'projectId'])
    deepEqual(MANAGED_FRONTMATTER_FIELDS.labels, ['labels', 'tags'])
  })
})

describe('vault path and slug safety', () => {
  it('rejects traversal, absolute, .obsidian and invalid Markdown paths', () => {
    const code = (expected: string) => (error: unknown): boolean => error instanceof ObsidianLayoutError && error.code === expected
    throws(() => normalizeVaultRelativePath('../outside.md', true), code('OUTSIDE_ROOT'))
    throws(() => normalizeVaultRelativePath('C:/outside.md', true), code('OUTSIDE_ROOT'))
    throws(() => normalizeVaultRelativePath('.obsidian/workspace.json', true), code('OUTSIDE_ROOT'))
    throws(() => normalizeVaultRelativePath('notes/readme', true), code('NON_MARKDOWN'))
    throws(() => normalizeVaultRelativePath('', true), code('OUTSIDE_ROOT'))
    throws(() => normalizeVaultRelativePath('a//b.md', true), code('OUTSIDE_ROOT'))
    equal(normalizeVaultRelativePath('文献综述/笔记.md', true), '文献综述/笔记.md')
    equal(normalizeVaultRelativePath('每日文献推送\\note.md', true), '每日文献推送/note.md')
  })

  it('keeps Windows reserved names out of generated slugs', () => {
    equal(sanitizeProjectSlug('CON.txt'), 'CON-project.txt')
    equal(sanitizeProjectSlug('trailing dot. '), 'trailing dot')
  })
})
