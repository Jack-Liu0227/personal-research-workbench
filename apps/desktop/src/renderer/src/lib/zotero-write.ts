import type { ZoteroCapabilityKind, ZoteroCollectionWrite, ZoteroImportTransport, ZoteroProbeStatus, ZoteroRemoteDeleteReceipt, ZoteroWriteBlockedReason } from '@prw/contracts'

/** How a Zotero connection may be used, derived from the frozen capability probe. */
export type ZoteroWritePlan = 'checking' | 'write' | 'read-only'

/** Naming follows the frozen capability: a read-only connection must never be
 * offered a write action, and an action is only named a write when the probe
 * proved the connection can write. */
export function zoteroWritePlan(probing: boolean, canWrite: boolean | undefined): ZoteroWritePlan {
  if (probing) return 'checking'
  return canWrite === true ? 'write' : 'read-only'
}

export const prepareLabels: Record<ZoteroWritePlan, string> = {
  checking: '准备导入预览',
  write: '准备 Zotero 导入',
  'read-only': '准备 RIS/BibTeX 导入包'
}

export const confirmLabels: Record<ZoteroWritePlan, string> = {
  checking: '确认并生成导入预览',
  write: '确认并写入 Zotero',
  'read-only': '确认并生成 RIS/BibTeX 导入包'
}

/** One-line status shown next to the literature entry so the user never has
 * to infer write permission from a button: only a probed `write` capability is
 * described as writable, everything else is explicitly read-only or probing. */
export function writeStatusLabel(plan: ZoteroWritePlan): string {
  if (plan === 'checking') return '正在探测 Zotero 写入能力…'
  return plan === 'write' ? 'Zotero 可写入' : 'Zotero 只读（仅生成导入包）'
}

/** Wording of the per-result action in the search result list.  The action is
 * a preview request, so it must not promise a Zotero save that the frozen
 * capability did not grant: a read-only connection only ever prepares or
 * regenerates the RIS/BibTeX package. */
export function resultActionLabel(plan: ZoteroWritePlan, state: 'ready' | 'staged' | 'failed'): string {
  if (state === 'staged') return '再次预览'
  if (state === 'failed') return plan === 'read-only' ? '重新生成导入包' : '重新导入'
  if (plan === 'checking') return '正在探测能力…'
  return plan === 'write' ? '保存到 Zotero' : '准备导入包'
}

/** Explain *why* a connection is read-only.  Zotero 9 does not return
 * `Zotero-Server-ID` from its loopback API, so the local write handshake cannot
 * succeed and only an import package can be produced. */
export function writeBlockedExplanation(reason: ZoteroWriteBlockedReason | null | undefined, status: string | undefined): string {
  if (reason === 'server-id-missing') return '当前 Zotero 版本未提供 Local API 写入所需的 Zotero-Server-ID（Zotero 9 及更早版本），因此只能读取：确认后会生成 RIS/BibTeX 导入包，不会写入 Zotero。'
  if (reason === 'credential-missing') return '缺少 Zotero 写入凭据，因此只能读取：确认后会生成 RIS/BibTeX 导入包，不会写入 Zotero。完成写入授权后可改为直接写入。'
  if (reason === 'probe-failed') return '写入能力探测失败，无法确认写入权限：确认后会生成 RIS/BibTeX 导入包，不会写入 Zotero。'
  if (reason === 'key-single-use') return `Zotero 只颁发了一次性写入密钥（你在授权弹窗中选择的是「允许」）：${ONE_TIME_KEY_CONSEQUENCE}在此之前确认只会生成 RIS/BibTeX 导入包。`
  if (reason === 'key-unverified') return `无法确认已保存的 Zotero 本地写入密钥能否重复使用（它由旧版本保存，未记录授权方式）：请重新请求写入权限并选择「始终允许（Always Allow）」。在此之前确认只会生成 RIS/BibTeX 导入包。`
  if (reason === 'key-invalid') return `Zotero 本地写入密钥已失效（已被一次性消耗、撤销或在 Zotero 中清除）：请重新请求写入权限并选择「始终允许（Always Allow）」。在此之前确认只会生成 RIS/BibTeX 导入包。`
  if (reason === 'authorization-denied') return 'Zotero 授权弹窗中选择了「拒绝」：本次没有获得写入权限。请重新请求写入权限并选择「始终允许（Always Allow）」。在此之前确认只会生成 RIS/BibTeX 导入包。'
  if (reason === 'rate-limited') return 'Zotero 授权请求过于频繁（每 60 秒最多 5 次）：请稍后重试。在此之前确认只会生成 RIS/BibTeX 导入包。'
  return status === undefined
    ? '尚未完成 Zotero 能力探测：当前只能生成 RIS/BibTeX 导入包。'
    : '当前连接没有写入能力：确认后会生成 RIS/BibTeX 导入包，不会写入 Zotero。'
}

/** The one-time "Allow" key is destroyed by the first write that Zotero
 * validates with it, which is exactly why a multi-item import cannot complete. */
const ONE_TIME_KEY_CONSEQUENCE = 'Zotero 会在第一次成功写入后消耗该密钥，之后所有写入都会失败，因此多条目导入无法完成。请重新请求 Zotero 写入权限，并在弹窗中选择「始终允许（Always Allow）」。'

/**
 * Turning what Zotero actually returned from `/api/local/authorize` into the
 * next step.  A one-time key must never be presented as a completed setup: the
 * value comes from the server response, so the warning cannot drift from the
 * real grant.
 */
export function authorizationGrantNotice(remember: boolean | null | undefined, target: string): string {
  if (remember === false) {
    return `Zotero 返回了一次性写入密钥（你在授权弹窗中选择的是「允许」）：${ONE_TIME_KEY_CONSEQUENCE}本次授权已保存到 ${target}，但它只能成功写入一次。`
  }
  if (remember === true) return `Zotero 已返回可重复使用的写入密钥（「始终允许」），已保存到 ${target}；正在重新探测写入能力。`
  return 'Zotero 授权流程已完成，正在重新探测写入能力。'
}

/** Describe what actually happened to a Zotero item's collection membership.
 * A known Collection name is shown with its stable key kept as auxiliary
 * information, so the confirmation and the receipts never reduce the target to
 * an opaque ID. */
export function collectionWriteLabel(write: ZoteroCollectionWrite, key: string | null, name?: string | null): string {
  const reference = collectionReference(name, key)
  if (write === 'set') return `已写入 ${reference ?? '目标'} Collection`
  if (write === 'unchanged') return 'Collection 未更改'
  return reference === null ? '未写入 Collection' : `未写入（目标 ${reference}）`
}

/** Display label for the frozen write target: the real Collection name with
 * its stable key, the default (no membership change) or an explicit unknown
 * marker when the key is not part of the loaded Collection page. */
export function collectionDisplayLabel(name: string | null | undefined, key: string | null): string {
  const reference = collectionReference(name, key)
  return reference === null ? '默认（不更改成员关系）' : reference
}

function collectionReference(name: string | null | undefined, key: string | null): string | null {
  if (key === null) return null
  // A caller that never resolved a name (no Collection page loaded yet) keeps
  // the stable key alone; a resolved-but-missing name is reported as unknown
  // instead of pretending the key is the Collection's name.
  if (name === undefined) return key
  const trimmed = name === null ? '' : name.trim()
  return trimmed ? `${trimmed}（ID: ${key}）` : `未知 Collection（ID: ${key}）`
}

/**
 * What a literature write entry renders for Zotero write permission.
 *
 * Every write entry of the literature page renders exactly one of these, and
 * the shape never depends on whether a probe finished, whether there are
 * results, or whether a preview exists:
 *
 * - `request`: an actionable request that goes through the preload/Main
 *   safeStorage hand-off and is always followed by a fresh capability probe.
 * - `explain`: the version can never authorize (Zotero 9 and older do not
 *   return `Zotero-Server-ID`), so the entry says plainly that authorization is
 *   unavailable and shows the diagnosis instead of faking a successful grant.
 * - `granted`: the probe already proved write access, so there is nothing to
 *   request and the entry says so rather than repeating the action.
 * - `no-profile`: no enabled Zotero connection exists yet; the entry diagnoses
 *   that and names the settings page that must be fixed first.
 */
export type ZoteroPermissionEntry = 'request' | 'explain' | 'granted' | 'no-profile'

/**
 * Only the Zotero version itself decides whether a request can ever succeed.
 * A missing credential, an unauthorized probe, a failed probe or a probe that
 * has not returned yet all stay actionable: the request re-probes and reports
 * the real reason, which is strictly better than hiding the entry and leaving
 * the user with no operable path.
 */
export function zoteroPermissionEntry(input: {
  /** An enabled Zotero connection exists, so a request could target it. */
  hasProfile: boolean
  /** `undefined` while the capability probe has not returned yet. */
  canWrite: boolean | undefined
  reason: ZoteroWriteBlockedReason | null | undefined
}): ZoteroPermissionEntry {
  if (!input.hasProfile) return 'no-profile'
  if (input.canWrite === true) return 'granted'
  if (input.reason === 'server-id-missing') return 'explain'
  return 'request'
}

export const requestPermissionLabels = {
  action: '请求 Zotero 写入权限',
  pending: '正在请求写入权限…',
  help: '授权请求由主进程通过 safeStorage 保存，完成后会重新探测写入能力；未探测到写入能力前页面仍然只生成 RIS/BibTeX 导入包。'
} as const

export const permissionEntryLabels = {
  requestTitle: '需要 Zotero 写入授权',
  explainTitle: '无法授权（当前 Zotero 版本不支持）',
  explainAction: '无法授权（查看说明）',
  explainCollapse: '收起说明',
  grantedTitle: 'Zotero 写入权限已就绪',
  granted: '写入能力已由探测确认，无需再次授权；可以直接生成写入预览。',
  noProfileTitle: '尚未配置可用的 Zotero 连接',
  noProfile: '请先在“设置 → 工具连接”中启用 Zotero 连接，然后回到本页请求写入权限；在此之前只能生成 RIS/BibTeX 导入包。'
} as const

/** Always-visible one-line headline of the entry, so the state is readable
 * without expanding anything and never looks like a granted permission. */
export function permissionEntryHeadline(entry: ZoteroPermissionEntry): string {
  if (entry === 'request') return permissionEntryLabels.requestTitle
  if (entry === 'explain') return permissionEntryLabels.explainTitle
  if (entry === 'granted') return permissionEntryLabels.grantedTitle
  return permissionEntryLabels.noProfileTitle
}

/** Short, always-visible line of the entry.  It is what the user reads without
 * expanding anything, so it never claims a permission that was not probed. */
export function permissionEntryBrief(
  entry: ZoteroPermissionEntry,
  reason: ZoteroWriteBlockedReason | null | undefined,
  status: ZoteroProbeStatus | undefined
): string {
  if (entry === 'explain') return '当前 Zotero 版本（Zotero 9 及更早）未提供 Local API 写入所需的 Zotero-Server-ID，本机写入授权不可用；可继续生成 RIS/BibTeX 导入包。'
  if (entry === 'granted') return permissionEntryLabels.granted
  if (entry === 'no-profile') return '尚未启用 Zotero 连接：当前只能生成 RIS/BibTeX 导入包，启用后才能请求写入权限。'
  return writeBlockedExplanation(reason, status)
}

/** Full diagnosis revealed by the entry's explanation action, so a state that
 * cannot request anything still leads somewhere operable. */
export function permissionEntryDiagnosis(
  entry: ZoteroPermissionEntry,
  reason: ZoteroWriteBlockedReason | null | undefined,
  status: ZoteroProbeStatus | undefined
): string {
  if (entry === 'explain') return `无法请求写入授权：${writeBlockedExplanation(reason ?? 'server-id-missing', status)}需要本机写入时请升级到返回 Zotero-Server-ID 的 Zotero 10 及更高版本，然后在“设置 → 工具连接”中重新探测。`
  if (entry === 'granted') return permissionEntryLabels.granted
  if (entry === 'no-profile') return permissionEntryLabels.noProfile
  // A stale or one-time key is actionable, and its diagnosis has to name the
  // exact next step (choose “始终允许” in Zotero's dialog) instead of falling
  // back to generic authorization help.
  if (reason === 'key-single-use' || reason === 'key-unverified' || reason === 'key-invalid' || reason === 'authorization-denied' || reason === 'rate-limited') {
    return writeBlockedExplanation(reason, status)
  }
  return requestPermissionLabels.help
}

/**
 * Turn a failed permission request into an actionable Chinese reason.  Main and
 * the connector own the failure; the Renderer must not swallow it or report a
 * generic "failed", because the version/loopback/offline causes lead to very
 * different next steps.
 */
export function permissionRequestFailureMessage(error: unknown): string {
  const record = error && typeof error === 'object' ? error as { code?: unknown; message?: unknown } : null
  const code = typeof record?.code === 'string' ? record.code : ''
  const message = typeof record?.message === 'string' ? record.message.trim() : ''
  if (/server-id|无法申请本地写入授权|本地写入授权/iu.test(message)) return '请求写入权限失败：当前 Zotero 版本未返回 Zotero-Server-ID（Zotero 9 及更早版本），本机写入授权不可用。可以继续生成 RIS/BibTeX 导入包。'
  if (/loopback|回环|localhost|127\.0\.0\.1/u.test(message)) return '请求写入权限失败：只有 localhost 回环地址的 Zotero Local API 支持本机写入授权；请把连接地址改为 http://localhost:23119/api/ 后重试。'
  if (/ECONNREFUSED|ENOTFOUND|fetch failed|timed? ?out|network|无法连接|离线|offline/iu.test(`${code} ${message}`)) return '请求写入权限失败：无法连接 Zotero Local API。请确认 Zotero 已启动并启用了本地 API，然后重试。'
  return `请求写入权限失败：${message || 'Zotero 未返回原因'}。可以继续生成 RIS/BibTeX 导入包。`
}

/** The tag the *next* preview will freeze, stated before the preview exists so
 * the top-level project classification is chosen deliberately.  An automatic
 * choice is spelled out instead of rendered as a blank option, and a project
 * that no longer resolves is reported instead of being written as 未分类. */
export function pendingProjectTagLabel(projectId: string | null | undefined, projectName?: string | null): string {
  if (projectId === undefined) return '自动（按各条文献的项目绑定；混合选择写入 #未分类）'
  if (projectId === null) return projectTagLabel('未分类')
  const name = typeof projectName === 'string' ? projectName.trim() : ''
  return name ? projectTagLabel(name) : '已失效项目（请重新选择）'
}

/** One frozen value of a preview.  Rendered as label/value rows so the
 * confirmation screen shows exactly what the preview froze instead of prose the
 * user has to re-derive. */
export type ZoteroFrozenValue = { label: string; value: string }

/**
 * The frozen values shared by the preview confirmation and the Inspector, so
 * the target Collection, the top-level classification, the write scope and the
 * revision the execution will re-check are stated once instead of drifting
 * between screens.
 */
export function frozenWriteValues(input: {
  transport: ZoteroImportTransport
  capability: ZoteroCapabilityKind
  total: number
  targetCollectionKey: string | null
  targetCollectionName?: string | null | undefined
  projectTag: string | null | undefined
  profileRevision: number
  updateCandidates: number
  reviewItems: number
}): readonly ZoteroFrozenValue[] {
  const scopeParts = [`共 ${input.total} 条`]
  if (input.updateCandidates > 0) scopeParts.push(`${input.updateCandidates} 条更新已匹配条目`)
  if (input.reviewItems > 0) scopeParts.push(`${input.reviewItems} 条重复无法确认，确认时跳过`)
  const scopeRemainder = input.total - input.updateCandidates - input.reviewItems
  if (scopeRemainder > 0) scopeParts.push(`${scopeRemainder} 条新建`)
  return [
    {
      label: '写入方式',
      value: input.transport === 'api'
        ? input.capability === 'write'
          ? 'Zotero API 写入（逐条按 revision 校验）'
          : `Zotero API 写入（capability 为 ${input.capability}，逐条会返回失败）`
        : 'RIS/BibTeX 导入包（不会写入 Zotero）'
    },
    { label: '目标 Collection', value: collectionDisplayLabel(input.targetCollectionName, input.targetCollectionKey) },
    { label: '写入范围', value: scopeParts.join('，') },
    { label: '顶层项目分类', value: projectTagLabel(input.projectTag) },
    { label: '冻结版本', value: `profile revision ${input.profileRevision}` }
  ]
}

/** Feedback after a permission request: the probe result decides the claim, so
 * a granted request is never reported as a successful Zotero write. */
export function permissionRequestResultLabel(canWrite: boolean | undefined): string {
  return canWrite === true
    ? '已完成 Zotero 写入授权，重新探测确认可写入：现在可以生成写入预览。'
    : '已完成 Zotero 写入授权，但重新探测仍未确认写入能力：当前仍只生成 RIS/BibTeX 导入包，不会写入 Zotero。'
}

/** The exact Zotero tag written for the frozen top-level project
 * classification, shown with the presentation `#` prefix. */
export function projectTagLabel(projectTag: string | null | undefined): string {
  const trimmed = typeof projectTag === 'string' ? projectTag.trim().replace(/^#+/u, '') : ''
  return trimmed ? `#${trimmed}` : '未设置项目标签'
}

/**
 * Two-sided Zotero deletion copy.  The entry is a real delete now, so every
 * label has to state the order the app actually uses: Zotero remote first, and
 * the local Workbench projection only after Zotero confirmed the item is gone.
 */
export const remoteDeleteLabels = {
  entry: '删除 Zotero 条目',
  entryHint: '两侧都删',
  preview: '预览删除',
  /** Rendered before the request so the user confirms the real effect. */
  confirm: '将先删除 Zotero 远端条目（永久删除，不是回收站），只有 Zotero 确认删除后才删除本地 Workbench 投影；本地 Paper 会被归档而不是删除，其项目、矩阵与产物记录保留。远端删除失败、版本冲突或无写入权限时，远端条目与本地记录都会保留。是否继续？'
} as const

/** Status copy for one remote delete outcome.  `deleted` is the only state that
 * may claim Zotero erased something; `absent` means it was already gone. */
export const REMOTE_DELETE_STATUS_LABELS: Readonly<Record<ZoteroRemoteDeleteReceipt['items'][number]['remote'], string>> = {
  deleted: 'Zotero 已永久删除',
  absent: 'Zotero 远端已不存在',
  conflict: '版本冲突，未删除',
  unauthorized: '未授权，未删除',
  forbidden: '授权被拒，未删除',
  'rate-limited': '请求过于频繁，未删除',
  unavailable: '无法确认，未删除'
}

const LOCAL_DELETE_LABELS = { removed: '本地投影已删除', kept: '本地记录已保留', 'no-local-record': '本地无对应投影' } as const

/** One honest line per real delete receipt, with both halves counted. */
export function remoteDeleteReceiptSummary(receipt: ZoteroRemoteDeleteReceipt): string {
  const total = receipt.items.length
  return `${receipt.message}（共 ${total} 条：Zotero 删除 ${receipt.remoteDeletedCount} 条，本地删除 ${receipt.localRemovedCount} 条投影）`
}

/** Per-item receipt rows, so every stable key keeps its own remote *and* local
 * outcome instead of collapsing into a count. */
export function remoteDeleteReceiptRows(receipt: ZoteroRemoteDeleteReceipt): readonly { key: string; outcome: string; detail: string }[] {
  return receipt.items.map((item) => ({
    key: item.itemKey,
    outcome: `${REMOTE_DELETE_STATUS_LABELS[item.remote]} · ${LOCAL_DELETE_LABELS[item.local]}`,
    detail: item.message
  }))
}
