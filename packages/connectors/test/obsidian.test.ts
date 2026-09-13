import { describe, it } from 'node:test'
import { deepEqual, equal, match, rejects } from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IntegrationRuntimeError } from '@prw/connectors'
import type { AdapterProfile } from '@prw/connectors'
import { createObsidianFolder, listObsidianNotes, moveObsidianEntry, readObsidianNote } from '@prw/connectors'

function createVault(): { readonly root: string; readonly profile: AdapterProfile } {
  const root = mkdtempSync(join(tmpdir(), 'prw-obsidian-move-'))
  mkdirSync(join(root, '文献矩阵'), { recursive: true })
  writeFileSync(join(root, '文献矩阵', 'note.md'), '---\ntags: ["reading"]\n---\n\n正文\n', 'utf8')
  return {
    root,
    profile: { id: 'vault-1', kind: 'obsidian', provider: 'obsidian', displayName: 'Vault', location: root, settings: {}, status: 'connected' }
  }
}

const isCode = (code: string) => (error: unknown): boolean => error instanceof IntegrationRuntimeError && error.code === code

describe('createObsidianFolder', () => {
  it('creates nested folders idempotently and stays inside the Vault', async () => {
    const vault = createVault()
    try {
      deepEqual(await createObsidianFolder(vault.profile, '写作模板'), { relativePath: '写作模板', status: 'created' })
      deepEqual(await createObsidianFolder(vault.profile, '写作模板'), { relativePath: '写作模板', status: 'exists' })
      deepEqual(await createObsidianFolder(vault.profile, '写作模板/投稿'), { relativePath: '写作模板/投稿', status: 'created' })
    } finally {
      rmSync(vault.root, { recursive: true, force: true })
    }
  })

  it('refuses traversal, .obsidian, unsafe names and file collisions', async () => {
    const vault = createVault()
    try {
      await rejects(createObsidianFolder(vault.profile, '../escape'), isCode('INVALID_MAPPING'))
      await rejects(createObsidianFolder(vault.profile, '.obsidian/plugins'), isCode('INVALID_MAPPING'))
      await rejects(createObsidianFolder(vault.profile, 'C:/outside'), isCode('INVALID_MAPPING'))
      await rejects(createObsidianFolder(vault.profile, 'bad:name'), isCode('INVALID_MAPPING'))
      await rejects(createObsidianFolder(vault.profile, 'trailing '), isCode('INVALID_MAPPING'))
      await rejects(createObsidianFolder(vault.profile, 'README.md'), isCode('INVALID_MAPPING'))
      await rejects(createObsidianFolder(vault.profile, '文献矩阵/note.md'), isCode('INVALID_MAPPING'))
    } finally {
      rmSync(vault.root, { recursive: true, force: true })
    }
  })
})

describe('moveObsidianEntry', () => {
  it('renames a note with fingerprint CAS and reports the new fingerprint', async () => {
    const vault = createVault()
    try {
      await createObsidianFolder(vault.profile, '知识库')
      const before = await readObsidianNote(vault.profile, '文献矩阵/note.md')
      const receipt = await moveObsidianEntry(vault.profile, 'file', '文献矩阵/note.md', '知识库/重命名.md', before.fingerprint)
      equal(receipt.toRelativePath, '知识库/重命名.md')
      equal(receipt.fingerprint !== null, true)
      match(readFileSync(join(vault.root, '知识库', '重命名.md'), 'utf8'), /正文/u)
      const notes = await listObsidianNotes(vault.profile)
      deepEqual(notes.filter((note) => !note.isFolder).map((note) => note.relativePath), ['知识库/重命名.md'])
    } finally {
      rmSync(vault.root, { recursive: true, force: true })
    }
  })

  it('refuses to overwrite an existing target and reports stale revisions', async () => {
    const vault = createVault()
    try {
      writeFileSync(join(vault.root, '文献矩阵', 'target.md'), '已有内容\n', 'utf8')
      const note = await readObsidianNote(vault.profile, '文献矩阵/note.md')
      await rejects(
        moveObsidianEntry(vault.profile, 'file', '文献矩阵/note.md', '文献矩阵/target.md', note.fingerprint),
        isCode('INVALID_MAPPING')
      )
      equal(readFileSync(join(vault.root, '文献矩阵', 'target.md'), 'utf8'), '已有内容\n')
      await rejects(
        moveObsidianEntry(vault.profile, 'file', '文献矩阵/note.md', '文献矩阵/moved.md', 'stale:1'),
        isCode('REVISION_CONFLICT')
      )
      await rejects(
        moveObsidianEntry(vault.profile, 'file', '文献矩阵/missing.md', '文献矩阵/moved.md', null),
        isCode('NOT_FOUND')
      )
      await rejects(
        moveObsidianEntry(vault.profile, 'file', '文献矩阵/note.md', '文献矩阵/note.txt', note.fingerprint),
        isCode('INVALID_MAPPING')
      )
      await rejects(
        moveObsidianEntry(vault.profile, 'file', '文献矩阵/note.md', '.obsidian/note.md', note.fingerprint),
        isCode('INVALID_MAPPING')
      )
      // A missing target folder is reported instead of being created silently.
      await rejects(
        moveObsidianEntry(vault.profile, 'file', '文献矩阵/note.md', '不存在的分类/note.md', note.fingerprint),
        isCode('INVALID_MAPPING')
      )
    } finally {
      rmSync(vault.root, { recursive: true, force: true })
    }
  })

  it('moves a root-level category without following links', async (context) => {
    const vault = createVault()
    try {
      deepEqual(
        await moveObsidianEntry(vault.profile, 'directory', '文献矩阵', '文献库', null),
        { kind: 'directory', fromRelativePath: '文献矩阵', toRelativePath: '文献库', fingerprint: null }
      )
      equal(readFileSync(join(vault.root, '文献库', 'note.md'), 'utf8').includes('正文'), true)
      await rejects(moveObsidianEntry(vault.profile, 'directory', '文献库', '嵌套/分类', null), isCode('INVALID_MAPPING'))
      await rejects(moveObsidianEntry(vault.profile, 'directory', '文献库', '文献库', '1:2'), isCode('INVALID_MAPPING'))
      if (process.platform === 'win32') {
        context.diagnostic('symlink creation may require Developer Mode on Windows')
      }
      try {
        symlinkSync(join(vault.root, '文献库'), join(vault.root, '链接分类'), 'junction')
        await rejects(moveObsidianEntry(vault.profile, 'directory', '链接分类', '别名', null), isCode('INVALID_MAPPING'))
      } catch (error) {
        context.diagnostic(`symlink fixture unavailable: ${String(error)}`)
      }
    } finally {
      rmSync(vault.root, { recursive: true, force: true })
    }
  })

  it('treats an unchanged path as a no-op and refuses a file used as a parent', async () => {
    const vault = createVault()
    try {
      const note = await readObsidianNote(vault.profile, '文献矩阵/note.md')
      deepEqual(
        await moveObsidianEntry(vault.profile, 'file', '文献矩阵/note.md', '文献矩阵/note.md', note.fingerprint),
        { kind: 'file', fromRelativePath: '文献矩阵/note.md', toRelativePath: '文献矩阵/note.md', fingerprint: note.fingerprint }
      )
      await rejects(
        moveObsidianEntry(vault.profile, 'file', '文献矩阵/note.md', '文献矩阵/note.md/nested.md', note.fingerprint),
        isCode('INVALID_MAPPING')
      )
    } finally {
      rmSync(vault.root, { recursive: true, force: true })
    }
  })
})
