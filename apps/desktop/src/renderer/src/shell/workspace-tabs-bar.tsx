import type { ContextMenuTarget, WorkspaceTab } from '@prw/contracts'
import { Plus, Pin, X } from 'lucide-react'
import { ContextMenuTrigger, type ContextActionHandlers, type TabContextAction } from './context-menu'
import type { WorkspaceTabAction } from './workspace-tabs'

export interface WorkspaceTabsBarProps {
  tabs: WorkspaceTab[]
  activeTabId: string | null
  onSelect: (tabId: string, openInNewTab: boolean) => void
  onOpenNew: () => void
  onCloseRequest: (tabs: WorkspaceTab[], action: WorkspaceTabAction | 'close') => Promise<void>
  onPin: (tabId: string) => void
  onDuplicate: (tabId: string) => void
}

function tabTarget(tab: WorkspaceTab): ContextMenuTarget {
  return { type: 'tab', id: tab.tabId, capabilities: ['open', 'open-new-tab', 'copy-id'] }
}

export function WorkspaceTabsBar({
  tabs,
  activeTabId,
  onSelect,
  onOpenNew,
  onCloseRequest,
  onPin,
  onDuplicate
}: WorkspaceTabsBarProps): React.JSX.Element {
  return <div aria-label="工作区标签页" className="flex min-h-10 items-center gap-1 overflow-x-auto border-b border-border bg-surface px-2" role="tablist">
    {tabs.map((tab) => {
      const active = tab.tabId === activeTabId
      const handlers: ContextActionHandlers = {
        open: () => onSelect(tab.tabId, false),
        'open-new-tab': () => onDuplicate(tab.tabId)
      }
      const tabActions: Partial<Record<TabContextAction, () => void | Promise<void>>> = {
        'close-current': () => onCloseRequest([tab], 'close'),
        'close-others': () => onCloseRequest(tabs.filter((candidate) => candidate.tabId !== tab.tabId && !candidate.pinned), 'close-others'),
        'close-right': () => {
          const index = tabs.findIndex((candidate) => candidate.tabId === tab.tabId)
          return onCloseRequest(tabs.slice(index + 1).filter((candidate) => !candidate.pinned), 'close-right')
        },
        'close-all': () => onCloseRequest(tabs.filter((candidate) => !candidate.pinned), 'close-all'),
        pin: () => onPin(tab.tabId),
        duplicate: () => onDuplicate(tab.tabId)
      }
      return <ContextMenuTrigger handlers={handlers} key={tab.tabId} tabActions={tabActions} target={tabTarget(tab)}>
        <div aria-label={tab.title} className={`group flex min-h-8 shrink-0 items-center gap-1 rounded-t border border-b-0 px-1 text-xs ${active ? 'border-primary/60 bg-background text-foreground' : 'border-transparent text-muted-foreground hover:bg-muted hover:text-foreground'}`} role="presentation">
          <button
            aria-selected={active}
            className="flex min-h-8 max-w-48 items-center gap-1.5 px-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={(event) => onSelect(tab.tabId, event.ctrlKey || event.metaKey)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowRight') {
                const index = tabs.findIndex((candidate) => candidate.tabId === tab.tabId)
                const next = tabs[(index + 1) % tabs.length]
                if (next) onSelect(next.tabId, false)
              } else if (event.key === 'ArrowLeft') {
                const index = tabs.findIndex((candidate) => candidate.tabId === tab.tabId)
                const next = tabs[(index - 1 + tabs.length) % tabs.length]
                if (next) onSelect(next.tabId, false)
              }
            }}
            role="tab"
            title={tab.title}
            type="button"
          >
            {tab.pinned ? <Pin aria-hidden="true" className="size-3 text-primary" /> : null}
            <span className="truncate">{tab.title}</span>
          </button>
          <button aria-label={`关闭标签：${tab.title}`} className="grid size-6 shrink-0 place-items-center rounded text-muted-foreground opacity-65 outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100" onClick={() => void onCloseRequest([tab], 'close')} type="button"><X aria-hidden="true" className="size-3.5" /></button>
        </div>
      </ContextMenuTrigger>
    })}
    <button aria-label="新建标签" className="ml-1 grid size-7 shrink-0 place-items-center rounded text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring" onClick={onOpenNew} title="新建标签" type="button"><Plus aria-hidden="true" className="size-4" /></button>
  </div>
}
