import {
  ContextMenuTargetSchema,
  type ContextCapability,
  type ContextMenuTarget
} from '@prw/contracts'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode
} from 'react'

export type ContextActionHandler = (target: ContextMenuTarget) => void | Promise<void>
export type ContextActionHandlers = Partial<Record<ContextCapability, ContextActionHandler>>
export type TabContextAction = 'close-current' | 'close-others' | 'close-right' | 'close-all' | 'pin' | 'duplicate'

interface OpenMenuState {
  target: ContextMenuTarget
  handlers: ContextActionHandlers
  tabActions: Partial<Record<TabContextAction, () => void | Promise<void>>>
  x: number
  y: number
}

interface ContextMenuContextValue {
  open: (target: ContextMenuTarget, handlers: ContextActionHandlers, tabActions: Partial<Record<TabContextAction, () => void | Promise<void>>>, point: { x: number; y: number }) => void
}

const ContextMenuContext = createContext<ContextMenuContextValue | null>(null)

const capabilityLabels: Record<ContextCapability, string> = {
  open: '打开',
  'open-new-tab': '在新标签打开',
  'copy-id': '复制标识',
  edit: '编辑',
  move: '移动',
  associate: '关联资源',
  archive: '归档',
  restore: '恢复',
  'hard-delete': '永久删除',
  refresh: '刷新',
  'set-filter': '设为筛选条件',
  'set-import-target': '设为导入目标',
  delete: '删除'
}

const dangerousCapabilities = new Set<ContextCapability>(['archive', 'restore', 'hard-delete', 'delete'])

const targetLabels: Record<ContextMenuTarget['type'], string> = {
  tab: '标签页',
  project: '项目',
  task: '任务',
  paper: '文献',
  note: '笔记',
  'calendar-event': '日历事件',
  'zotero-collection': 'Zotero 集合',
  'zotero-item': 'Zotero 条目',
  resource: '资源'
}

function normalisePoint(point: { x: number; y: number }): { x: number; y: number } {
  // Keep the fixed menu within the viewport even for a context menu key press.
  const width = 236
  const height = 360
  return {
    x: Math.max(8, Math.min(point.x, window.innerWidth - width - 8)),
    y: Math.max(8, Math.min(point.y, window.innerHeight - height - 8))
  }
}

function capabilityOrder(capabilities: ContextCapability[]): ContextCapability[] {
  const order: ContextCapability[] = [
    'open', 'open-new-tab', 'copy-id', 'edit', 'move', 'associate', 'set-filter',
    'set-import-target', 'refresh', 'archive', 'restore', 'delete', 'hard-delete'
  ]
  const allowed = new Set(capabilities)
  return order.filter((capability) => allowed.has(capability))
}

export function ContextMenuHost({ children }: { children: ReactNode }): React.JSX.Element {
  const [menu, setMenu] = useState<OpenMenuState | null>(null)
  const open = useCallback((rawTarget: ContextMenuTarget, handlers: ContextActionHandlers, tabActions: Partial<Record<TabContextAction, () => void | Promise<void>>>, point: { x: number; y: number }) => {
    const parsed = ContextMenuTargetSchema.safeParse(rawTarget)
    if (!parsed.success || parsed.data.capabilities.length === 0) {
      setMenu(null)
      return
    }
    const bounded = normalisePoint(point)
    setMenu({ target: parsed.data, handlers, tabActions, x: bounded.x, y: bounded.y })
  }, [])
  const close = useCallback(() => setMenu(null), [])

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const menuElement = document.querySelector('[data-shell-context-menu]')
      if (menuElement && event.target instanceof Node && menuElement.contains(event.target)) return
      close()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [close])

  return <ContextMenuContext.Provider value={{ open }}>{children}{menu ? <ContextMenuPanel close={close} menu={menu} /> : null}</ContextMenuContext.Provider>
}

function ContextMenuPanel({ menu, close }: { menu: OpenMenuState; close: () => void }): React.JSX.Element {
  const capabilities = useMemo(() => capabilityOrder(menu.target.capabilities), [menu.target.capabilities])
  const tabActions = useMemo(() => menu.target.type === 'tab'
    ? (['close-current', 'close-others', 'close-right', 'close-all', 'pin', 'duplicate'] as TabContextAction[]).filter((action) => Boolean(menu.tabActions[action]))
    : [], [menu.tabActions, menu.target.type])
  const [focused, setFocused] = useState(0)
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([])
  const itemCount = capabilities.length + tabActions.length
  useEffect(() => {
    itemRefs.current[focused]?.focus()
  }, [focused])

  const run = async (capability: ContextCapability): Promise<void> => {
    const handler = menu.handlers[capability] ?? (capability === 'copy-id'
      ? () => { void navigator.clipboard?.writeText(menu.target.id) }
      : undefined)
    if (!handler) return
    if (dangerousCapabilities.has(capability)) {
      const confirmed = window.confirm(`确认${capabilityLabels[capability]}此${targetLabels[menu.target.type]}？此操作可能影响本地数据。`)
      if (!confirmed) return
    }
    try {
      await handler(menu.target)
      close()
    } catch {
      // Do not leak connector errors, paths or response bodies into the shell.
      // A feature callback can surface its typed, redacted error in its own page.
      close()
    }
  }

  const runTabAction = async (action: TabContextAction): Promise<void> => {
    const handler = menu.tabActions[action]
    if (!handler) return
    try {
      await handler()
      close()
    } catch {
      close()
    }
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      setFocused((current) => (current + 1) % Math.max(itemCount, 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setFocused((current) => (current - 1 + Math.max(itemCount, 1)) % Math.max(itemCount, 1))
    } else if (event.key === 'Home') {
      event.preventDefault()
      setFocused(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      setFocused(Math.max(itemCount - 1, 0))
    } else if (event.key === 'Enter' && focused < capabilities.length && capabilities[focused]) {
      event.preventDefault()
      void run(capabilities[focused])
    } else if (event.key === 'Enter' && focused >= capabilities.length && tabActions[focused - capabilities.length]) {
      event.preventDefault()
      const action = tabActions[focused - capabilities.length]
      if (action) void runTabAction(action)
    }
  }

  return <div
    aria-label={`${targetLabels[menu.target.type]}操作`}
    className="fixed z-[100] min-w-52 rounded-md border border-border bg-surface p-1 text-foreground shadow-xl"
    data-shell-context-menu="true"
    onKeyDown={onKeyDown}
    onPointerDown={(event) => event.stopPropagation()}
    role="menu"
    style={{ left: menu.x, top: menu.y }}
    tabIndex={-1}
  >
    <div className="border-b border-border px-2.5 py-1.5 text-[10px] font-semibold text-muted-foreground" role="presentation">
      {targetLabels[menu.target.type]} · {menu.target.id}
    </div>
    {capabilities.map((capability, index) => {
      const handlerAvailable = capability === 'copy-id' || Boolean(menu.handlers[capability])
      return <button
        aria-disabled={!handlerAvailable}
        className="flex min-h-8 w-full items-center rounded px-2.5 text-left text-xs outline-none hover:bg-muted focus-visible:bg-muted disabled:pointer-events-none disabled:opacity-45"
        disabled={!handlerAvailable}
        key={capability}
        onClick={() => void run(capability)}
        ref={(element) => { itemRefs.current[index] = element }}
        role="menuitem"
        type="button"
      >
        {capabilityLabels[capability]}
        {dangerousCapabilities.has(capability) ? <span className="ml-auto text-[10px] text-danger">需确认</span> : null}
      </button>
    })}
    {tabActions.length > 0 ? <div className="my-1 border-t border-border" role="separator" /> : null}
    {tabActions.map((action, index) => <button
      aria-label={tabActionLabels[action]}
      className="flex min-h-8 w-full items-center rounded px-2.5 text-left text-xs outline-none hover:bg-muted focus-visible:bg-muted"
      key={action}
      onClick={() => void runTabAction(action)}
      ref={(element) => { itemRefs.current[capabilities.length + index] = element }}
      role="menuitem"
      type="button"
    >{tabActionLabels[action]}</button>)}
  </div>
}

const tabActionLabels: Record<TabContextAction, string> = {
  'close-current': '关闭当前',
  'close-others': '关闭其他',
  'close-right': '关闭右侧',
  'close-all': '关闭全部',
  pin: '固定/取消固定',
  duplicate: '复制标签'
}

export function ContextMenuTrigger({
  target,
  handlers = {},
  tabActions = {},
  children,
  className
}: {
  target: ContextMenuTarget
  handlers?: ContextActionHandlers
  tabActions?: Partial<Record<TabContextAction, () => void | Promise<void>>>
  children: ReactNode
  className?: string
}): React.JSX.Element {
  const context = useContext(ContextMenuContext)
  const open = (x: number, y: number) => context?.open(target, handlers, tabActions, { x, y })
  const onContextMenu = (event: ReactMouseEvent<HTMLSpanElement>) => {
    event.preventDefault()
    open(event.clientX, event.clientY)
  }
  const onKeyDown = (event: ReactKeyboardEvent<HTMLSpanElement>) => {
    const contextKey = event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)
    if (!contextKey) return
    event.preventDefault()
    const rect = event.currentTarget.getBoundingClientRect()
    open(rect.left + Math.min(rect.width, 18), rect.bottom + 4)
  }
  return <span
    aria-label={`${targetLabels[target.type]}操作`}
    className={className ?? 'contents'}
    onContextMenu={onContextMenu}
    onKeyDown={onKeyDown}
    tabIndex={0}
  >{children}</span>
}

export function useContextMenu(): ContextMenuContextValue {
  const context = useContext(ContextMenuContext)
  if (!context) throw new Error('ContextMenuTrigger 必须位于 ContextMenuHost 内。')
  return context
}

export { targetLabels }
