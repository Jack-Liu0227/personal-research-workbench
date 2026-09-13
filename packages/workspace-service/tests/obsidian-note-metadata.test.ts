import { afterEach, describe, it } from 'node:test'
import { equal, match, rejects } from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ProjectIdSchema } from '@prw/contracts'
import { WorkbenchRepository } from '@prw/database'
import { IntegrationCoordinator } from '../src/integration-runtime.ts'

const roots: string[] = []
const repositories: WorkbenchRepository[] = []
const projectId = ProjectIdSchema.parse(randomUUID())

function createVault(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'prw-obsidian-metadata-'))
  roots.push(root)
  for (const [relativePath, content] of Object.entries(files)) {
    mkdirSync(join(root, relativePath, '..'), { recursive: true })
    writeFileSync(join(root, relativePath), content, 'utf8')
  }
  return root
}

/** Real SQLite repository + coordinator; only the Vault is a temporary fixture. */
function openCoordinator(vaultRoot: string): { coordinator: IntegrationCoordinator; vaultId: string } {
  const repositoryRoot = mkdtempSync(join(tmpdir(), 'prw-obsidian-metadata-db-'))
  roots.push(repositoryRoot)
  const repository = new WorkbenchRepository({ filePath: join(repositoryRoot, 'workspace.sqlite3') })
  repositories.push(repository)
  const coordinator = new IntegrationCoordinator(repository)
  const profile = coordinator.saveObsidianProfile({ name: 'Test Vault', location: vaultRoot, expectedRevision: null })
  return { coordinator, vaultId: profile.id }
}

afterEach(() => {
  // Windows keeps the SQLite handle locked until the repository is closed.
  while (repositories.length > 0) repositories.pop()!.close()
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

describe('previewNoteMetadata', () => {
  it('reports the controlled diff without writing and keeps unknown fields listed', async () => {
    const root = createVault({ '文献综述/笔记.md': '---\ntitle: 标题\ncustom_key: 保留我\nworkbench_kind: literature_review\n---\n\n正文\n' })
    const { coordinator, vaultId } = openCoordinator(root)
    const before = readFileSync(join(root, '文献综述', '笔记.md'), 'utf8')

    const preview = await coordinator.previewNoteMetadata({
      vaultId,
      relativePath: '文献综述/笔记.md',
      patch: { projectId, labels: ['reading'] }
    })

    equal(preview.relativePath, '文献综述/笔记.md')
    equal(preview.before.projectId, null)
    equal(preview.after.projectId, projectId)
    equal(preview.after.kind, 'literature_review')
    equal(preview.after.labels.includes('reading'), true)
    equal(preview.changedFields.includes('项目绑定'), true)
    equal(preview.changedFields.includes('标签'), true)
    equal(preview.preservedUnknownFields.includes('custom_key'), true)
    equal(preview.canApply, true)
    // Preview is read-only: the file on disk must still be byte-identical.
    equal(readFileSync(join(root, '文献综述', '笔记.md'), 'utf8'), before)
  })
})

describe('applyNoteMetadata', () => {
  it('writes only managed keys and keeps the body and unknown frontmatter intact', async () => {
    const root = createVault({ '文献综述/笔记.md': '---\ntitle: 标题\ncustom_key: 保留我\n---\n\n正文\n' })
    const { coordinator, vaultId } = openCoordinator(root)

    const preview = await coordinator.previewNoteMetadata({ vaultId, relativePath: '文献综述/笔记.md', patch: { projectId, kind: 'literature_review' } })
    const note = await coordinator.applyNoteMetadata({
      vaultId,
      relativePath: '文献综述/笔记.md',
      patch: { projectId, kind: 'literature_review' },
      expectedFingerprint: preview.fingerprint,
      confirmed: true
    })

    const written = readFileSync(join(root, '文献综述', '笔记.md'), 'utf8')
    match(written, /workbench_project_id/)
    match(written, /workbench_kind: "literature_review"/)
    match(written, /custom_key: 保留我/)
    match(written, /正文/)
    equal(note.projectId, projectId)
    equal(note.kind, 'literature_review')
    equal(note.parentRelativePath, null)
  })

  it('refuses a stale preview fingerprint instead of overwriting an external edit', async () => {
    const root = createVault({ '文献综述/笔记.md': '# 笔记\n\n正文\n' })
    const { coordinator, vaultId } = openCoordinator(root)

    const preview = await coordinator.previewNoteMetadata({ vaultId, relativePath: '文献综述/笔记.md', patch: { projectId } })
    // An external Obsidian edit between preview and apply must fail the CAS.
    writeFileSync(join(root, '文献综述', '笔记.md'), '# 笔记\n\n外部修改\n', 'utf8')

    await rejects(
      coordinator.applyNoteMetadata({ vaultId, relativePath: '文献综述/笔记.md', patch: { projectId }, expectedFingerprint: preview.fingerprint, confirmed: true }),
      (error: unknown) => (error as { code?: string }).code === 'EXTERNAL_CONFLICT'
    )
    equal(readFileSync(join(root, '文献综述', '笔记.md'), 'utf8'), '# 笔记\n\n外部修改\n')
  })

  it('links and unlinks a child note through the controlled parent field', async () => {
    const root = createVault({
      '文献综述/父笔记.md': '# 父笔记\n',
      '文献综述/子笔记.md': '# 子笔记\n'
    })
    const { coordinator, vaultId } = openCoordinator(root)

    const first = await coordinator.previewNoteMetadata({ vaultId, relativePath: '文献综述/子笔记.md', patch: { parentRelativePath: '文献综述/父笔记.md' } })
    const linked = await coordinator.applyNoteMetadata({
      vaultId,
      relativePath: '文献综述/子笔记.md',
      patch: { parentRelativePath: '文献综述/父笔记.md' },
      expectedFingerprint: first.fingerprint,
      confirmed: true
    })
    equal(linked.parentRelativePath, '文献综述/父笔记.md')
    match(readFileSync(join(root, '文献综述', '子笔记.md'), 'utf8'), /workbench_parent: "文献综述\/父笔记\.md"/)

    const second = await coordinator.previewNoteMetadata({ vaultId, relativePath: '文献综述/子笔记.md', patch: { parentRelativePath: null } })
    const unlinked = await coordinator.applyNoteMetadata({
      vaultId,
      relativePath: '文献综述/子笔记.md',
      patch: { parentRelativePath: null },
      expectedFingerprint: second.fingerprint,
      confirmed: true
    })
    equal(unlinked.parentRelativePath, null)
    // Managed keys are never deleted, they are rewritten to explicit YAML
    // `null` so the file keeps a stable, self-describing schema.
    match(readFileSync(join(root, '文献综述', '子笔记.md'), 'utf8'), /workbench_parent: null/)
    equal((await coordinator.readNote({ vaultId, relativePath: '文献综述/子笔记.md' })).parentRelativePath, null)
  })

  it('clears a project binding without deleting the note body', async () => {
    const root = createVault({ '文献综述/笔记.md': `---\nworkbench_project_id: ${projectId}\n---\n\n正文\n` })
    const { coordinator, vaultId } = openCoordinator(root)
    equal((await coordinator.readNote({ vaultId, relativePath: '文献综述/笔记.md' })).projectId, projectId)

    const preview = await coordinator.previewNoteMetadata({ vaultId, relativePath: '文献综述/笔记.md', patch: { projectId: null } })
    equal(preview.before.projectId, projectId)
    equal(preview.after.projectId, null)
    const cleared = await coordinator.applyNoteMetadata({ vaultId, relativePath: '文献综述/笔记.md', patch: { projectId: null }, expectedFingerprint: preview.fingerprint, confirmed: true })
    equal(cleared.projectId, null)
    match(readFileSync(join(root, '文献综述', '笔记.md'), 'utf8'), /正文/)
  })
})

describe('noteDuplicates', () => {
  it('separates a brand-new path from an existing target and a title duplicate', async () => {
    const root = createVault({
      '文献综述/已有笔记.md': '# 已有笔记\n',
      '文献矩阵/另一个目录-已有笔记.md': '#  已有笔记 \n'
    })
    const { coordinator, vaultId } = openCoordinator(root)

    const fresh = await coordinator.noteDuplicates({ vaultId, relativePath: '文献综述/新笔记.md' })
    equal(fresh.status, 'new')
    equal(fresh.targetFingerprint, null)
    equal(fresh.candidates.length, 0)

    const existing = await coordinator.noteDuplicates({ vaultId, relativePath: '文献综述/已有笔记.md' })
    equal(existing.status, 'exists')
    equal(existing.candidates[0]?.match, 'path')
    match(existing.targetFingerprint ?? '', /:/)
    // The title match in the other folder is reported next to the path match.
    equal(existing.candidates.length, 2)

    const titleOnly = await coordinator.noteDuplicates({ vaultId, relativePath: '文献综述/子目录/已有笔记.md', title: '已有笔记' })
    equal(titleOnly.status, 'duplicate')
    equal(titleOnly.targetFingerprint, null)
    equal(titleOnly.candidates.every((candidate) => candidate.match === 'title'), true)
  })
})
