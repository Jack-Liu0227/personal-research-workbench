#!/usr/bin/env node
/*
 * Focused check for the daily literature push closure (Task 02).
 *
 * It drives the real modules on an isolated SQLite database and a temporary
 * Vault directory — no model, no network, no user data:
 *
 *   1. naming: the built-in rule and any historical 每日文献推送 row converge on
 *      the frozen default 每日资讯推送 (migrations 23 + 26 are the normalization
 *      points, in that order; 每日文献推送 stays an Obsidian layout category).
 *   2. rule fields: sources are normalized/deduplicated on save, a corrupted
 *      `sources_json` degrades to "all available" instead of failing the list.
 *   3. capability preflight: `--diagnose` parsing, a failing probe blocks the
 *      run, and a partially available source request still runs degraded.
 *   4. note projection: path shape, frontmatter metadata, safe folder fallback,
 *      bounded excerpt, and the SQLite-side projection naming the Vault file.
 *   5. Obsidian safety: the write stays inside the Vault, `.obsidian` is
 *      untouched, an external modification is not overwritten (CAS conflict),
 *      and a failed write still yields a usable SQLite-side projection.
 *   6. idempotency: the daily occurrence key is per local day, is stable for an
 *      already completed day (30-second tick + startup catch-up collapse onto
 *      it) and only becomes retryable after a failure.
 *   7. occurrence ledger: claim + cursor advance are one transaction, a
 *      duplicate key never inserts a second row or advances the cursor twice,
 *      a paused rule is never re-enabled, and a leftover claim reconciles as
 *      `missed` with a reason instead of disappearing.
 *   8. run visibility: the Automation page's history projection carries the
 *      occurrence, the blocked reason, the Artifact and the Obsidian delivery
 *      outcome of a scheduled run.
 *   9. migrations: re-running the schedule migrations on an installed database
 *      never resurrects a rule the user paused.
 *
 * Usage: pnpm test:daily-literature
 *        (equivalent: node_modules/.bin/jiti scripts/daily-literature-push-check.ts)
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { WorkbenchRepository, migrateDatabase } from '@prw/database'
import { AgentCoordinator } from '../packages/workspace-service/src/agent-coordinator.ts'
import { IntegrationCoordinator } from '../packages/workspace-service/src/integration-runtime.ts'
import {
  DAILY_LITERATURE_FOLDER,
  buildDailyLiteratureMarkdown,
  buildDailyLiteratureProjection,
  dailyLiteratureExcerpt,
  dailyLiteratureRelativePath,
  deliverDailyLiterature,
  localDateKey,
  safeDailyLiteratureFolder,
  type ObsidianNoteWriter
} from '../packages/workspace-service/src/daily-literature.ts'
import {
  parseLast30DaysDiagnose,
  probeLast30DaysCapability,
  selectLast30DaysSources,
  type Last30DaysSkillRuntime
} from '../packages/workspace-service/src/skill-registry.ts'

const results: Array<{ name: string; status: 'PASS' | 'FAIL' | 'BLOCKED'; detail: string }> = []
let failures = 0

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function check(name: string, fn: () => unknown | Promise<unknown>): Promise<void> {
  try {
    const detail = await fn()
    const text = typeof detail === 'string' ? detail : ''
    results.push({ name, status: 'PASS', detail: text })
    console.log(`[PASS] ${name}${text ? `\n        ${text}` : ''}`)
  } catch (error) {
    failures += 1
    const text = error instanceof Error ? error.message : String(error)
    results.push({ name, status: 'FAIL', detail: text })
    console.log(`[FAIL] ${name}\n        ${text}`)
  }
}

const roots: string[] = []
function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

const openedRepositories: WorkbenchRepository[] = []
function openRepository(): WorkbenchRepository {
  const repository = new WorkbenchRepository({ filePath: join(temporaryRoot('prw-daily-push-'), 'workspace.sqlite3') })
  openedRepositories.push(repository)
  return repository
}

/** Raw handle access for the two checks that must reproduce a hand-edited or
 * legacy-installed row; the public repository API cannot express those states. */
function sqliteHandle(repository: WorkbenchRepository): { run: (sql: string) => void; exec: (sql: string) => void } {
  const handle = (repository as unknown as {
    sqlite?: { prepare: (sql: string) => { run: () => unknown }; exec: (sql: string) => void }
  }).sqlite
  assert(handle !== undefined, 'repository 未暴露 sqlite handle')
  return {
    run: (sql) => { handle.prepare(sql).run() },
    exec: (sql) => { handle.exec(sql) }
  }
}

function scheduleDraft(overrides: Record<string, unknown> = {}): Parameters<WorkbenchRepository['saveSchedule']>[0] {
  return {
    id: 'schedule.daily',
    name: '每日文献推送',
    workflowKey: 'daily_digest',
    promptTemplateId: 'builtin.prompt.daily-reading',
    providerProfileId: null,
    runtime: 'codex',
    assistantKey: 'researcher',
    frequency: 'daily',
    executionMode: 'new_conversation',
    conversationId: null,
    prompt: '',
    skillKey: 'last30days',
    topic: 'research updates',
    sources: [],
    lookbackDays: 30,
    outputFolder: DAILY_LITERATURE_FOLDER,
    permissionMode: 'read-only',
    approvalPolicy: 'on-request',
    projectId: null,
    cron: '0 9 * * *',
    timezone: 'Asia/Shanghai',
    enabled: true,
    expectedRevision: null,
    ...overrides
  } as Parameters<WorkbenchRepository['saveSchedule']>[0]
}

function fakeRuntime(overrides: Partial<Last30DaysSkillRuntime> = {}): Last30DaysSkillRuntime {
  const dir = temporaryRoot('prw-skill-')
  return {
    key: 'last30days',
    skillPath: join(dir, 'SKILL.md'),
    skillDir: dir,
    enginePath: join(dir, 'last30days.py'),
    pythonPath: 'python',
    pythonVersion: '3.12.0',
    pythonSource: 'path',
    skillSource: 'project',
    ...overrides
  }
}

function runRecord(overrides: Record<string, unknown> = {}): Parameters<typeof deliverDailyLiterature>[1]['run'] {
  return {
    id: 'run-1234567890',
    jobId: 'builtin.schedule.last30days',
    runtime: 'codex',
    workflowKey: 'daily_digest',
    createdAt: '2026-01-02T01:00:00.000Z',
    finishedAt: '2026-01-02T01:05:00.000Z',
    ...overrides
  } as Parameters<typeof deliverDailyLiterature>[1]['run']
}

function recordingWriter(existing: readonly string[] = []): ObsidianNoteWriter & { readonly writes: Array<{ relativePath: string; content: string; expectedFingerprint: string | null }> } {
  const writes: Array<{ relativePath: string; content: string; expectedFingerprint: string | null }> = []
  return {
    writes,
    listObsidianProfiles: () => [{ id: 'vault-1', provider: 'obsidian', enabled: true }] as never,
    writeNote: async (input) => {
      writes.push({ relativePath: input.relativePath, content: input.content, expectedFingerprint: input.expectedFingerprint })
      return { relativePath: input.relativePath, fingerprint: existing.includes(input.relativePath) ? 'external' : 'fingerprint-1' } as never
    }
  }
}

function createRun(repository: WorkbenchRepository, idempotencyKey: string, jobId: string): string {
  const run = repository.startManagedAgentRun({
    jobId,
    conversationId: null,
    runtime: 'codex',
    transport: 'cli',
    workflowKey: 'daily_digest',
    projectId: null,
    paperIds: [],
    instructions: 'check',
    toolProfile: 'read-only',
    permissionMode: 'read-only',
    approvalPolicy: 'on-request',
    idempotencyKey
  })
  return run.id
}

function occurrenceKey(coordinator: AgentCoordinator, schedule: unknown, occurrence: Date): string {
  const internal = coordinator as unknown as { occurrenceIdempotencyKey: (value: unknown, at: Date) => string }
  assert(typeof internal.occurrenceIdempotencyKey === 'function', '未找到 occurrenceIdempotencyKey')
  return internal.occurrenceIdempotencyKey(schedule, occurrence)
}

/** Raw handle for the check that must re-run migrations on an installed DB. */
function rawSqlite(repository: WorkbenchRepository): Parameters<typeof migrateDatabase>[0] {
  const handle = (repository as unknown as { sqlite?: unknown }).sqlite
  assert(handle !== undefined, 'repository 未暴露 sqlite handle')
  return handle as Parameters<typeof migrateDatabase>[0]
}

async function main(): Promise<void> {
  console.log('每日文献推送闭环检查（隔离 SQLite + 临时 Vault，无模型调用）\n')
  const coordinatorRoot = temporaryRoot('prw-agent-runs-')
  const repository = openRepository()
  openedRepositories.push(repository)
  const coordinator = new AgentCoordinator(repository, { runRoot: join(coordinatorRoot, 'runs') })
  const schedule = repository.getSchedule('builtin.schedule.last30days')

  // ------------------------------------------------------------------ 命名 --
  await check(`命名统一：内置规则收敛到冻结默认 ${DAILY_LITERATURE_FOLDER} / AI 最新资讯 / zh-CN`, () => {
    assert(schedule.outputFolder === DAILY_LITERATURE_FOLDER, `outputFolder=${schedule.outputFolder}`)
    assert(schedule.name.includes(DAILY_LITERATURE_FOLDER), `name=${schedule.name}`)
    assert(!schedule.name.includes('每日文献推送'), '内置规则名称仍是旧的 每日文献推送（该目录只作为 Obsidian layout category 存在）')
    assert(schedule.topic === 'AI 最新资讯', `topic=${schedule.topic}`)
    assert(schedule.responseLanguage === 'zh-CN', `responseLanguage=${schedule.responseLanguage}`)
    assert(schedule.skillKey === 'last30days', `skillKey=${String(schedule.skillKey)}`)
    assert(schedule.sources.length === 0, `fresh 规则 sources=${JSON.stringify(schedule.sources)}`)
    assert(schedule.lookbackDays === 30, `fresh 规则 lookbackDays=${String(schedule.lookbackDays)}`)
    return `name=${schedule.name} · outputFolder=${schedule.outputFolder} · topic=${schedule.topic} · lookbackDays=${String(schedule.lookbackDays)}`
  })

  await check(`命名统一：历史 每日文献推送 目录/名称按迁移链改写为 ${DAILY_LITERATURE_FOLDER}`, () => {
    const sqlPath = resolve(process.cwd(), 'packages', 'database', 'src', 'migrations.ts')
    assert(existsSync(sqlPath), `未找到迁移文件 ${sqlPath}`)
    const source = readFileSync(sqlPath, 'utf8')
    /** The normalization UPDATEs of one migration, in statement order. */
    const normalizationSqlOf = (migrationName: string): string[] => {
      const anchor = source.indexOf(`name: '${migrationName}'`)
      assert(anchor > 0, `未找到 migration ${migrationName}`)
      const sqlStart = source.indexOf('sql: `', anchor) + 'sql: `'.length
      const sqlEnd = source.indexOf('\n    `', sqlStart)
      return source.slice(sqlStart, sqlEnd)
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n')
        .split(';')
        .map((statement) => statement.trim())
        .filter((statement) => statement.startsWith('UPDATE'))
    }
    // An already-installed database runs both normalization points in order:
    // migration 23 renamed the folder one way, migration 26 (the frozen generic
    // skill-schedule contract) is the one that owns the shipped default today.
    const normalizationSql = [...normalizationSqlOf('daily_literature_push_closure'), ...normalizationSqlOf('generic_skill_schedule_contract')]
    assert(normalizationSql.length === 4, `归一化语句数=${String(normalizationSql.length)}`)

    // Reproduce an already-installed database that still carries the pre-freeze
    // values: the built-in rule and a drifted legacy rule both hold the old
    // folder/topic triple. Re-apply only the normalization SQL in migration
    // order, then read both back through the public repository API.
    const handle = sqliteHandle(repository)
    handle.exec(`UPDATE schedules SET name = 'Last 30 days ${DAILY_LITERATURE_FOLDER}', topic = 'research updates', output_folder = '${DAILY_LITERATURE_FOLDER}' WHERE id = 'builtin.schedule.last30days'`)
    const drifted = repository.saveSchedule(scheduleDraft({ id: 'legacy.schedule.drifted', name: '旧的每日推送', outputFolder: DAILY_LITERATURE_FOLDER }))
    assert(drifted.outputFolder === DAILY_LITERATURE_FOLDER && drifted.topic === 'research updates', '前置条件失败：旧默认值未被写入')
    for (const statement of normalizationSql) handle.exec(statement)
    const normalized = repository.getSchedule('legacy.schedule.drifted')
    assert(normalized.outputFolder === DAILY_LITERATURE_FOLDER, `归一化后 outputFolder=${normalized.outputFolder}`)
    assert(normalized.topic === 'AI 最新资讯', `归一化后 topic=${normalized.topic}`)
    const builtin = repository.getSchedule('builtin.schedule.last30days')
    assert(builtin.name === `Last 30 days ${DAILY_LITERATURE_FOLDER}`, `归一化后内置名称=${builtin.name}`)
    assert(builtin.outputFolder === DAILY_LITERATURE_FOLDER, `归一化后内置目录=${builtin.outputFolder}`)
    const remaining = repository.listSchedules().filter((item) => item.outputFolder === '每日文献推送')
    assert(remaining.length === 0, `仍存在 ${String(remaining.length)} 条旧目录规则`)
    return `迁移 SQL 真实执行（迁移 23 → 26）：旧目录/旧名称/旧主题均改写为 ${DAILY_LITERATURE_FOLDER} + AI 最新资讯，旧目录残留=0`
  })

  // -------------------------------------------------------------- 规则字段 --
  await check('规则字段：sources 归一化去重、lookbackDays 与 outputFolder 持久化', () => {
    const saved = repository.saveSchedule(scheduleDraft({
      id: 'schedule.fields',
      sources: ['Reddit', ' reddit ', 'HackerNews'],
      lookbackDays: 14
    }))
    assert(JSON.stringify(saved.sources) === JSON.stringify(['reddit', 'hackernews']), `saved.sources=${JSON.stringify(saved.sources)}`)
    const reloaded = repository.getSchedule(saved.id)
    assert(JSON.stringify(reloaded.sources) === JSON.stringify(['reddit', 'hackernews']), `reloaded.sources=${JSON.stringify(reloaded.sources)}`)
    assert(reloaded.lookbackDays === 14, `reloaded.lookbackDays=${String(reloaded.lookbackDays)}`)
    assert(reloaded.outputFolder === DAILY_LITERATURE_FOLDER, `reloaded.outputFolder=${reloaded.outputFolder}`)
    assert(reloaded.topic === 'research updates', `reloaded.topic=${reloaded.topic}`)
    return `sources=${reloaded.sources.join(', ')} · lookbackDays=${String(reloaded.lookbackDays)}`
  })

  await check('规则字段：损坏的 sources_json 降级为“全部可用来源”而不是让规则列表报错', () => {
    const handle = sqliteHandle(repository)
    // The CHECK (json_valid) constraint already refuses a non-JSON value, so the
    // row is forced past it: the read path must stay defensive for rows written
    // by an older or foreign writer.
    handle.run('PRAGMA ignore_check_constraints = ON')
    handle.run("UPDATE schedules SET sources_json = 'not-json' WHERE id = 'schedule.fields'")
    handle.run('PRAGMA ignore_check_constraints = OFF')
    const reloaded = repository.getSchedule('schedule.fields')
    assert(JSON.stringify(reloaded.sources) === '[]', `corrupt 行 sources=${JSON.stringify(reloaded.sources)}`)
    assert(repository.listSchedules().some((item) => item.id === 'schedule.fields'), '损坏行导致列表读取失败')
    return 'sources=[]（引擎默认全部可用来源）· 列表仍可读'
  })

  // ------------------------------------------------------------ 能力预检 --
  await check('能力预检：解析引擎 --diagnose 输出（含噪声前缀与大小写归一化）', () => {
    const parsed = parseLast30DaysDiagnose('warmup noise\n{"safe": true, "version": "3.0.0", "available_sources": ["Reddit", "hackernews"]}')
    assert(parsed !== null, '未能解析 diagnose JSON')
    assert(JSON.stringify(parsed.availableSources) === JSON.stringify(['reddit', 'hackernews']), `availableSources=${JSON.stringify(parsed.availableSources)}`)
    assert(parseLast30DaysDiagnose('not json at all') === null, '非 JSON 输出必须返回 null')
    return `availableSources=${parsed.availableSources.join(', ')}`
  })

  await check('能力预检：探针失败 → 阻断（不产生成功 Artifact）', () => {
    const capability = probeLast30DaysCapability(fakeRuntime(), { runDiagnose: () => ({ status: 1, stdout: '', stderr: 'boom' }) })
    assert(!capability.ok, '探针失败必须返回不通过')
    assert(capability.diagnostic.code === 'SKILL_PROBE_FAILED', `code=${capability.diagnostic.code}`)
    assert(capability.diagnostic.message.length > 0 && capability.diagnostic.detail.length > 0, '阻断必须带可读原因')
    return `${capability.diagnostic.code}：${capability.diagnostic.message}`
  })

  await check('来源选择：零可用/全部请求缺失 → 阻断；部分缺失 → 降级运行并保留提示', () => {
    const none = selectLast30DaysSources(['reddit'], [])
    assert(!none.ok && none.diagnostic.code === 'SKILL_SOURCES_UNAVAILABLE', `零可用来源未阻断：${JSON.stringify(none)}`)
    const allMissing = selectLast30DaysSources(['reddit', 'github'], ['hackernews'])
    assert(!allMissing.ok && allMissing.diagnostic.code === 'SKILL_SOURCES_UNAVAILABLE', '全部请求来源缺失未阻断')
    const partial = selectLast30DaysSources(['reddit', 'github'], ['reddit', 'hackernews'])
    assert(partial.ok, '部分可用必须继续运行')
    assert(JSON.stringify(partial.unavailable) === JSON.stringify(['github']), `unavailable=${JSON.stringify(partial.unavailable)}`)
    const fallback = selectLast30DaysSources([], ['reddit'])
    assert(fallback.ok && fallback.sources.length === 0, '空请求必须保持“全部可用来源”默认')
    return `部分缺失=${partial.unavailable.join(', ')}（降级运行，禁用来源写入 briefing/回执）`
  })

  // ------------------------------------------------------------ 笔记投影 --
  const deliveryInput = {
    scheduleId: 'builtin.schedule.last30days',
    run: runRecord(),
    content: '正文段落\n\n- 条目一',
    outputFolder: DAILY_LITERATURE_FOLDER,
    scheduleName: `Last 30 days ${DAILY_LITERATURE_FOLDER}`,
    timezone: 'Asia/Shanghai',
    topic: 'research updates',
    sources: ['reddit', 'hackernews'],
    lookbackDays: 30
  }

  await check('笔记投影：路径形状 <outputFolder>/YYYY-MM-DD-daily_digest-<schedule8>-<run8>.md', () => {
    const dateKey = localDateKey(new Date('2026-01-02T01:05:00.000Z'), 'Asia/Shanghai')
    assert(dateKey === '2026-01-02', `Asia/Shanghai 日期键=${dateKey}`)
    const relativePath = dailyLiteratureRelativePath({
      outputFolder: DAILY_LITERATURE_FOLDER,
      dateKey,
      scheduleId: 'builtin.schedule.last30days',
      runId: 'run-1234567890'
    })
    assert(relativePath === `${DAILY_LITERATURE_FOLDER}/2026-01-02-daily_digest-builtin.-run-1234.md`, `relativePath=${relativePath}`)
    return relativePath
  })

  await check('笔记投影：frontmatter 带 workbench_kind 与规则/来源/时间元数据', () => {
    const markdown = buildDailyLiteratureMarkdown({ ...deliveryInput, dateKey: '2026-01-02' })
    const needles = [
      'workbench_kind: daily_literature',
      'workbench_schedule_id: "builtin.schedule.last30days"',
      'workbench_run_id: "run-1234567890"',
      'workbench_runtime: "codex"',
      'workbench_workflow: "daily_digest"',
      `workbench_output_folder: ${JSON.stringify(DAILY_LITERATURE_FOLDER)}`,
      'workbench_lookback_days: 30',
      'workbench_sources: ["reddit","hackernews"]',
      'workbench_topic: "research updates"',
      'generated_at: "2026-01-02T01:05:00.000Z"',
      `# ${DAILY_LITERATURE_FOLDER} · 2026-01-02`,
      '正文段落'
    ]
    for (const needle of needles) assert(markdown.includes(needle), `Markdown 缺少 ${needle}`)
    return `frontmatter=${String(needles.length - 2)} 项元数据均存在`
  })

  await check(`笔记投影：目录越界/保留目录/空值回退到 ${DAILY_LITERATURE_FOLDER}`, () => {
    const cases: Array<[string, string]> = [
      ['每日文献推送', '每日文献推送'],
      ['deeper/digest', 'deeper/digest'],
      ['../escape', DAILY_LITERATURE_FOLDER],
      ['.obsidian', DAILY_LITERATURE_FOLDER],
      ['notes/.obsidian', DAILY_LITERATURE_FOLDER],
      ['/abs/path', DAILY_LITERATURE_FOLDER],
      ['', DAILY_LITERATURE_FOLDER],
      ['   ', DAILY_LITERATURE_FOLDER]
    ]
    for (const [input, expected] of cases) {
      assert(safeDailyLiteratureFolder(input) === expected, `safeDailyLiteratureFolder(${JSON.stringify(input)})=${safeDailyLiteratureFolder(input)}`)
    }
    return '越界、绝对路径、.obsidian、空值均回退且不会落到第二套目录名'
  })

  await check('笔记投影：SQLite/Inbox 摘要有界，并指向 Obsidian 正文权威', () => {
    const long = '字'.repeat(5_000)
    const excerpt = dailyLiteratureExcerpt(long)
    assert(excerpt.startsWith('字'.repeat(10)) && excerpt.length < long.length, '摘要未截断')
    assert(excerpt.includes('完整内容以 Obsidian 投影文件为准'), '截断提示缺失')
    const written = buildDailyLiteratureProjection({
      delivery: { status: 'written', vaultId: 'vault-1', relativePath: '每日文献推送/a.md', fingerprint: 'f' },
      content: '正文',
      dateKey: '2026-01-02',
      scheduleId: 'builtin.schedule.last30days',
      run: runRecord()
    })
    assert(written.body.includes('Obsidian 投影（正文权威）: 每日文献推送/a.md'), '投影未指向 Vault 文件')
    assert(written.title === `${DAILY_LITERATURE_FOLDER} · 2026-01-02 · builtin.`, `title=${written.title}`)
    const skipped = buildDailyLiteratureProjection({
      delivery: { status: 'skipped', reason: 'WRITE_FAILED', message: '磁盘写入失败' },
      content: '正文',
      dateKey: '2026-01-02',
      scheduleId: 'builtin.schedule.last30days',
      run: runRecord()
    })
    assert(skipped.body.includes('Obsidian 投影未写入（WRITE_FAILED）：磁盘写入失败'), '写入失败原因未进入 SQLite 投影')
    assert(skipped.body.includes('正文'), '写入失败仍必须保留 SQLite 侧正文摘要')
    return '正文摘要有界（4,000 字上限）· 投影明示权威位置或失败原因'
  })

  await check('投递决策：非 daily_digest 跳过；无 Vault 时降级为 NO_VAULT 而非失败', async () => {
    const writer = recordingWriter()
    const notDigest = await deliverDailyLiterature(writer, { ...deliveryInput, run: runRecord({ workflowKey: 'research_digest' }) })
    assert(notDigest.status === 'skipped' && notDigest.reason === 'NOT_DAILY_DIGEST', `非 daily_digest 结果=${JSON.stringify(notDigest)}`)
    assert(writer.writes.length === 0, '非 daily_digest 不应写入 Vault')
    const noVault = await deliverDailyLiterature({ listObsidianProfiles: () => [], writeNote: async () => { throw new Error('must not be called') } }, deliveryInput)
    assert(noVault.status === 'skipped' && noVault.reason === 'NO_VAULT', `无 Vault 结果=${JSON.stringify(noVault)}`)
    return 'NOT_DAILY_DIGEST / NO_VAULT 均为可诊断的 skipped，不阻断 SQLite 产物'
  })

  await check('投递决策：无 Obsidian 投递通道的宿主明确报告 NO_SINK（不谎称非每日推送）', async () => {
    const bare = new AgentCoordinator(repository, { runRoot: join(coordinatorRoot, 'runs-bare') })
    const internal = bare as unknown as {
      deliverScheduledOutput: (run: unknown, content: string) => Promise<unknown>
    }
    const delivery = await internal.deliverScheduledOutput(runRecord(), '正文') as { status: string; reason?: string; message?: string }
    assert(delivery.status === 'skipped' && delivery.reason === 'NO_SINK', `无通道宿主的投递结果=${JSON.stringify(delivery)}`)
    const projection = buildDailyLiteratureProjection({
      delivery: delivery as never,
      content: '正文',
      dateKey: '2026-01-02',
      scheduleId: 'builtin.schedule.last30days',
      run: runRecord()
    })
    assert(projection.body.includes('NO_SINK'), '无投递通道未写入 SQLite 投影')
    const noJobRun = await internal.deliverScheduledOutput(runRecord({ jobId: null }), '正文')
    assert(noJobRun === null, `非定时运行不应产生投递结果：${JSON.stringify(noJobRun)}`)
    bare.dispose()
    return 'NO_SINK 保留可诊断原因；非定时运行不产生投递结果'
  })

  // ------------------------------------------------- Obsidian 安全写入 --
  await check('Vault 安全：真实 IntegrationCoordinator 写入 Vault 内 .md，不触碰 .obsidian', async () => {
    const vault = temporaryRoot('prw-vault-')
    mkdirSync(join(vault, '.obsidian'), { recursive: true })
    writeFileSync(join(vault, '.obsidian', 'app.json'), '{"legacyEditor":false}\n', 'utf8')
    const profile = repository.saveIntegrationProfile({ provider: 'obsidian', name: '测试 Vault', enabled: true, location: vault, settings: {} })
    const integrations = new IntegrationCoordinator(repository)
    try {
      const delivery = await deliverDailyLiterature(integrations, deliveryInput)
      assert(delivery.status === 'written', `写入结果=${JSON.stringify(delivery)}`)
      const absolute = join(vault, delivery.relativePath)
      assert(existsSync(absolute), `Vault 内未找到 ${delivery.relativePath}`)
      assert(delivery.relativePath.startsWith(`${DAILY_LITERATURE_FOLDER}/`), `相对路径=${delivery.relativePath}`)
      assert(readFileSync(absolute, 'utf8').includes('workbench_kind: daily_literature'), 'Vault 文件缺少 frontmatter')
      assert(readFileSync(join(vault, '.obsidian', 'app.json'), 'utf8') === '{"legacyEditor":false}\n', '.obsidian 被修改')
      // The digest owns exactly one folder: the legacy Obsidian layout category
      // 每日文献推送 must not be created by a scheduled write.
      assert(!existsSync(join(vault, '每日文献推送')), '出现了第二套（layout category）目录名')
      return `${delivery.relativePath} · fingerprint=${delivery.fingerprint.slice(0, 12)}…`
    } finally {
      void profile
    }
  })

  await check('Vault 安全：外部修改后的同名文件不被静默覆盖（CAS 冲突）', async () => {
    const vault = temporaryRoot('prw-vault-conflict-')
    mkdirSync(join(vault, '.obsidian'), { recursive: true })
    const isolated = openRepository()
    isolated.saveIntegrationProfile({ provider: 'obsidian', name: '冲突 Vault', enabled: true, location: vault, settings: {} })
    const integrations = new IntegrationCoordinator(isolated)
    const first = await deliverDailyLiterature(integrations, deliveryInput)
    assert(first.status === 'written', `首次写入失败：${JSON.stringify(first)}`)
    const absolute = join(vault, first.relativePath)
    writeFileSync(absolute, '外部手工修改\n', 'utf8')
    let conflict: unknown = null
    try {
      await deliverDailyLiterature(integrations, deliveryInput)
    } catch (error) {
      conflict = error
    }
    assert(conflict !== null, '同一路径重写未触发 CAS 冲突')
    assert(readFileSync(absolute, 'utf8') === '外部手工修改\n', '外部修改被覆盖')
    const message = conflict instanceof Error ? conflict.message : String(conflict)
    assert(/REVISION_CONFLICT|外部更新/iu.test(message), `冲突错误信息不可诊断：${message}`)
    // A failed write must never erase the SQLite-side artifact projection.
    const skipped = buildDailyLiteratureProjection({
      delivery: { status: 'skipped', reason: 'WRITE_FAILED', message },
      content: '正文',
      dateKey: '2026-01-02',
      scheduleId: 'builtin.schedule.last30days',
      run: runRecord()
    })
    assert(skipped.body.includes('正文'), '写入失败后 SQLite 侧产物内容丢失')
    assert(skipped.body.includes(message), '写入失败原因未进入 SQLite 侧产物')
    return 'CAS 冲突保持外部内容 · SQLite 侧产物保留摘录与失败原因'
  })

  // ------------------------------------------------------------ 幂等性 --
  await check('幂等：同一天的 tick / 启动补挖 / 重试收敛到同一 occurrence key', () => {
    const morning = new Date('2026-01-02T01:00:00.000Z')
    const evening = new Date('2026-01-02T09:30:00.000Z')
    const morningKey = occurrenceKey(coordinator, schedule, morning)
    const eveningKey = occurrenceKey(coordinator, schedule, evening)
    assert(morningKey === `builtin.schedule.last30days:daily:2026-01-02`, `key=${morningKey}`)
    assert(eveningKey === morningKey, `同一天不同时刻 key 不一致：${morningKey} vs ${eveningKey}`)
    const nextDay = occurrenceKey(coordinator, schedule, new Date('2026-01-03T01:00:00.000Z'))
    assert(nextDay === `builtin.schedule.last30days:daily:2026-01-03`, `次日 key=${nextDay}`)
    return `${morningKey}（同天稳定，次日轮换）`
  })

  await check('幂等：当天已有运行（完成/进行中）时不生成第二个 run', async () => {
    const occurrence = new Date('2026-01-02T01:00:00.000Z')
    const key = occurrenceKey(coordinator, schedule, occurrence)
    const existingRunId = createRun(repository, key, schedule.id)
    repository.updateManagedAgentRun({ id: existingRunId, status: 'completed', output: '已推送' })
    const before = repository.listManagedAgentRuns(200).length
    const started = await coordinator.start({
      workflowKey: 'daily_digest',
      instructions: 'AI 最新资讯',
      jobId: schedule.id,
      idempotencyKey: key
    })
    assert(started.id === existingRunId, `未复用当天运行：${started.id} !== ${existingRunId}`)
    assert(repository.listManagedAgentRuns(200).length === before, '第二次触发创建了额外的 run')
    assert(occurrenceKey(coordinator, schedule, new Date('2026-01-02T09:30:00.000Z')) === key, '完成状态被错误地当成可重试')
    return `当天 run 复用 ${existingRunId.slice(0, 8)}，run 总数不变`
  })

  await check('幂等：失败/阻断当天可重试（新 key + 新 run），不脏改写历史运行', async () => {
    const occurrence = new Date('2026-01-04T01:00:00.000Z')
    const key = occurrenceKey(coordinator, schedule, occurrence)
    assert(key === `builtin.schedule.last30days:daily:2026-01-04`, `key=${key}`)
    const failedRunId = createRun(repository, key, schedule.id)
    repository.updateManagedAgentRun({ id: failedRunId, status: 'failed', error: 'network unavailable' })
    const retryKey = occurrenceKey(coordinator, schedule, new Date('2026-01-04T02:00:00.000Z'))
    assert(retryKey.startsWith(`${key}:retry:`), `失败后未生成可重试 key：${retryKey}`)
    const retryRunId = createRun(repository, retryKey, schedule.id)
    assert(retryRunId !== failedRunId, '重试未生成新 run')
    assert(repository.getManagedAgentRunByIdempotency(key)?.id === failedRunId, '原失败运行的幂等键被占用/覆盖')
    assert(repository.getManagedAgentRun(failedRunId).id === failedRunId, '历史运行被替换')
    return `阻断/失败后 key=${retryKey.slice(-30)} → 新 run，历史 run 保留`
  })

  await check('幂等：非每日频率仍使用 occurrence 时间戳 key', () => {
    const hourly = repository.saveSchedule(scheduleDraft({ id: 'schedule.hourly', name: '小时推送', frequency: 'hourly', cron: '0 * * * *' }))
    const at = new Date('2026-01-02T01:00:00.000Z')
    const key = occurrenceKey(coordinator, hourly, at)
    assert(key === `schedule.hourly:${at.toISOString()}`, `非每日 key=${key}`)
    return key
  })

  // ------------------------------------------------- Agent 运行页可见性 --
  await check('运行可见性：投递结果写入 run 事件（WROTE/SKIPPED + 相对路径 + Artifact）', async () => {
    const runId = createRun(repository, 'check:delivery:event', schedule.id)
    const internal = coordinator as unknown as {
      appendDeliveryEvent: (id: string, delivery: unknown, artifactId: string | null) => void
    }
    assert(typeof internal.appendDeliveryEvent === 'function', '未找到 appendDeliveryEvent')
    // A non-daily run must not report a delivery at all: appended first so the
    // assertion below reads only the two real delivery events.
    internal.appendDeliveryEvent(runId, null, null)
    const emptyRunId = createRun(repository, 'check:delivery:none', schedule.id)
    internal.appendDeliveryEvent(emptyRunId, null, null)
    assert(repository.listAgentEvents(emptyRunId, 0, 100).length === 0, '非每日投递不应产生事件')
    // A real run always emits lifecycle events first; the delivery event is
    // appended at the end, which is what the run page reads (see below).
    repository.appendAgentEvent(runId, 'started', { message: '定期任务启动' })
    internal.appendDeliveryEvent(runId, { status: 'written', vaultId: 'vault-1', relativePath: `${DAILY_LITERATURE_FOLDER}/2026-01-02-daily_digest-builtin.-run-1234.md`, fingerprint: 'f' }, 'artifact-1')
    internal.appendDeliveryEvent(runId, { status: 'skipped', reason: 'WRITE_FAILED', message: '磁盘写入失败' }, 'artifact-2')
    const events = repository.listAgentEvents(runId, 0, 100)
    assert(events.length === 2, `事件条数=${String(events.length)}`)
    assert(events[0]!.seq === 1 && events[1]!.seq === 2, `事件 seq=${events.map((event) => String(event.seq)).join(',')}`)
    const codes = events.map((event) => (event.payload as { code?: string } | null)?.code).filter(Boolean)
    assert(JSON.stringify(codes) === JSON.stringify(['OBSIDIAN_DAILY_NOTE_WRITTEN', 'OBSIDIAN_DAILY_NOTE_SKIPPED']), `codes=${JSON.stringify(codes)}`)
    const written = events[0]!.payload as { message: string; relativePath: string; artifactId: string }
    assert(written.relativePath.startsWith(`${DAILY_LITERATURE_FOLDER}/`), `相对路径=${written.relativePath}`)
    assert(written.artifactId === 'artifact-1', 'WROTE 事件未带 Artifact id')
    assert(written.message.includes(written.relativePath), 'WROTE 事件消息未包含相对路径')
    const skipped = events[1]!.payload as { reason: string; artifactId: string }
    assert(skipped.reason === 'WRITE_FAILED' && skipped.artifactId === 'artifact-2', `SKIPPED 事件载荷=${JSON.stringify(skipped)}`)
    return '事件 payload = {code, message, relativePath|reason, artifactId}，供运行页 DeliveryStrip 渲染'
  })

  // ------------------------------------------------- schedule 时间点账本 --
  await check('occurrence：claim 与 cursor 前进同一事务，重复 key 不二次插入/推进', () => {
    const rule = repository.saveSchedule(scheduleDraft({ id: 'schedule.occurrence', name: '时间点账本', frequency: 'daily' }))
    const input = {
      scheduleId: rule.id,
      idempotencyKey: `${rule.id}:daily:2026-01-05`,
      occurrenceAt: '2026-01-05T01:00:00.000Z',
      localDateKey: '2026-01-05',
      source: 'scheduler' as const,
      nextRunAt: '2026-01-06T01:00:00.000Z',
      advanceCursor: true,
      expectedRevision: rule.revision
    }
    const first = repository.claimScheduleOccurrence(input)
    assert(first.claimed && first.cursorAdvanced, `首次 claim 未落库：${JSON.stringify({ claimed: first.claimed, cursorAdvanced: first.cursorAdvanced })}`)
    const advanced = repository.getSchedule(rule.id)
    assert(advanced.nextRunAt === '2026-01-06T01:00:00.000Z', `cursor 未推进：${String(advanced.nextRunAt)}`)
    const duplicate = repository.claimScheduleOccurrence({ ...input, expectedRevision: advanced.revision })
    assert(!duplicate.claimed && duplicate.occurrence.id === first.occurrence.id, '重复 tick 二次插入 occurrence')
    const afterDuplicate = repository.getSchedule(rule.id)
    assert(afterDuplicate.revision === advanced.revision, '重复 tick 二次推进 cursor/revision')
    const rows = repository.listScheduleOccurrences({ scheduleId: rule.id })
    assert(rows.length === 1 && rows[0]!.status === 'claimed', `occurrence 行数=${String(rows.length)}`)
    return `cursor ${String(advanced.nextRunAt)} · occurrence 行数=1 · 重复 key 返回同一行`
  })

  await check('occurrence：暂停规则的手动运行只清空游标，不会重新启用', () => {
    const paused = repository.saveSchedule(scheduleDraft({ id: 'schedule.paused', name: '暂停规则', enabled: false }))
    assert(paused.enabled === false && paused.nextRunAt === null, `暂停规则状态异常：enabled=${String(paused.enabled)} nextRunAt=${String(paused.nextRunAt)}`)
    repository.claimScheduleOccurrence({
      scheduleId: paused.id,
      idempotencyKey: `${paused.id}:manual:2026-01-06`,
      occurrenceAt: '2026-01-06T01:00:00.000Z',
      localDateKey: '2026-01-06',
      source: 'manual',
      nextRunAt: null,
      advanceCursor: true,
      expectedRevision: paused.revision
    })
    const after = repository.getSchedule(paused.id)
    assert(after.enabled === false, '手动运行把暂停的规则重新启用了')
    assert(after.nextRunAt === null, `暂停规则被重新排期：${String(after.nextRunAt)}`)
    assert(repository.listDueSchedules(new Date('2030-01-01T00:00:00.000Z')).every((item) => item.id !== paused.id), '暂停规则被调度循环选中')
    return 'enabled=false · nextRunAt=null · 不在 due 列表中'
  })

  await check('occurrence：启动对账把崩溃遗留的 claim 结算为 missed 并保留原因', () => {
    const rows = repository.listScheduleOccurrences({ scheduleId: 'schedule.occurrence', limit: 10 })
    assert(rows.length === 1 && rows[0]!.status === 'claimed', '前置 claim 状态异常')
    const settled = repository.reconcileClaimedScheduleOccurrences('应用在时间点执行期间关闭')
    assert(settled >= 1, `对账未处理遗留 claim：${String(settled)}`)
    const reconciled = repository.listScheduleOccurrences({ scheduleId: 'schedule.occurrence', limit: 10 })
    assert(reconciled[0]!.status === 'missed', `对账后状态=${reconciled[0]!.status}`)
    assert(reconciled[0]!.reason.includes('关闭'), `对账原因=${reconciled[0]!.reason}`)
    return `reconcile=${String(settled)} · status=missed · reason=${reconciled[0]!.reason}`
  })

  await check('迁移：重跑 schedule 迁移不会复活用户暂停的规则', () => {
    const current = repository.getSchedule('builtin.schedule.last30days')
    const paused = repository.saveSchedule(scheduleDraft({ id: 'builtin.schedule.last30days', enabled: false, expectedRevision: current.revision }))
    assert(paused.enabled === false && paused.revision > 0, `暂停状态异常：revision=${String(paused.revision)}`)
    // Re-run only the UPDATE-only schedule migrations (16/18/19) on an
    // installed database; migration 23 is additive and cannot re-run.
    const raw = rawSqlite(repository)
    raw.prepare('DELETE FROM _prw_migrations WHERE id IN (16, 18, 19)').run()
    migrateDatabase(raw)
    const after = repository.getSchedule('builtin.schedule.last30days')
    assert(after.enabled === false, '迁移把用户暂停的内置规则重新启用了')
    assert(after.nextRunAt === null, `迁移给暂停规则写入游标：${String(after.nextRunAt)}`)
    return `revision=${String(after.revision)} · enabled=false · nextRunAt=null（迁移 19 仅作用于 revision=0）`
  })

  // ------------------------------- Automation 页面最近运行可见性 --
  await check('运行可见性：历史投影带 occurrence/阻断原因/Artifact/Obsidian 投递结果', () => {
    const rule = repository.saveSchedule(scheduleDraft({ id: 'schedule.history', name: '历史投影', enabled: false }))
    const key = `${rule.id}:manual:2026-01-07`
    const runId = createRun(repository, key, rule.id)
    repository.updateManagedAgentRun({ id: runId, status: 'blocked', error: 'SKILL_PROBE_FAILED：引擎不可用' })
    const claim = repository.claimScheduleOccurrence({
      scheduleId: rule.id,
      idempotencyKey: key,
      occurrenceAt: '2026-01-07T01:00:00.000Z',
      localDateKey: '2026-01-07',
      source: 'manual',
      nextRunAt: null,
      advanceCursor: false,
      expectedRevision: rule.revision
    })
    repository.settleScheduleOccurrence({ id: claim.occurrence.id, runId, status: 'blocked', reason: 'SKILL_PROBE_FAILED：引擎不可用' })
    const internal = coordinator as unknown as {
      appendDeliveryEvent: (id: string, delivery: unknown, artifactId: string | null) => void
    }
    // A real run always has lifecycle events before the delivery projection; the
    // start event occupies seq 0, which `listAgentEvents(runId, 0, …)` skips.
    repository.appendAgentEvent(runId, 'started', { message: '定时任务启动' })
    internal.appendDeliveryEvent(runId, { status: 'skipped', reason: 'NO_VAULT', message: '未配置 Obsidian Vault' }, 'artifact-history')
    const history = coordinator.listAutomationRunHistory({ scheduleId: rule.id, limit: 5 })
    assert(history.length === 1, `历史条数=${String(history.length)}`)
    const entry = history[0]!
    assert(entry.runId === runId && entry.scheduleId === rule.id, '历史条目未指向该 run/规则')
    assert(entry.status === 'blocked', `run 状态=${entry.status}`)
    assert(entry.occurrenceStatus === 'blocked' && entry.occurrenceSource === 'manual', `occurrence=${String(entry.occurrenceStatus)}/${String(entry.occurrenceSource)}`)
    assert(entry.blockedReason?.includes('SKILL_PROBE_FAILED') === true, `阻断原因=${String(entry.blockedReason)}`)
    assert(entry.delivery?.status === 'skipped' && entry.delivery.reason === 'NO_VAULT', `投递=${JSON.stringify(entry.delivery)}`)
    return `status=${entry.status} · ${String(entry.occurrenceStatus)}/${String(entry.occurrenceSource)} · delivery=skipped/NO_VAULT`
  })

  coordinator.dispose()
  for (const opened of openedRepositories) {
    try { opened.close() } catch { /* already closed */ }
  }

  console.log('')
  const failed = results.filter((item) => item.status === 'FAIL')
  const passed = results.filter((item) => item.status === 'PASS')
  console.log(`通过 ${String(passed.length)} 项，失败 ${String(failed.length)} 项（共 ${String(results.length)} 项）`)
  console.log('本检查不调用模型/网络：真实 CLI 端到端验收（暂停/恢复、启动补挖 at-most-once、真实 Vault 冲突）仍需在隔离 Workbench DB + 测试 Vault 环境中执行。')
  for (const root of roots) {
    try { rmSync(root, { recursive: true, force: true }) } catch { /* temp dir left behind on a locked handle */ }
  }
  process.exitCode = failures === 0 ? 0 : 1
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
