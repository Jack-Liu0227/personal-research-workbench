/*
 * README screenshot capture.
 *
 * Launches the built app with an isolated user-data profile, seeds clearly
 * synthetic sample records through the real `window.workbench.v2` command
 * surface (never by writing SQLite directly), then captures one screenshot per
 * top-level page into docs/assets/screenshots.
 *
 * The profile is a fresh temp directory and the application-owned Obsidian
 * Vault is created below it, so a capture run cannot touch the developer's
 * workbench database, secrets or real notes.
 *
 * Usage: node scripts/capture-readme-shots.cjs [outputDir]
 */
const { _electron: electron } = require('playwright-core')
const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const APP_ROOT = path.resolve(__dirname, '..')
const MAIN_ENTRY = path.join(APP_ROOT, 'apps', 'desktop', 'out', 'main', 'index.cjs')
const OUTPUT_DIR = path.resolve(APP_ROOT, process.argv[2] || path.join('docs', 'assets', 'screenshots'))
const DEFAULT_ELECTRON = path.join(
  APP_ROOT,
  'node_modules',
  '.pnpm',
  'electron@43.4.1',
  'node_modules',
  'electron',
  'dist',
  'electron.exe'
)

const VIEWPORT = { width: 1440, height: 920 }

/** Real Crossref query used for the literature screenshot. Bibliographic
 * metadata is public; no user data is involved. */
const LITERATURE_QUERY = 'perovskite passivation stability'

/** Fixed clock so the seeded schedule always lands inside the captured week. */
function isoAt(dayOffset, hour, minute = 0) {
  const date = new Date()
  date.setDate(date.getDate() + dayOffset)
  date.setHours(hour, minute, 0, 0)
  return date.toISOString()
}

function dayAt(dayOffset, hour) {
  const date = new Date()
  date.setDate(date.getDate() + dayOffset)
  date.setHours(hour, 0, 0, 0)
  return date.toISOString()
}

async function clickNav(page, label) {
  const candidates = page.getByRole('button', { name: label, exact: true })
  let target = null
  for (let index = 0; index < await candidates.count(); index += 1) {
    const candidate = candidates.nth(index)
    if (await candidate.isVisible()) {
      target = candidate
      break
    }
  }
  if (!target) {
    const researchGroup = page.getByRole('button', { name: '研究', exact: true }).first()
    if (await researchGroup.isVisible() && (await researchGroup.getAttribute('aria-expanded')) !== 'true') {
      await researchGroup.click()
      await page.waitForTimeout(200)
    }
    for (let index = 0; index < await candidates.count(); index += 1) {
      const candidate = candidates.nth(index)
      if (await candidate.isVisible()) {
        target = candidate
        break
      }
    }
  }
  if (!target) throw new Error(`navigation target is not visible: ${label}`)
  await target.click()
  await page.locator('main').waitFor({ state: 'visible', timeout: 30_000 })
  await page.waitForTimeout(600)
}

/** Text that means a page failed to render real content. An image containing
 * any of these is not publishable evidence, so the run fails instead. */
const FAILURE_MARKERS = [
  '服务未就绪',
  'The request did not match the expected shape',
  'Something went wrong',
  'An error occurred',
  '未捕获的错误',
  'Uncaught'
]

const report = []
const seenErrors = []

async function shoot(page, name, options = {}) {
  const file = path.join(OUTPUT_DIR, `${name}.png`)
  await page.waitForTimeout(options.settleMs ?? 900)
  await page.screenshot({ path: file, timeout: 120_000 })
  const { size } = fs.statSync(file)

  const text = await page.locator('body').innerText()
  const hits = (options.expect ?? []).filter((marker) => text.includes(marker))
  const missing = (options.expect ?? []).filter((marker) => !text.includes(marker))
  const failures = FAILURE_MARKERS.filter((marker) => text.includes(marker))
  const forbidden = (options.forbid ?? []).filter((marker) => text.includes(marker))
  if (failures.length > 0) seenErrors.push(`${name}: ${failures.join(', ')}`)
  if (forbidden.length > 0) seenErrors.push(`${name}: forbidden real-data marker present: ${forbidden.join(', ')}`)

  const image = await readPngSize(file)

  // Full page text is written to the throwaway profile only. It is never
  // committed, because it can contain real external-integration content that
  // the isolated profile still reads from the host (for example a local
  // Zotero library) and must be reviewed before publishing an image.
  if (process.env.PRW_SHOT_DUMP_DIR) {
    fs.writeFileSync(path.join(process.env.PRW_SHOT_DUMP_DIR, `${name}.txt`), text, 'utf8')
  }
  report.push({
    name,
    file: path.relative(APP_ROOT, file).replace(/\\/g, '/'),
    bytes: size,
    image,
    characters: text.length,
    matched: hits,
    missing,
    forbidden,
    failures,
    excerpt: text.slice(0, 400).replace(/\s+/g, ' ')
  })

  console.log(
    `shot ${name}: ${(size / 1024).toFixed(0)} KiB, ${image.width}x${image.height}, ` +
      `${text.length} chars, markers ${hits.length}/${(options.expect ?? []).length}` +
      (missing.length > 0 ? `, MISSING: ${missing.join(' | ')}` : '') +
      (failures.length > 0 ? `, FAILURE TEXT: ${failures.join(' | ')}` : '') +
      (forbidden.length > 0 ? `, FORBIDDEN REAL DATA: ${forbidden.join(' | ')}` : '')
  )
}

/**
 * The Zotero page reads whatever Zotero Local API answers on this machine, so
 * a capture on a developer workstation would publish a real personal library.
 * Pointing the throwaway profile at an unused loopback port makes the app show
 * its genuine "not connected" state instead. Nothing about the real library is
 * read, and the resulting image is a state any new user can reproduce.
 */
async function neutralizeZoteroIntegration(page) {
  return page.evaluate(async () => {
    const api = window.workbench.v2
    const profiles = await api.integrations.list()
    const zotero = profiles.find((profile) => profile.provider === 'zotero')
    if (!zotero) return { changed: false, reason: 'no zotero profile' }
    const saved = await api.integrations.save({
      id: zotero.id,
      provider: 'zotero',
      name: zotero.name,
      enabled: zotero.enabled,
      location: 'http://127.0.0.1:23999/api/',
      settings: zotero.settings,
      expectedRevision: zotero.revision
    })
    return { changed: true, name: saved.name, location: saved.location }
  })
}

/** Minimal PNG header reader, so the report can record real pixel dimensions
 * without adding an image dependency. */
function readPngSize(file) {
  const header = fs.readFileSync(file).subarray(0, 24)
  return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) }
}

/**
 * Local-only feed used to make the RSS README screenshot deterministic. The
 * feed is consumed through the real preview/save/refresh API, never by writing
 * the application database directly and never by reaching an external service.
 */
function startSyntheticRssServer() {
  const server = http.createServer((request, response) => {
    if (request.url !== '/feed.xml') {
      response.writeHead(404)
      response.end('not found')
      return
    }
    const published = new Date().toUTCString()
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Research Radar RSS</title>
    <link>http://127.0.0.1/</link>
    <description>用于 README 截图的合成科研资讯源</description>
    <item>
      <title>AI Agent 可靠性评测的新进展</title>
      <link>http://127.0.0.1/articles/agent-reliability</link>
      <guid>readme-agent-reliability</guid>
      <pubDate>${published}</pubDate>
      <author>Research Workbench</author>
      <description>面向本地科研工作流的可验证 Agent 运行与工具调用。</description>
    </item>
    <item>
      <title>单细胞多组学中的图表示学习</title>
      <link>http://127.0.0.1/articles/single-cell-graphs</link>
      <guid>readme-single-cell-graphs</guid>
      <pubDate>${published}</pubDate>
      <author>Research Workbench</author>
      <description>合成条目：比较图模型在稀有细胞类型识别中的表现。</description>
    </item>
    <item>
      <title>本地优先研究工具的证据链设计</title>
      <link>http://127.0.0.1/articles/evidence-chain</link>
      <guid>readme-evidence-chain</guid>
      <pubDate>${published}</pubDate>
      <author>Research Workbench</author>
      <description>合成条目：从来源、摘要到可追溯研究产物的最小闭环。</description>
    </item>
  </channel>
</rss>`
    response.writeHead(200, { 'content-type': 'application/rss+xml; charset=utf-8' })
    response.end(xml)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('synthetic RSS server did not bind to a TCP port')
      resolve({ server, url: `http://127.0.0.1:${address.port}/feed.xml` })
    })
  })
}

/**
 * Runs inside the renderer. Creates the synthetic dataset used by the README
 * images and returns a short summary of what was created.
 */
async function seed(seedData) {
  const api = window.workbench.v2
  const created = { projects: [], tasks: [], events: [], papers: [], artifacts: [] }

  const projects = []
  for (const input of seedData.projects) {
    const project = await api.projects.create(input)
    projects.push(project)
    created.projects.push(project.name)
  }

  const columnsByProject = new Map()
  for (const project of projects) {
    const columns = await api.boards.columns(project.id)
    columnsByProject.set(project.id, columns)
  }
  const columnId = (projectIndex, status) => {
    const columns = columnsByProject.get(projects[projectIndex].id) ?? []
    return columns.find((column) => column.status === status)?.id ?? null
  }

  for (const task of seedData.tasks) {
    const target = task.projectIndex === null ? null : projects[task.projectIndex]
    const created_ = await api.tasks.create({
      title: task.title,
      notes: task.notes ?? '',
      projectId: target?.id ?? null,
      priority: task.priority ?? 'normal',
      estimateMinutes: task.estimateMinutes ?? null,
      dueAt: task.dueAt ?? null,
      tags: task.tags ?? []
    })
    created.tasks.push(created_.title)
    if (task.status && target) {
      const targetColumn = columnId(task.projectIndex, task.status)
      if (targetColumn && targetColumn !== created_.columnId) {
        await api.tasks.move({
          taskId: created_.id,
          columnId: targetColumn,
          targetIndex: 0,
          expectedRevision: created_.revision
        })
      }
    }
  }

  for (const event of seedData.events) {
    const project = event.projectIndex === undefined || event.projectIndex === null ? null : projects[event.projectIndex]
    const record = await api.calendar.create({
      projectId: project?.id ?? null,
      title: event.title,
      description: event.description ?? '',
      type: event.type ?? 'event',
      startsAt: event.startsAt,
      endsAt: event.endsAt,
      timezone: seedData.timezone,
      allDay: event.allDay ?? false
    })
    created.events.push(record.title)
  }

  const papers = []
  for (const paper of seedData.papers) {
    const project = paper.projectIndex === undefined || paper.projectIndex === null ? null : projects[paper.projectIndex]
    const record = await api.papers.create({
      projectId: project?.id ?? null,
      title: paper.title,
      authors: paper.authors,
      year: paper.year,
      venue: paper.venue,
      abstract: paper.abstract,
      doi: paper.doi ?? null,
      url: paper.url ?? null,
      citationKey: paper.citationKey ?? null,
      tags: paper.tags ?? [],
      collections: paper.collections ?? [],
      status: paper.status ?? 'inbox',
      rating: paper.rating ?? 0,
      source: 'manual'
    })
    papers.push(record)
    created.papers.push(record.title)
  }

  for (const matrix of seedData.matrix ?? []) {
    const paper = papers[matrix.paperIndex]
    if (!paper) continue
    await api.matrix.upsert({
      paperId: paper.id,
      researchQuestion: matrix.researchQuestion,
      method: matrix.method,
      data: matrix.data,
      keyFindings: matrix.keyFindings,
      limitations: matrix.limitations,
      evidence: matrix.evidence,
      relevance: matrix.relevance,
      qualityScore: matrix.qualityScore
    })
  }

  for (const artifact of seedData.artifacts ?? []) {
    const project = artifact.projectIndex === undefined || artifact.projectIndex === null ? null : projects[artifact.projectIndex]
    const record = await api.artifacts.create({
      projectId: project?.id ?? null,
      kind: artifact.kind,
      title: artifact.title,
      content: artifact.content,
      status: artifact.status ?? 'draft'
    })
    created.artifacts.push(record.title)
  }

  return created
}

function buildSeedData() {
  return {
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai',
    projects: [
      {
        name: '钙钛矿太阳能电池界面工程',
        description: '钝化层配方筛选与器件稳定性验证。',
        startAt: isoAt(-40, 9),
        dueAt: isoAt(45, 18)
      },
      {
        name: '单细胞转录组聚类方法对比',
        description: '比较多种聚类算法在稀有细胞类型上的召回率。',
        startAt: isoAt(-20, 9),
        dueAt: isoAt(70, 18)
      },
      {
        name: '科研工作台 V2 发布',
        description: 'Windows 安装包与真实服务的发布门禁。',
        startAt: isoAt(-60, 9),
        dueAt: isoAt(21, 18)
      }
    ],
    tasks: [
      {
        projectIndex: 0,
        title: '整理钝化层配方的 XRD 数据',
        priority: 'high',
        dueAt: dayAt(0, 18),
        estimateMinutes: 120,
        status: 'in_progress',
        tags: ['实验', '数据']
      },
      {
        projectIndex: 0,
        title: '复现文献中的退火温度曲线',
        priority: 'urgent',
        dueAt: dayAt(-1, 18),
        estimateMinutes: 180,
        status: 'blocked',
        tags: ['复现']
      },
      {
        projectIndex: 0,
        title: '撰写器件稳定性章节初稿',
        priority: 'normal',
        dueAt: dayAt(6, 18),
        estimateMinutes: 240,
        status: 'planned',
        tags: ['写作']
      },
      {
        projectIndex: 1,
        title: '补齐 10x 数据集的批次信息',
        priority: 'normal',
        dueAt: dayAt(2, 18),
        estimateMinutes: 90,
        status: 'in_progress',
        tags: ['数据']
      },
      {
        projectIndex: 1,
        title: '完成 Leiden 与 Louvain 参数扫描',
        priority: 'high',
        dueAt: dayAt(4, 18),
        estimateMinutes: 300,
        status: 'planned',
        tags: ['计算']
      },
      {
        projectIndex: 1,
        title: '整理聚类评估指标表',
        priority: 'low',
        dueAt: null,
        status: 'done',
        tags: ['写作']
      },
      {
        projectIndex: 2,
        title: '补齐安装包的 NSIS smoke 记录',
        priority: 'urgent',
        dueAt: dayAt(1, 18),
        estimateMinutes: 150,
        status: 'in_progress',
        tags: ['发布']
      },
      {
        projectIndex: 2,
        title: '复核凭据只走 safeStorage',
        priority: 'high',
        dueAt: dayAt(3, 18),
        status: 'planned',
        tags: ['安全']
      },
      {
        projectIndex: 2,
        title: '更新 README 与架构文档',
        priority: 'normal',
        dueAt: dayAt(5, 18),
        status: 'done',
        tags: ['文档']
      },
      {
        projectIndex: null,
        title: '预约下周的组会房间',
        priority: 'low',
        dueAt: dayAt(1, 12),
        tags: ['事务']
      },
      {
        projectIndex: null,
        title: '把审稿意见转成待办',
        priority: 'normal',
        dueAt: dayAt(0, 20),
        tags: ['审稿']
      }
    ],
    events: [
      {
        projectIndex: 2,
        title: '发布门禁评审',
        type: 'meeting',
        startsAt: isoAt(0, 10),
        endsAt: isoAt(0, 11, 30),
        description: '逐项确认安装包 smoke 与安全边界。'
      },
      {
        projectIndex: 0,
        title: '钝化层退火实验',
        type: 'experiment',
        startsAt: isoAt(0, 14),
        endsAt: isoAt(0, 17)
      },
      {
        projectIndex: 1,
        title: '文献精读：稀有细胞类型聚类',
        type: 'reading',
        startsAt: isoAt(1, 9, 30),
        endsAt: isoAt(1, 11)
      },
      {
        projectIndex: null,
        title: '组会',
        type: 'meeting',
        startsAt: isoAt(2, 15),
        endsAt: isoAt(2, 16, 30)
      },
      {
        projectIndex: 0,
        title: '器件稳定性里程碑',
        type: 'milestone',
        startsAt: isoAt(3, 9),
        endsAt: isoAt(3, 10)
      },
      {
        projectIndex: 1,
        title: '方法对比投稿截止',
        type: 'submission',
        startsAt: isoAt(4, 23, 55),
        endsAt: isoAt(4, 23, 55)
      }
    ],
    papers: [
      {
        projectIndex: 0,
        title: 'Interfacial passivation strategies for stable perovskite solar cells',
        authors: ['A. Rahman', 'L. Chen', 'M. Ito'],
        year: 2024,
        venue: 'Nature Energy',
        abstract: '系统比较了三种钝化层在湿热条件下的衰减行为。',
        doi: '10.1038/s41560-024-00001-1',
        citationKey: 'rahman2024passivation',
        tags: ['钝化', '稳定性'],
        collections: ['钙钛矿'],
        status: 'reading',
        rating: 5
      },
      {
        projectIndex: 0,
        title: 'Annealing temperature windows for wide-bandgap absorbers',
        authors: ['S. Novak', 'H. Park'],
        year: 2023,
        venue: 'ACS Energy Letters',
        abstract: '给出退火温度窗口与相分离之间的定量关系。',
        doi: '10.1021/acsenergylett.3c00002',
        citationKey: 'novak2023annealing',
        tags: ['退火'],
        collections: ['钙钛矿'],
        status: 'read',
        rating: 4
      },
      {
        projectIndex: 1,
        title: 'Benchmarking clustering algorithms on rare cell populations',
        authors: ['J. Alvarez', 'T. Nakamura', 'R. Singh'],
        year: 2025,
        venue: 'Genome Biology',
        abstract: '在 12 个公开数据集上比较了图聚类与密度聚类。',
        doi: '10.1186/s13059-025-00003-3',
        citationKey: 'alvarez2025benchmarking',
        tags: ['聚类', '基准'],
        collections: ['单细胞'],
        status: 'queued',
        rating: 5
      },
      {
        projectIndex: 1,
        title: 'Graph-based embeddings for single-cell transcriptomics',
        authors: ['M. Fischer', 'Y. Zhao'],
        year: 2022,
        venue: 'Bioinformatics',
        abstract: '提出一种可扩展的图嵌入流程。',
        doi: '10.1093/bioinformatics/btac000',
        citationKey: 'fischer2022graph',
        tags: ['图嵌入'],
        status: 'read',
        rating: 3
      },
      {
        projectIndex: 2,
        title: 'Local-first software: you own your data',
        authors: ['M. Kleppmann', 'A. Wiggins', 'P. van Hardenberg'],
        year: 2019,
        venue: 'Onward!',
        abstract: '讨论本地优先架构中的冲突处理与可用性权衡。',
        doi: '10.1145/3359591.3359737',
        citationKey: 'kleppmann2019localfirst',
        tags: ['架构'],
        status: 'read',
        rating: 4
      },
      {
        projectIndex: null,
        title: 'Optimistic concurrency control in desktop applications',
        authors: ['D. Rossi'],
        year: 2021,
        venue: 'Software: Practice and Experience',
        abstract: '总结桌面应用的乐观并发与 revision 校验实践。',
        doi: '10.1002/spe.00004',
        citationKey: 'rossi2021optimistic',
        tags: ['并发'],
        status: 'inbox',
        rating: 0
      }
    ],
    matrix: [
      {
        paperIndex: 0,
        researchQuestion: '哪种钝化层在湿热条件下衰减最慢？',
        method: '对照实验 + 加速老化',
        data: '3 组配方 × 500 小时湿热',
        keyFindings: '双层钝化在 500 小时后仍保持 92% 初始效率。',
        limitations: '未覆盖低温工况。',
        evidence: '图 3、表 2',
        relevance: '直接决定本项目配方选型。',
        qualityScore: 88
      },
      {
        paperIndex: 2,
        researchQuestion: '稀有细胞类型上哪种聚类召回率最高？',
        method: '12 数据集基准测试',
        data: '公开 scRNA-seq 数据集',
        keyFindings: 'Leiden 在高分辨率下召回率最优但方差更大。',
        limitations: '未评估运行时间成本。',
        evidence: '图 2、附录 B',
        relevance: '为本项目的算法选型提供基线。',
        qualityScore: 81
      }
    ],
    artifacts: [
      {
        projectIndex: 0,
        kind: 'literature_review',
        title: '钙钛矿钝化层文献综述提纲',
        content: '一、钝化机理\n二、配方对比\n三、稳定性测试口径\n四、待验证问题',
        status: 'draft'
      },
      {
        projectIndex: 1,
        kind: 'research_plan',
        title: '聚类方法对比实验计划',
        content: '1. 固定预处理流程\n2. 参数扫描\n3. 指标与显著性检验',
        status: 'review'
      }
    ]
  }
}

async function main() {
  if (!fs.existsSync(MAIN_ENTRY)) {
    throw new Error(`Build output not found: ${MAIN_ENTRY}. Run "pnpm build" first.`)
  }
  fs.mkdirSync(OUTPUT_DIR, { recursive: true })

  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'prw-readme-shots-'))
  const syntheticRss = await startSyntheticRssServer()
  process.env.PRW_SHOT_DUMP_DIR = userData
  console.log(`throwaway profile: ${userData}`)
  const launchEnv = {
    ...process.env,
    PRW_LAST30DAYS_SKILL_PATH: path.join(APP_ROOT, '.agents', 'skills', 'last30days', 'skills', 'last30days', 'SKILL.md')
  }
  delete launchEnv.OBSIDIAN_DIR
  delete launchEnv.ELECTRON_RENDERER_URL

  const app = await electron.launch({
    executablePath: process.env.PRW_ELECTRON || DEFAULT_ELECTRON,
    args: [MAIN_ENTRY, `--prw-user-data-dir=${userData}`],
    env: launchEnv,
    cwd: userData,
    timeout: 120_000
  })

  try {
    const page = await app.firstWindow({ timeout: 120_000 })
    await app.evaluate(({ BrowserWindow }, size) => {
      const window = BrowserWindow.getAllWindows()[0]
      window.setSize(size.width, size.height)
      window.setPosition(40, 40)
    }, VIEWPORT)
    await page.waitForSelector('text=仪表盘', { timeout: 120_000 })
    await page.waitForTimeout(1500)

    const summary = await page.evaluate(seed, buildSeedData())
    console.log('seeded:', JSON.stringify({
      projects: summary.projects.length,
      tasks: summary.tasks.length,
      events: summary.events.length,
      papers: summary.papers.length,
      artifacts: summary.artifacts.length
    }))

    // Dashboard reads its rollup on mount, so reload once so the seeded
    // projects and artifacts appear without a manual refresh. The Zotero
    // integration is neutralized before the reload so the renderer's cached
    // capability probe cannot survive into the screenshot.
    const neutralized = await neutralizeZoteroIntegration(page)
    console.log(`zotero neutralized: ${JSON.stringify(neutralized)}`)
    await page.reload()
    await page.waitForSelector('text=仪表盘', { timeout: 120_000 })
    await page.waitForTimeout(2000)

    await shoot(page, '01-dashboard', {
      settleMs: 2000,
      expect: [
        '今日工作面',
        '项目进度',
        '科研工作台 V2 发布',
        '整理钝化层配方的 XRD 数据',
        '单细胞转录组聚类方法对比'
      ]
    })

    await clickNav(page, '日历')
    await shoot(page, '02-calendar', { expect: ['发布门禁评审', '钝化层退火实验', '组会'] })

    await clickNav(page, '任务')
    await shoot(page, '03-tasks-board', { expect: ['整理钝化层配方的 XRD 数据', '补齐 10x 数据集的批次信息'] })

    await clickNav(page, '项目空间')
    await shoot(page, '04-project-space', { expect: ['钙钛矿太阳能电池界面工程', '单细胞转录组聚类方法对比'] })

    // The literature page is a live search workspace, not a local library
    // browser, so the capture runs one real Crossref query and inspects the
    // first hit. Results are public bibliographic metadata, not user data.
    await clickNav(page, '文献检索')
    await page.locator('input[aria-label="文献关键词"]').fill(LITERATURE_QUERY)
    await page.locator('select[aria-label="检索来源"]').selectOption('crossref')
    await page.locator('form').getByRole('button', { name: '检索' }).click()
    const firstResult = page.locator('.literature-results-list h3').first()
    await firstResult.waitFor({ state: 'visible', timeout: 60_000 })
    const resultTitle = (await firstResult.innerText()).trim()
    console.log(`literature live query "${LITERATURE_QUERY}" -> ${resultTitle}`)
    await firstResult.click()
    await page.getByText('INSPECTOR / PAPER', { exact: true }).waitFor({ state: 'visible', timeout: 30_000 })
    await shoot(page, '05-literature', { settleMs: 1200, expect: ['INSPECTOR / PAPER', '文献信息'] })

    await clickNav(page, 'Obsidian')
    await shoot(page, '06-obsidian', { expect: ['Obsidian'] })

    await clickNav(page, 'Zotero')
    await page.waitForTimeout(3000)
    await shoot(page, '07-zotero', {
      expect: ['Zotero'],
      forbid: ['已连接（真实 Local API 探测）']
    })

    await clickNav(page, 'Agent')
    await shoot(page, '08-agent', { settleMs: 2000, expect: ['Pi'] })

    await clickNav(page, '定时任务')
    await shoot(page, '09-automation', { expect: [] })

    await clickNav(page, '设置')
    await shoot(page, '10-settings', { expect: [] })

    // Add one deterministic local feed through the real API so the new RSS
    // intelligence page is captured with meaningful, non-personal content.
    const rssSetup = await page.evaluate(async (feedUrl) => {
      const api = window.workbench.v2
      const preview = await api.rss.sources.preview({ url: feedUrl })
      const source = await api.rss.sources.save({
        title: preview.title,
        url: preview.url,
        siteUrl: preview.siteUrl,
        description: preview.description,
        categoryId: 'rsscat.ai-technology'
      })
      const refresh = await api.rss.sources.refresh({ sourceIds: [source.id] })
      return { title: source.title, refresh }
    }, syntheticRss.url)
    console.log(`synthetic RSS seeded: ${JSON.stringify(rssSetup)}`)
    await clickNav(page, '情报日报')
    await page.locator('li').filter({ hasText: 'Research Radar RSS' }).first().waitFor({ state: 'visible', timeout: 30_000 })
    await page.getByText('AI Agent 可靠性评测的新进展', { exact: true }).waitFor({ state: 'visible', timeout: 30_000 })
    await shoot(page, '11-rss', {
      expect: ['情报日报', 'RSS INTELLIGENCE', 'Research Radar RSS', 'AI Agent 可靠性评测的新进展']
    })

    await writeReport()
  } finally {
    await app.close().catch(() => undefined)
    await new Promise((resolve) => syntheticRss.server.close(resolve))
  }

  if (seenErrors.length > 0) {
    throw new Error(`Screenshots contain failure text:\n${seenErrors.join('\n')}`)
  }
  const incomplete = report.filter((entry) => entry.missing.length > 0)
  if (incomplete.length > 0) {
    throw new Error(
      `Seeded sample data did not render on:\n${incomplete
        .map((entry) => `  ${entry.name}: missing ${entry.missing.join(', ')}`)
        .join('\n')}`
    )
  }

  console.log(`\nScreenshots written to ${OUTPUT_DIR}`)
}

/** Writes the machine-readable evidence that ships next to the images. */
async function writeReport() {
  const lines = [
    '# README screenshot evidence',
    '',
    'Generated by `node scripts/capture-readme-shots.cjs`. Every image was captured',
    'from the built app running against an isolated temp profile with synthetic',
    'sample data created through the real `window.workbench.v2` command surface.',
    '',
    '| Image | Pixels | Size | Visible characters | Sample-data markers |',
    '| --- | --- | --- | --- | --- |'
  ]
  for (const entry of report) {
    const markers = entry.matched.length === 0 ? '(none asserted)' : entry.matched.map((m) => `\`${m}\``).join('<br>')
    lines.push(
      `| \`${entry.file}\` | ${entry.image.width}x${entry.image.height} | ${(entry.bytes / 1024).toFixed(0)} KiB | ${entry.characters} | ${markers} |`
    )
  }
  lines.push('', '## Captured page excerpts', '')
  for (const entry of report) {
    lines.push(`### ${entry.name}`, '', `> ${entry.excerpt}`, '')
  }
  fs.writeFileSync(path.join(OUTPUT_DIR, 'CAPTURE-REPORT.md'), `${lines.join('\n')}\n`, 'utf8')
}

main().catch((error) => {
  console.error('capture failed:', error)
  process.exitCode = 1
})
