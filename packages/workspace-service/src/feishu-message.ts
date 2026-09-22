import type { AgentRunRecord, LiteratureMatrixEntry } from '@prw/contracts'
import { FEISHU_DAILY_MSG_CHUNK_CHARS } from '@prw/contracts'

/**
 * Daily literature push (message-side, `literature_daily_msg`) delivery boundary.
 *
 * 与 daily_digest→Obsidian 本地知识库管线完全隔离：同一引擎（literature-matrix
 * 四源检索）跑出结果后，本模块只负责把模型产出的中文决策卡列表经飞书 bot 发到
 * 绑定用户，绝不写 Vault、不产生第二份权威正文。SQLite 只保留规则、运行记录、
 * 投递事件与一个 ≤4k 字的投影摘录。
 *
 * 消息侧的"边界"体现在三件事：
 * - 分块：单条飞书文本消息有长度上限，决策卡列表按行切块发送，防刷屏也防截断；
 * - 矩阵增强：把项目已有文献矩阵行压缩成模型可读的中文简报（关联研究问题用），
 *   注入调度指令而非事后解析模型输出——解析自由文本脆弱且不可审计；
 * - 投递结果：sent / skipped 判定与 daily_digest 的 written / skipped 平行，
 *   未绑定或发送失败时记录事件，绝不让计划任务报 failed。
 */

/** 消息侧推送的唯一工作流 key（与 contracts 常量一致，避免两处字面量漂移）。 */
export const FEISHU_DAILY_MSG_WORKFLOW_KEY = 'literature_daily_msg' as const

/** 矩阵简报的最大字符数：注入的是提示词辅助信息，必须可预期地小。 */
export const FEISHU_MATRIX_BRIEFING_LIMIT = 4_000

/** 矩阵条目单个字段的截断长度，防止一条长摘要撑爆简报。 */
export const FEISHU_MATRIX_FIELD_LIMIT = 240

export type FeishuMessageSkipReason =
  | 'NOT_LITERATURE_DAILY_MSG'
  | 'NO_SINK'
  | 'SEND_FAILED'
  | 'NO_SOURCES'
  | 'NO_NEW_ITEMS'

export type FeishuMessageDelivery =
  | { readonly status: 'sent'; readonly messageCount: number }
  | { readonly status: 'skipped'; readonly reason: FeishuMessageSkipReason; readonly message: string }

/** 最小投递面：宿主（Main 进程）用 FeishuBindingController.sendText 实现它，
 * 测试用记录型 double 实现它——协调器不直接依赖飞书 SDK。 */
export interface FeishuMessageWriter {
  sendText(text: string): Promise<void>
}

export interface FeishuMessageDeliveryInput {
  readonly scheduleId: string
  readonly run: AgentRunRecord
  readonly content: string
}

/**
 * 把决策卡列表切成 ≤limit 字的消息块，优先在换行边界切，其次在句号边界切，
 * 最后硬切（宁可断词也不让单条消息超长）。空输入返回空数组。
 */
export function chunkFeishuMessage(text: string, limit = FEISHU_DAILY_MSG_CHUNK_CHARS): string[] {
  const trimmed = text.trim()
  if (trimmed.length === 0) return []
  if (trimmed.length <= limit) return [trimmed]
  const chunks: string[] = []
  let rest = trimmed
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit)
    if (cut <= 0) cut = rest.lastIndexOf('。', limit)
    if (cut <= 0) cut = limit
    const chunk = rest.slice(0, cut).trim()
    if (chunk.length > 0) chunks.push(chunk)
    rest = rest.slice(cut).trim()
  }
  if (rest.length > 0) chunks.push(rest)
  return chunks
}

function bound(value: string | null | undefined, limit = FEISHU_MATRIX_FIELD_LIMIT): string {
  const raw = (value ?? '').trim().replace(/\s+/gu, ' ')
  return raw.length <= limit ? raw : `${raw.slice(0, limit)}…`
}

/**
 * 把项目已有文献矩阵压缩成模型可读的中文简报。空矩阵返回空串（调用方拼接时
 * 自然省略该块，不会生成一段空的 `<literature_matrix>` 占位）。
 */
export function buildFeishuMatrixBriefing(
  entries: readonly LiteratureMatrixEntry[],
  limit = FEISHU_MATRIX_BRIEFING_LIMIT
): string {
  if (entries.length === 0) return ''
  const rows = entries.map((entry, index) => {
    const question = bound(entry.researchQuestion) || '（未填写研究问题）'
    const findings = bound(entry.keyFindings)
    const relevance = entry.relevance === null || entry.relevance === undefined ? null : String(entry.relevance)
    return [
      `${index + 1}. 研究问题：${question}`,
      findings.length > 0 ? `   关键发现：${findings}` : '',
      relevance ? `   相关度：${relevance}` : ''
    ].filter(Boolean).join('\n')
  })
  let briefing = `<literature_matrix>\n以下是本项目已建立的文献矩阵（共 ${String(entries.length)} 条）。写决策卡时优先关联这些研究问题，不得臆测条目中不存在的结论：\n${rows.join('\n')}\n</literature_matrix>`
  if (briefing.length > limit) {
    briefing = `${briefing.slice(0, limit)}\n…（矩阵简报已截断）`
  }
  return briefing
}

export interface FeishuMessageProjection {
  readonly title: string
  readonly body: string
}

/**
 * SQLite 投影：与 daily_digest 的投影平行——SQLite 只存索引与摘录，
 * 消息正文的权威是飞书侧的聊天记录，不是数据库第二份副本。
 */
export function buildFeishuMessageProjection(input: {
  readonly delivery: FeishuMessageDelivery | null
  readonly content: string
  readonly dateKey: string
  readonly scheduleId: string
  readonly run: AgentRunRecord
}): FeishuMessageProjection {
  const delivery = input.delivery
  const disposition = delivery === null
    ? '本次运行未配置消息投递，未发送。'
    : delivery.status === 'sent'
      ? `已发送 ${String(delivery.messageCount)} 条飞书消息。`
      : `飞书消息未发送（${delivery.reason}）：${delivery.message}`
  return {
    title: `每日文献推送 · ${input.dateKey} · ${input.scheduleId.slice(0, 8)}`,
    body: [
      `# 每日文献推送（飞书消息） · ${input.dateKey}`,
      '',
      `- 规则: ${input.scheduleId}`,
      `- 运行: ${input.run.id}（${input.run.runtime} / ${input.run.workflowKey}）`,
      `- ${disposition}`,
      '- 消息正文的权威在飞书聊天记录；SQLite 仅保存本索引与摘录。',
      '',
      '---',
      '',
      input.content.trim()
    ].join('\n')
  }
}

/**
 * 消息侧投递边界：只处理 literature_daily_msg 工作流；无宿主 sink 时跳过
 * （NO_SINK）；有 sink 则逐块发送，任意一块失败即整体记为 SEND_FAILED——
 * 计划任务以 skipped 收尾，绝不把投递问题伪装成模型运行失败。
 */
export async function deliverFeishuMessage(
  writer: FeishuMessageWriter | null,
  input: FeishuMessageDeliveryInput
): Promise<FeishuMessageDelivery> {
  if (input.run.workflowKey !== FEISHU_DAILY_MSG_WORKFLOW_KEY) {
    return { status: 'skipped', reason: 'NOT_LITERATURE_DAILY_MSG', message: `工作流 ${input.run.workflowKey} 不发送飞书消息。` }
  }
  if (!writer) {
    return { status: 'skipped', reason: 'NO_SINK', message: '宿主未配置飞书消息投递通道，消息未发送。' }
  }
  const chunks = chunkFeishuMessage(input.content)
  if (chunks.length === 0) {
    return { status: 'skipped', reason: 'SEND_FAILED', message: '运行输出为空，没有可发送的内容。' }
  }
  try {
    for (const chunk of chunks) await writer.sendText(chunk)
    return { status: 'sent', messageCount: chunks.length }
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 300) : '飞书消息发送失败。'
    return { status: 'skipped', reason: 'SEND_FAILED', message }
  }
}
