import assert from 'node:assert/strict'
import { test } from 'node:test'
import { splitMarkdownSections } from '../src/renderer/src/lib/markdown-sections.js'

/**
 * The Obsidian preview folds long notes at H2 boundaries. That grouping is a
 * pure function so these assertions can pin the two things a reader depends on:
 * content is never dropped or duplicated, and a heading-looking line inside a
 * code block never becomes a fold boundary.
 */

test('a document without H2 stays one unfolded section', () => {
  const source = '# 标题\n\n第一段。\n\n- 项目一\n- 项目二\n'
  const sections = splitMarkdownSections(source)
  assert.equal(sections.length, 1)
  assert.equal(sections[0]!.key, 'section-0')
  assert.equal(sections[0]!.title, null)
  assert.deepEqual(sections[0]!.lines, source.split('\n'))
})

test('H2 headings split sections, and the heading line is never duplicated', () => {
  const source = [
    '# 文献综述',
    '',
    '引言段落。',
    '',
    '## 研究问题',
    '问题正文。',
    '',
    '## 综述正文',
    '正文内容。',
    ''
  ].join('\n')
  const sections = splitMarkdownSections(source)
  assert.deepEqual(sections.map((section) => section.title), [null, '研究问题', '综述正文'])
  assert.deepEqual(sections.map((section) => section.key), ['section-0', 'section-1', 'section-2'])
  // The H2 text is represented by `title` only, so the renderer can draw the
  // heading once; duplicating it into `lines` would render it twice.
  for (const section of sections) {
    assert.equal(section.lines.some((line) => line.startsWith('## 研究问题') || line.startsWith('## 综述正文')), false)
  }
  // Nothing is dropped: every non-heading line survives in order.
  const preserved = sections.flatMap((section) => section.lines).join('\n')
  assert.equal(preserved, source.split('\n').filter((line) => !line.startsWith('## ')).join('\n'))
  assert.ok(preserved.includes('引言段落。') && preserved.includes('问题正文。') && preserved.includes('正文内容。'))
})

test('H1 and H3+ headings stay inside their section instead of splitting', () => {
  const source = ['# 文档标题', '', '## 第一节', '', '### 子标题', '子内容', '', '## 第二节'].join('\n')
  const sections = splitMarkdownSections(source)
  assert.deepEqual(sections.map((section) => section.title), [null, '第一节', '第二节'])
  assert.ok(sections[1]!.lines.some((line) => line === '### 子标题'))
  assert.ok(sections[2]!.lines.every((line) => line !== '### 子标题'))
})

test('a heading-looking line inside a fenced code block never splits the section', () => {
  const source = ['## 代码示例', '', '```md', '## 这行是代码，不是标题', '```', '', '代码之后的段落。', '', '## 下一节', '结束'].join('\n')
  const sections = splitMarkdownSections(source)
  assert.deepEqual(sections.map((section) => section.title), [null, '代码示例', '下一节'])
  const codeSection = sections.find((section) => section.title === '代码示例')!
  assert.ok(codeSection.lines.includes('## 这行是代码，不是标题'))
  assert.ok(codeSection.lines.includes('代码之后的段落。'))
  // The fence survives intact so the block renderer can still recognise it.
  assert.ok(codeSection.lines.includes('```md') && codeSection.lines.includes('```'))
})

test('CRLF input is normalised and empty documents still produce one section', () => {
  const sections = splitMarkdownSections('## 一\r\n内容\r\n\r\n## 二\r\n')
  // The preamble before the first H2 always exists, even when it is empty.
  assert.deepEqual(sections.map((section) => section.title), [null, '一', '二'])
  assert.equal(sections.find((section) => section.title === '一')!.lines[0], '内容')
  assert.deepEqual(splitMarkdownSections(''), [{ key: 'section-0', title: null, lines: [''] }])
})

test('only a real H2 with a space splits, so `##无空格` and `# 一` stay content', () => {
  const source = ['##无空格的标题', '', '# 一级标题', '', '## 真标题', '内容'].join('\n')
  const sections = splitMarkdownSections(source)
  assert.deepEqual(sections.map((section) => section.title), [null, '真标题'])
  assert.ok(sections[0]!.lines.includes('##无空格的标题'))
  assert.ok(sections[0]!.lines.includes('# 一级标题'))
})
