import { ChevronDown } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { AgentRunRecordEntry } from '@prw/contracts'
import { Button } from '../../components/ui'
import { InlineLoadingState } from '../../components/states'
import { cn } from '../../lib/utils'
import {
  collapse,
  formatDuration,
  groupRecordsByTurn,
  recordKindLabels,
  recordStatusLabels,
  recordSummary,
  statusTone,
  usageSummary,
  type LedgerTurn
} from './ledger'
import { TrajectoryRecordInspector } from './inspector'

const rowHeight = 28
const overscan = 10

type TrajectoryRow =
  | { readonly type: 'turn'; readonly key: string; readonly turn: LedgerTurn }
  | { readonly type: 'record'; readonly key: string; readonly record: AgentRunRecordEntry }

/**
 * Trajectory tab: an equal-height, virtualized ledger.
 *
 * Row height is fixed so the list can be windowed without measuring, and
 * turn boundaries become their own row carrying that turn's duration and
 * usage. Selecting a row opens the read-only record inspector.
 */
export function TrajectoryView({ records, isRunning, isFetching, hasEarlier, loadingEarlier, onLoadEarlier }: {
  readonly records: readonly AgentRunRecordEntry[]
  readonly isRunning: boolean
  readonly isFetching: boolean
  readonly hasEarlier: boolean
  readonly loadingEarlier: boolean
  readonly onLoadEarlier: () => void
}): React.JSX.Element {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [viewport, setViewport] = useState({ height: 0, scrollTop: 0 })
  const containerRef = useRef<HTMLDivElement | null>(null)
  const stickRef = useRef(true)

  const rows = useMemo<TrajectoryRow[]>(() => {
    const turnInfo = new Map(groupRecordsByTurn(records).map((turn) => [turn.turn, turn]))
    const built: TrajectoryRow[] = []
    let currentTurn: number | null = null
    for (const record of records) {
      if (record.turn > 0 && record.turn !== currentTurn) {
        currentTurn = record.turn
        const turn = turnInfo.get(record.turn)
        if (turn) built.push({ type: 'turn', key: `turn-${record.turn}`, turn })
      }
      built.push({ type: 'record', key: record.id, record })
    }
    return built
  }, [records])

  const selected = useMemo(
    () => (selectedId === null ? null : records.find((record) => record.id === selectedId) ?? null),
    [records, selectedId]
  )

  useEffect(() => {
    const element = containerRef.current
    if (!element) return
    const observer = new ResizeObserver(() => setViewport((current) => (current.height === element.clientHeight ? current : { ...current, height: element.clientHeight })))
    observer.observe(element)
    setViewport((current) => (current.height === element.clientHeight ? current : { ...current, height: element.clientHeight }))
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const element = containerRef.current
    if (!element || !stickRef.current) return
    element.scrollTop = element.scrollHeight
  }, [rows.length])

  const first = Math.max(0, Math.floor(viewport.scrollTop / rowHeight) - overscan)
  const last = Math.min(rows.length, Math.ceil((viewport.scrollTop + Math.max(viewport.height, rowHeight)) / rowHeight) + overscan)
  const visible = rows.slice(first, last)

  const scrollToRow = (index: number): void => {
    const element = containerRef.current
    if (!element) return
    stickRef.current = false
    const top = index * rowHeight
    if (top < element.scrollTop) element.scrollTop = top
    else if (top + rowHeight > element.scrollTop + element.clientHeight) element.scrollTop = top + rowHeight - element.clientHeight
  }

  const moveSelection = (delta: number): void => {
    let index = rows.findIndex((row) => row.type === 'record' && row.record.id === selectedId)
    if (index === -1) index = delta > 0 ? -1 : rows.length
    for (let step = 0; step < rows.length; step += 1) {
      index += delta
      const row = rows[index]
      if (!row) return
      if (row.type !== 'record') continue
      setSelectedId(row.record.id)
      scrollToRow(index)
      return
    }
  }

  if (records.length === 0) {
    return <div className="agent-trajectory-empty">
      <h2>还没有可查看的轨迹</h2>
      <p>{isRunning ? '运行已经开始，正在等待第一条记录…' : '发起一次 Agent 运行后，这里会显示归一化的运行账本：回合、步骤、工具调用、推理与耗时。'}</p>
      {isFetching ? <InlineLoadingState label="正在读取账本…" /> : null}
    </div>
  }

  return <div className={cn('agent-trajectory', selected && 'agent-trajectory-inspecting')}>
    <div className="agent-trajectory-main">
      <div className="agent-trajectory-head" role="presentation">
        <span>#</span>
        <span>类型</span>
        <span>摘要</span>
        <span>耗时</span>
        <span>状态</span>
      </div>
      {hasEarlier ? <div className="agent-trajectory-earlier">
        <Button disabled={loadingEarlier} onClick={onLoadEarlier} size="sm" variant="secondary">
          {loadingEarlier ? '正在加载…' : '加载更早的记录'}
        </Button>
      </div> : null}
      <div
        aria-label="运行轨迹"
        className="agent-trajectory-list"
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'j') { event.preventDefault(); moveSelection(1) }
          else if (event.key === 'ArrowUp' || event.key === 'k') { event.preventDefault(); moveSelection(-1) }
          else if (event.key === 'Escape') setSelectedId(null)
        }}
        onScroll={(event) => {
          const element = event.currentTarget
          stickRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40
          setViewport((current) => (current.scrollTop === element.scrollTop ? current : { ...current, scrollTop: element.scrollTop }))
        }}
        ref={containerRef}
        role="listbox"
        tabIndex={0}
      >
        <div className="agent-trajectory-canvas" role="presentation" style={{ height: `${rows.length * rowHeight}px` }}>
          {visible.map((row, offset) => {
            const index = first + offset
            if (row.type === 'turn') {
              return <div className="agent-trajectory-turn" key={row.key} role="presentation" style={{ top: `${index * rowHeight}px` }}>
                <span className="agent-trajectory-turn-label">Turn {row.turn.turn}</span>
                <span className="agent-trajectory-turn-meta">{recordCountLabel(row.turn.records.length)}</span>
                <span className="agent-trajectory-turn-meta">{formatDuration(row.turn.durationMs)}</span>
                <span className="agent-trajectory-turn-meta">{usageSummary(row.turn.usage)}</span>
              </div>
            }
            const tone = statusTone(row.record.status)
            return <div
              aria-selected={row.record.id === selectedId}
              className={cn('agent-trajectory-row', row.record.id === selectedId && 'agent-trajectory-row-selected')}
              key={row.key}
              onClick={() => setSelectedId(row.record.id)}
              onDoubleClick={() => setSelectedId(row.record.id)}
              role="option"
              style={{ top: `${index * rowHeight}px` }}
              tabIndex={-1}
            >
              <span className="agent-trajectory-seq">#{row.record.seq}</span>
              <span className={cn('agent-trajectory-kind', `agent-kind-${row.record.kind}`)}>{recordKindLabels[row.record.kind]}</span>
              <span className="agent-trajectory-summary" title={collapse(recordSummary(row.record))}>{recordSummary(row.record)}</span>
              <span className="agent-trajectory-duration">{formatDuration(row.record.durationMs)}</span>
              <span className="agent-trajectory-state">
                <span className={cn('agent-status-dot', `agent-status-dot-${tone}`)} />
                {recordStatusLabels[row.record.status]}
              </span>
            </div>
          })}
        </div>
      </div>
      <p className="agent-trajectory-hint">点击任意行查看详情 · ↑/↓ 或 j/k 移动 · Esc 关闭 · 共 {rows.length} 行</p>
    </div>
    <aside className="agent-trajectory-aside">
      {selected
        ? <TrajectoryRecordInspector onClose={() => setSelectedId(null)} record={selected} />
        : <div className="agent-trajectory-aside-empty">
          <ChevronDown aria-hidden="true" className="size-4" />
          <p>选择一条记录查看 Input / Output / Timing 与用量。</p>
        </div>}
    </aside>
  </div>
}

function recordCountLabel(count: number): string {
  return `${count} 条记录`
}
