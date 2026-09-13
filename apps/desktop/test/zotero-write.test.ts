import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ZoteroRemoteDeleteReceiptSchema } from '@prw/contracts'
import {
  authorizationGrantNotice,
  collectionDisplayLabel,
  collectionWriteLabel,
  confirmLabels,
  frozenWriteValues,
  pendingProjectTagLabel,
  permissionEntryBrief,
  permissionEntryDiagnosis,
  permissionEntryHeadline,
  permissionEntryLabels,
  permissionRequestFailureMessage,
  permissionRequestResultLabel,
  prepareLabels,
  remoteDeleteLabels,
  remoteDeleteReceiptRows,
  remoteDeleteReceiptSummary,
  projectTagLabel,
  requestPermissionLabels,
  resultActionLabel,
  writeBlockedExplanation,
  writeStatusLabel,
  zoteroPermissionEntry,
  zoteroWritePlan
} from '../src/renderer/src/lib/zotero-write.js'

/**
 * The literature entry must be capability-first: an unprobed or read-only
 * connection may only ever be described as read-only, and the RIS/BibTeX
 * package is the only fallback it names. These assertions pin the decision
 * table shared by the literature search results, the Inspector confirmation
 * and the Zotero page, so the wording cannot drift back into promising a write
 * that Zotero 9 cannot perform.
 */

test('only a probed write capability is planned as writable', () => {
  assert.equal(zoteroWritePlan(true, true), 'checking')
  assert.equal(zoteroWritePlan(true, false), 'checking')
  assert.equal(zoteroWritePlan(false, true), 'write')
  assert.equal(zoteroWritePlan(false, false), 'read-only')
  // An unknown capability (no link-up or failed probe) is never assumed to be
  // writable.
  assert.equal(zoteroWritePlan(false, undefined), 'read-only')
})

test('read-only connections are named as an import package and never as a write', () => {
  for (const plan of ['checking', 'read-only'] as const) {
    assert.equal(/写入 Zotero|保存到 Zotero/.test(prepareLabels[plan]), false, prepareLabels[plan])
    assert.equal(/写入 Zotero|保存到 Zotero/.test(confirmLabels[plan]), false, confirmLabels[plan])
  }
  assert.match(prepareLabels['read-only'], /RIS\/BibTeX/u)
  assert.equal(confirmLabels.write, '确认并写入 Zotero')
  assert.equal(confirmLabels['read-only'], '确认并生成 RIS/BibTeX 导入包')
})

test('the search-result action follows the frozen capability instead of implying a save', () => {
  // A writable connection keeps the existing wording.
  assert.equal(resultActionLabel('write', 'ready'), '保存到 Zotero')
  assert.equal(resultActionLabel('write', 'failed'), '重新导入')
  // Read-only never offers a save and retries the package instead.
  assert.equal(resultActionLabel('read-only', 'ready'), '准备导入包')
  assert.equal(resultActionLabel('read-only', 'failed'), '重新生成导入包')
  // Re-opening an existing preview stays transport-neutral.
  assert.equal(resultActionLabel('write', 'staged'), '再次预览')
  assert.equal(resultActionLabel('read-only', 'staged'), '再次预览')
  // While the probe runs the entry must say so instead of guessing.
  assert.equal(resultActionLabel('checking', 'ready'), '正在探测能力…')
})

test('write status labels state the probed capability and its fallback', () => {
  assert.equal(writeStatusLabel('checking'), '正在探测 Zotero 写入能力…')
  assert.equal(writeStatusLabel('write'), 'Zotero 可写入')
  assert.equal(writeStatusLabel('read-only'), 'Zotero 只读（仅生成导入包）')
})

test('the read-only explanation names the actual blocker', () => {
  // Zotero 9 does not return Zotero-Server-ID from its loopback API, which is
  // the reason the local write handshake cannot succeed.
  const serverId = writeBlockedExplanation('server-id-missing', 'connected')
  assert.match(serverId, /Zotero 9/u)
  assert.match(serverId, /RIS\/BibTeX/u)
  assert.match(serverId, /不会写入 Zotero/u)
  assert.match(writeBlockedExplanation('credential-missing', 'connected'), /写入授权/u)
  assert.match(writeBlockedExplanation('probe-failed', 'partial'), /探测失败/u)
  // Every branch must offer the package fallback rather than a write.
  for (const reason of ['server-id-missing', 'credential-missing', 'probe-failed', null, undefined] as const) {
    assert.match(writeBlockedExplanation(reason, 'connected'), /RIS\/BibTeX/u)
  }
})

/** The reason the import only wrote part of the selection: a one-time local key
 * is destroyed by the first write that Zotero validates with it. */
test('a one-time or unusable local write key is explained and stays actionable', () => {
  const singleUse = writeBlockedExplanation('key-single-use', 'connected')
  assert.match(singleUse, /一次性/u)
  assert.match(singleUse, /始终允许（Always Allow）/u)
  assert.match(singleUse, /RIS\/BibTeX/u)

  const unverified = writeBlockedExplanation('key-unverified', 'connected')
  assert.match(unverified, /旧版本/u)
  assert.match(unverified, /始终允许（Always Allow）/u)

  const invalid = writeBlockedExplanation('key-invalid', 'connected')
  assert.match(invalid, /失效/u)
  assert.match(invalid, /始终允许（Always Allow）/u)

  assert.match(writeBlockedExplanation('authorization-denied', 'connected'), /拒绝/u)
  assert.match(writeBlockedExplanation('rate-limited', 'connected'), /过于频繁/u)

  // None of these may read as an unrecoverable version limitation: each still
  // names the re-authorization step, and none of them claims a write.
  for (const reason of ['key-single-use', 'key-unverified', 'key-invalid', 'authorization-denied', 'rate-limited'] as const) {
    assert.doesNotMatch(writeBlockedExplanation(reason, 'connected'), /Zotero 9/u)
    assert.match(permissionEntryDiagnosis('request', reason, 'connected'), /Zotero/u)
  }
})

test('an authorization round-trip reports the persistence Zotero actually granted', () => {
  // “Always Allow” yields a reusable key.
  assert.match(authorizationGrantNotice(true, '本机 safeStorage'), /始终允许/u)
  assert.match(authorizationGrantNotice(true, '本机 safeStorage'), /本机 safeStorage/u)
  // “Allow” yields a key that cannot survive a multi-item import, so the notice
  // must warn instead of reporting a completed setup.
  const singleUse = authorizationGrantNotice(false, '本机 safeStorage')
  assert.match(singleUse, /一次性/u)
  assert.match(singleUse, /始终允许（Always Allow）/u)
  assert.match(singleUse, /只能成功写入一次/u)
  // Zotero 9/older responses omit `remember`: stay neutral and re-probe.
  for (const remember of [undefined, null] as const) {
    assert.match(authorizationGrantNotice(remember, '本机 safeStorage'), /重新探测/u)
  }
})

test('per-item receipts describe what happened to the selected collection', () => {
  assert.equal(collectionWriteLabel('set', 'COLL0001'), '已写入 COLL0001 Collection')
  assert.equal(collectionWriteLabel('unchanged', 'COLL0001'), 'Collection 未更改')
  assert.equal(collectionWriteLabel('not-written', null), '未写入 Collection')
  assert.equal(collectionWriteLabel('not-written', 'COLL0001'), '未写入（目标 COLL0001）')
  // A known Collection is named, with the stable key kept as auxiliary info.
  assert.equal(collectionWriteLabel('set', 'COLL0001', '机器学习'), '已写入 机器学习（ID: COLL0001） Collection')
  assert.equal(collectionWriteLabel('unchanged', 'COLL0001', '机器学习'), 'Collection 未更改')
  assert.equal(collectionWriteLabel('not-written', 'COLL0001', '机器学习'), '未写入（目标 机器学习（ID: COLL0001））')
})

/**
 * Requirement: the import preview names its real target Collection instead of
 * an opaque key, and the frozen goal is what gets confirmed.  An unloaded name
 * is reported as unknown rather than silently shown as the raw key.
 */
test('the frozen target collection is shown by name with its stable key', () => {
  assert.equal(collectionDisplayLabel('机器学习', 'COLL0001'), '机器学习（ID: COLL0001）')
  assert.equal(collectionDisplayLabel('  机器学习  ', 'COLL0001'), '机器学习（ID: COLL0001）')
  assert.equal(collectionDisplayLabel(null, 'COLL0001'), '未知 Collection（ID: COLL0001）')
  assert.equal(collectionDisplayLabel('', 'COLL0001'), '未知 Collection（ID: COLL0001）')
  // No name resolved yet: the stable key stays visible on its own.
  assert.equal(collectionDisplayLabel(undefined, 'COLL0001'), 'COLL0001')
  // No target collection means the write does not touch existing membership.
  assert.equal(collectionDisplayLabel('机器学习', null), '默认（不更改成员关系）')
  assert.equal(collectionDisplayLabel(undefined, null), '默认（不更改成员关系）')
})

/**
 * Requirement: the write-permission entry is mandatory at every literature
 * write entry point and in every Zotero profile state.  There is no state that
 * removes the entry — an unprobed probe, a failed probe, an empty result list
 * and a not-yet-generated preview all still render it — and only a version that
 * can *never* authorize (Zotero 9, no Zotero-Server-ID) replaces the request
 * action with a stated explanation instead of a request button that could only
 * fail.
 */
test('every Zotero profile state maps to a visible permission entry', () => {
  // No enabled connection: diagnosed, and the settings path is named.
  assert.equal(zoteroPermissionEntry({ hasProfile: false, canWrite: undefined, reason: null }), 'no-profile')
  // A probed write capability has nothing left to request.
  assert.equal(zoteroPermissionEntry({ hasProfile: true, canWrite: true, reason: null }), 'granted')
  // Zotero 9 never returns Zotero-Server-ID: the request cannot succeed, so the
  // entry explains instead of pretending the state is fixable.
  assert.equal(zoteroPermissionEntry({ hasProfile: true, canWrite: false, reason: 'server-id-missing' }), 'explain')
  // A missing credential, an unauthorized probe, a failed probe and a probe
  // that has not returned yet all stay actionable.
  for (const reason of ['credential-missing', 'probe-failed', null, undefined] as const) {
    assert.equal(zoteroPermissionEntry({ hasProfile: true, canWrite: false, reason }), 'request', String(reason))
    assert.equal(zoteroPermissionEntry({ hasProfile: true, canWrite: undefined, reason }), 'request', String(reason))
  }
  // An unusable key is re-grantable, so its entry must stay actionable rather
  // than being mistaken for an already granted connection.
  for (const reason of ['key-single-use', 'key-unverified', 'key-invalid', 'authorization-denied', 'rate-limited'] as const) {
    assert.equal(zoteroPermissionEntry({ hasProfile: true, canWrite: false, reason }), 'request', reason)
  }
  // The entry never disappears: all four states have a headline, a brief and a
  // diagnosis, so the mandatory entry always has text to render.
  for (const entry of ['request', 'explain', 'granted', 'no-profile'] as const) {
    assert.ok(permissionEntryHeadline(entry).length > 0, entry)
    assert.ok(permissionEntryBrief(entry, 'credential-missing', 'connected').length > 0, entry)
    assert.ok(permissionEntryDiagnosis(entry, 'credential-missing', 'connected').length > 0, entry)
  }
  // Neither label may promise the write itself.
  assert.equal(/已写入|保存到 Zotero/u.test(requestPermissionLabels.action + requestPermissionLabels.pending + requestPermissionLabels.help), false)
  assert.match(requestPermissionLabels.help, /重新探测/u)
})

test('the version-blocked entry still leads to an operable diagnosis', () => {
  const diagnosis = permissionEntryDiagnosis('explain', 'server-id-missing', 'connected')
  assert.match(diagnosis, /Zotero-Server-ID/u)
  assert.match(diagnosis, /Zotero 10/u)
  assert.match(diagnosis, /设置 → 工具连接/u)
  assert.match(permissionEntryBrief('explain', 'server-id-missing', 'connected'), /RIS\/BibTeX/u)
  assert.equal(permissionEntryLabels.explainTitle, '无法授权（当前 Zotero 版本不支持）')
  assert.match(permissionEntryLabels.explainAction, /查看说明/u)
  // The granted state may only claim what the probe confirmed, and the missing
  // profile state names the settings page to fix.
  assert.equal(/已写入 Zotero/u.test(permissionEntryBrief('granted', null, 'connected')), false)
  assert.match(permissionEntryDiagnosis('no-profile', null, undefined), /设置 → 工具连接/u)
})

test('a failed permission request keeps its cause instead of a generic error', () => {
  assert.match(permissionRequestFailureMessage(new Error('Zotero 未返回 Zotero-Server-ID，无法申请本地写入授权。')), /Zotero 9/u)
  assert.match(permissionRequestFailureMessage(new Error('只有 localhost 回环 Zotero Local API 支持运行时写入授权。')), /localhost/u)
  assert.match(permissionRequestFailureMessage(Object.assign(new Error('fetch failed'), { code: 'ECONNREFUSED' })), /无法连接 Zotero/u)
  // An unknown failure still states its cause and the package fallback.
  const generic = permissionRequestFailureMessage(new Error('boom'))
  assert.match(generic, /boom/u)
  assert.match(generic, /RIS\/BibTeX/u)
  assert.match(permissionRequestFailureMessage(null), /未返回原因/u)
})

test('a permission request is reported from the re-probe, not from the request', () => {
  assert.match(permissionRequestResultLabel(true), /重新探测确认可写入/u)
  const unconfirmed = permissionRequestResultLabel(false)
  assert.match(unconfirmed, /仍未确认写入能力/u)
  assert.match(unconfirmed, /不会写入 Zotero/u)
  assert.match(permissionRequestResultLabel(undefined), /不会写入 Zotero/u)
})

/**
 * Requirement: the top-level project classification is written as the exact
 * `# <项目名>` Zotero tag, so the tag shown before confirming is the tag that
 * lands in Zotero (未分类 for an explicitly unclassified write).
 */
test('the frozen project classification is shown as the exact Zotero tag', () => {
  assert.equal(projectTagLabel('合成生物学'), '#合成生物学')
  assert.equal(projectTagLabel('  合成生物学  '), '#合成生物学')
  assert.equal(projectTagLabel('#未分类'), '#未分类')
  assert.equal(projectTagLabel(null), '未设置项目标签')
  assert.equal(projectTagLabel(undefined), '未设置项目标签')
  assert.equal(projectTagLabel('   '), '未设置项目标签')
})

/**
 * Requirement: the top-level project classification is chosen deliberately
 * before a preview exists (the confirmation can no longer be the first place it
 * is selected), and a project that no longer resolves is reported instead of
 * being silently written as 未分类.
 */
test('the pre-preview classification says what the next preview will freeze', () => {
  assert.match(pendingProjectTagLabel(undefined), /自动/u)
  assert.match(pendingProjectTagLabel(undefined), /#未分类/u)
  assert.equal(pendingProjectTagLabel(null), '#未分类')
  assert.equal(pendingProjectTagLabel('proj-1', '合成生物学'), '#合成生物学')
  assert.equal(pendingProjectTagLabel('proj-1', '  合成生物学  '), '#合成生物学')
  assert.match(pendingProjectTagLabel('proj-1', ''), /已失效/u)
  assert.match(pendingProjectTagLabel('proj-1', null), /已失效/u)
})

/**
 * Requirement: the preview and its confirmation state the frozen plan — target
 * Collection, top-level classification, write scope and profile revision — as
 * values, so the confirmation screen shows what the execute call re-checks
 * instead of prose the user has to re-derive before an external write.
 */
test('frozen write values state the target, scope and revision being confirmed', () => {
  const write = frozenWriteValues({ transport: 'api', capability: 'write', total: 3, targetCollectionKey: 'COLL0001', targetCollectionName: '机器学习', projectTag: '合成生物学', profileRevision: 7, updateCandidates: 1, reviewItems: 1 })
  assert.deepEqual(write.map((entry) => entry.label), ['写入方式', '目标 Collection', '写入范围', '顶层项目分类', '冻结版本'])
  const values = Object.fromEntries(write.map((entry) => [entry.label, entry.value]))
  assert.match(values['写入方式'] ?? '', /^Zotero API 写入/u)
  assert.equal(values['目标 Collection'], '机器学习（ID: COLL0001）')
  assert.equal(values['顶层项目分类'], '#合成生物学')
  assert.equal(values['冻结版本'], 'profile revision 7')
  assert.match(values['写入范围'] ?? '', /共 3 条/u)
  assert.match(values['写入范围'] ?? '', /1 条更新已匹配条目/u)
  assert.match(values['写入范围'] ?? '', /1 条重复无法确认，确认时跳过/u)
  assert.match(values['写入范围'] ?? '', /1 条新建/u)
  // A read-only connection is described as a package, never as a write.
  const fallback = Object.fromEntries(frozenWriteValues({ transport: 'save-file', capability: 'read', total: 1, targetCollectionKey: null, projectTag: null, profileRevision: 2, updateCandidates: 0, reviewItems: 0 }).map((entry) => [entry.label, entry.value]))
  assert.match(fallback['写入方式'] ?? '', /RIS\/BibTeX/u)
  assert.match(fallback['写入方式'] ?? '', /不会写入 Zotero/u)
  assert.equal(fallback['目标 Collection'], '默认（不更改成员关系）')
  assert.equal(fallback['顶层项目分类'], '未设置项目标签')
  assert.match(fallback['写入范围'] ?? '', /1 条新建/u)
  // An `api` transport whose capability is not `write` must not read as a write.
  const unprobed = frozenWriteValues({ transport: 'api', capability: 'read', total: 1, targetCollectionKey: 'COLL0001', targetCollectionName: null, projectTag: null, profileRevision: 1, updateCandidates: 0, reviewItems: 0 })
  assert.match(unprobed[0]?.value ?? '', /capability 为 read/u)
  assert.match(unprobed[0]?.value ?? '', /逐条会返回失败/u)
})

test('the Zotero delete entry tells the user the real two-sided effect before it runs', () => {
  assert.match(remoteDeleteLabels.entry, /删除 Zotero 条目/u)
  assert.equal(remoteDeleteLabels.entryHint, '两侧都删')
  assert.equal(remoteDeleteLabels.preview, '预览删除')
  // The confirmation is rendered before any request is sent, so it must state
  // the permanent remote erase, the local archival (not deletion) and the
  // failure behaviour instead of promising that nothing will happen.
  assert.match(remoteDeleteLabels.confirm, /永久删除/u)
  assert.match(remoteDeleteLabels.confirm, /只有 Zotero 确认删除后才删除本地/u)
  assert.match(remoteDeleteLabels.confirm, /归档而不是删除/u)
  assert.match(remoteDeleteLabels.confirm, /远端删除失败、版本冲突或无写入权限时/u)
  assert.match(remoteDeleteLabels.confirm, /都会保留/u)
})

test('a completed two-sided delete summary counts only real remote deletions and local projections', () => {
  const receipt = {
    profileId: 'INT0001',
    status: 'completed' as const,
    remoteDeletedCount: 2,
    localRemovedCount: 1,
    items: [
      { itemKey: 'I1', remote: 'deleted' as const, remoteVersion: '99', local: 'removed' as const, paperId: 'PAP0001', title: 'Fixture paper', message: 'Zotero 已永久删除该条目，本地投影已归档。', retryable: false },
      { itemKey: 'I2', remote: 'absent' as const, remoteVersion: null, local: 'no-local-record' as const, paperId: null, title: null, message: 'Zotero 远端已不存在该条目，本地没有对应投影。', retryable: false }
    ],
    message: '已完成两侧删除。'
  }
  const summary = remoteDeleteReceiptSummary(receipt)
  assert.match(summary, /已完成两侧删除/u)
  assert.match(summary, /共 2 条/u)
  assert.match(summary, /Zotero 删除 2 条/u)
  assert.match(summary, /本地删除 1 条投影/u)
  const rows = remoteDeleteReceiptRows(receipt)
  assert.deepEqual(rows.map((row) => row.key), ['I1', 'I2'])
  assert.match(rows[0]?.outcome ?? '', /Zotero 已永久删除 · 本地投影已删除/u)
  assert.match(rows[1]?.outcome ?? '', /Zotero 远端已不存在 · 本地无对应投影/u)
  // Every row keeps the server-provided detail instead of collapsing to a count.
  assert.equal(rows[1]?.detail, 'Zotero 远端已不存在该条目，本地没有对应投影。')
})

test('a partial delete summary keeps the failed keys visible with their local record retained', () => {
  const receipt = {
    profileId: 'INT0001',
    status: 'partial' as const,
    remoteDeletedCount: 1,
    localRemovedCount: 1,
    items: [
      { itemKey: 'I1', remote: 'deleted' as const, remoteVersion: '99', local: 'removed' as const, paperId: 'PAP0001', title: 'Kept', message: 'ok', retryable: false },
      { itemKey: 'I2', remote: 'conflict' as const, remoteVersion: '9', local: 'kept' as const, paperId: 'PAP0002', title: 'Stale', message: 'Zotero 条目已被修改（远端版本 9）。本地记录未删除。', retryable: true }
    ],
    message: '部分完成。'
  }
  const rows = remoteDeleteReceiptRows(receipt)
  assert.match(rows[1]?.outcome ?? '', /版本冲突，未删除 · 本地记录已保留/u)
  assert.match(rows[1]?.detail ?? '', /本地记录未删除/u)
  assert.equal(ZoteroRemoteDeleteReceiptSchema.safeParse(receipt).success, true)
})

test('the frozen receipt schema rejects any delete receipt whose counts or pairs disagree', () => {
  const blocked = {
    profileId: 'INT0001',
    status: 'blocked',
    remoteDeletedCount: 0,
    localRemovedCount: 0,
    items: [
      { itemKey: 'I1', remote: 'unauthorized', remoteVersion: null, local: 'kept', paperId: 'PAP0001', title: 'Fixture', message: '未授权，未删除。', retryable: true },
      { itemKey: 'I2', remote: 'unavailable', remoteVersion: null, local: 'kept', paperId: null, title: null, message: '无法确认，未删除。', retryable: true }
    ],
    message: 'Zotero 远端删除被阻断。'
  }
  assert.equal(ZoteroRemoteDeleteReceiptSchema.safeParse(blocked).success, true)
  // A blocked receipt can never report a deletion.
  assert.equal(ZoteroRemoteDeleteReceiptSchema.safeParse({ ...blocked, remoteDeletedCount: 1 }).success, false)
  assert.equal(ZoteroRemoteDeleteReceiptSchema.safeParse({
    ...blocked,
    items: [{ ...blocked.items[0], remote: 'deleted', remoteVersion: '99', local: 'removed' }, blocked.items[1]]
  }).success, false)
  // A local row can only be `removed` when the remote half really is gone.
  assert.equal(ZoteroRemoteDeleteReceiptSchema.safeParse({
    ...blocked,
    localRemovedCount: 1,
    items: [{ ...blocked.items[0], local: 'removed' }, blocked.items[1]]
  }).success, false)
  // Counts must match the per-key rows.
  assert.equal(ZoteroRemoteDeleteReceiptSchema.safeParse({ ...blocked, remoteDeletedCount: 2 }).success, false)
  // A completed receipt cannot leave a remote item behind.
  assert.equal(ZoteroRemoteDeleteReceiptSchema.safeParse({ ...blocked, status: 'completed' }).success, false)
  // A real success is accepted only with matching counts and a gone remote item.
  assert.equal(ZoteroRemoteDeleteReceiptSchema.safeParse({
    profileId: 'INT0001',
    status: 'completed',
    remoteDeletedCount: 1,
    localRemovedCount: 1,
    items: [{ itemKey: 'I1', remote: 'deleted', remoteVersion: '99', local: 'removed', paperId: 'PAP0001', title: 'Fixture', message: 'ok', retryable: false }],
    message: '完成。'
  }).success, true)
})
