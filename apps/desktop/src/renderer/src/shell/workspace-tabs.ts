import {
  WorkspaceTabSchema,
  WorkspaceTabStateSchema,
  type ResourceKind,
  type ResourceRef,
  type WorkspaceRoute,
  type WorkspaceTab
} from '@prw/contracts'
import { useCallback, useEffect, useMemo, useState } from 'react'

/**
 * Workspace tabs are deliberately renderer/session state.  They are validated
 * at this boundary and persisted as the frozen V2 `{ version, tabs }` value;
 * no route is ever treated as an arbitrary URL or command.
 */
export const WORKSPACE_TABS_STORAGE_KEY = 'workbench-workspace-tabs:v1'
export const WORKSPACE_ACTIVE_TAB_STORAGE_KEY = 'workbench-active-tab:v1'
const STORAGE_KEY = WORKSPACE_TABS_STORAGE_KEY
const ACTIVE_KEY = WORKSPACE_ACTIVE_TAB_STORAGE_KEY
const EMPTY_VALIDATION_INDEX: WorkspaceTabValidationIndex = {}

export interface WorkspaceTabsState {
  tabs: WorkspaceTab[]
  activeTabId: string | null
}

export interface WorkspaceTabValidationIndex {
  projectIds?: ReadonlySet<string>
  resources?: Partial<Record<ResourceKind, ReadonlySet<string>>>
}

export type WorkspaceTabsAction =
  | { type: 'open'; tab: WorkspaceTab; activate?: boolean }
  | { type: 'select'; tabId: string }
  | { type: 'update-current'; patch: Partial<Pick<WorkspaceTab, 'route' | 'context' | 'title'>> }
  | { type: 'update-context'; tabId: string; context: WorkspaceTab['context'] }
  | { type: 'close'; tabId: string }
  | { type: 'close-current' }
  | { type: 'close-others'; tabId: string }
  | { type: 'close-right'; tabId: string }
  | { type: 'close-all' }
  | { type: 'pin'; tabId: string; pinned?: boolean }
  | { type: 'duplicate'; tabId: string; tab: WorkspaceTab }
  | { type: 'clean'; validate: (tab: WorkspaceTab) => boolean }
  | { type: 'replace'; tabs: WorkspaceTab[]; activeTabId?: string | null }

function newTabId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function nowIso(): string {
  return new Date().toISOString()
}

export function createWorkspaceTab(input: {
  route: WorkspaceRoute
  title: string
  context?: WorkspaceTab['context']
  pinned?: boolean
  tabId?: string
  createdAt?: string
}): WorkspaceTab {
  return WorkspaceTabSchema.parse({
    tabId: input.tabId ?? newTabId(),
    route: input.route,
    context: input.context ?? { projectId: null, resource: null },
    title: input.title,
    pinned: input.pinned ?? false,
    createdAt: input.createdAt ?? nowIso()
  })
}

function fallbackActive(tabs: WorkspaceTab[], preferred: string | null): string | null {
  if (preferred && tabs.some((tab) => tab.tabId === preferred)) return preferred
  return tabs.at(-1)?.tabId ?? null
}

function closeTabFromState(state: WorkspaceTabsState, tabId: string): WorkspaceTabsState {
  const index = state.tabs.findIndex((tab) => tab.tabId === tabId)
  if (index < 0) return state
  const tabs = state.tabs.filter((tab) => tab.tabId !== tabId)
  if (state.activeTabId !== tabId) return { ...state, tabs }
  const next = tabs[index] ?? tabs[index - 1] ?? tabs.find((tab) => tab.pinned) ?? tabs[0]
  return { tabs, activeTabId: next?.tabId ?? null }
}

export function workspaceTabsReducer(state: WorkspaceTabsState, action: WorkspaceTabsAction): WorkspaceTabsState {
  switch (action.type) {
    case 'open': {
      const tabs = state.tabs.some((tab) => tab.tabId === action.tab.tabId)
        ? state.tabs.map((tab) => tab.tabId === action.tab.tabId ? action.tab : tab)
        : [...state.tabs, action.tab]
      return { tabs, activeTabId: action.activate === false ? state.activeTabId : action.tab.tabId }
    }
    case 'select':
      return state.tabs.some((tab) => tab.tabId === action.tabId) ? { ...state, activeTabId: action.tabId } : state
    case 'update-current': {
      if (!state.activeTabId) return state
      const current = state.tabs.find((tab) => tab.tabId === state.activeTabId)
      if (!current) return state
      const parsed = WorkspaceTabSchema.safeParse({ ...current, ...action.patch })
      if (!parsed.success) return state
      return {
        ...state,
        tabs: state.tabs.map((tab) => tab.tabId === state.activeTabId ? parsed.data : tab)
      }
    }
    case 'update-context':
      return state.tabs.some((tab) => tab.tabId === action.tabId)
        ? (() => {
          const current = state.tabs.find((tab) => tab.tabId === action.tabId)
          const parsed = current ? WorkspaceTabSchema.safeParse({ ...current, context: action.context }) : null
          return parsed?.success ? { ...state, tabs: state.tabs.map((tab) => tab.tabId === action.tabId ? parsed.data : tab) } : state
        })()
        : state
    case 'close':
      return closeTabFromState(state, action.tabId)
    case 'close-current':
      return state.activeTabId ? closeTabFromState(state, state.activeTabId) : state
    case 'close-others': {
      const keep = state.tabs.filter((tab) => tab.tabId === action.tabId || tab.pinned)
      const activeTabId = keep.some((tab) => tab.tabId === state.activeTabId) ? state.activeTabId : action.tabId
      return { tabs: keep, activeTabId: fallbackActive(keep, activeTabId) }
    }
    case 'close-right': {
      const index = state.tabs.findIndex((tab) => tab.tabId === action.tabId)
      if (index < 0) return state
      const tabs = state.tabs.filter((tab, tabIndex) => tabIndex <= index || tab.pinned)
      return { tabs, activeTabId: fallbackActive(tabs, state.activeTabId) }
    }
    case 'close-all': {
      const tabs = state.tabs.filter((tab) => tab.pinned)
      return { tabs, activeTabId: fallbackActive(tabs, state.activeTabId) }
    }
    case 'pin':
      return { ...state, tabs: state.tabs.map((tab) => tab.tabId === action.tabId ? { ...tab, pinned: action.pinned ?? !tab.pinned } : tab) }
    case 'duplicate': {
      const index = state.tabs.findIndex((tab) => tab.tabId === action.tabId)
      if (index < 0) return state
      const tabs = [...state.tabs]
      tabs.splice(index + 1, 0, action.tab)
      return { tabs, activeTabId: action.tab.tabId }
    }
    case 'clean': {
      const tabs = state.tabs.filter(action.validate)
      const activeTabId = fallbackActive(tabs, state.activeTabId)
      if (tabs.length === state.tabs.length && activeTabId === state.activeTabId) return state
      return { tabs, activeTabId }
    }
    case 'replace': {
      const ids = new Set<string>()
      const tabs = action.tabs.filter((tab) => {
        if (ids.has(tab.tabId)) return false
        ids.add(tab.tabId)
        return true
      })
      return { tabs, activeTabId: fallbackActive(tabs, action.activeTabId ?? state.activeTabId) }
    }
  }
}

function parseStoredTabs(raw: string | null): WorkspaceTab[] | null {
  if (!raw) return null
  try {
    const parsed = WorkspaceTabStateSchema.safeParse(JSON.parse(raw))
    if (!parsed.success) return []
    const seen = new Set<string>()
    return parsed.data.tabs.filter((tab) => {
      if (seen.has(tab.tabId)) return false
      seen.add(tab.tabId)
      return true
    })
  } catch {
    return []
  }
}

export function loadWorkspaceTabs(): WorkspaceTabsState {
  if (typeof localStorage === 'undefined') {
    const tab = createWorkspaceTab({ route: 'dashboard', title: '仪表盘' })
    return { tabs: [tab], activeTabId: tab.tabId }
  }
  const restored = parseStoredTabs(localStorage.getItem(STORAGE_KEY))
  if (restored === null) {
    const tab = createWorkspaceTab({ route: 'dashboard', title: '仪表盘' })
    return { tabs: [tab], activeTabId: tab.tabId }
  }
  let activeTabId: string | null = null
  try {
    activeTabId = localStorage.getItem(ACTIVE_KEY)
  } catch {
    activeTabId = null
  }
  return { tabs: restored, activeTabId: fallbackActive(restored, activeTabId) }
}

export function persistWorkspaceTabs(state: WorkspaceTabsState): void {
  if (typeof localStorage === 'undefined') return
  try {
    const value = WorkspaceTabStateSchema.parse({ version: 1, tabs: state.tabs })
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value))
    if (state.activeTabId) localStorage.setItem(ACTIVE_KEY, state.activeTabId)
    else localStorage.removeItem(ACTIVE_KEY)
  } catch {
    // A storage quota/private-mode failure must not make the renderer unusable.
  }
}

export function validateWorkspaceTab(tab: WorkspaceTab, index: WorkspaceTabValidationIndex = {}): boolean {
  if (!WorkspaceTabSchema.safeParse(tab).success) return false
  if (tab.context.projectId && index.projectIds && !index.projectIds.has(tab.context.projectId)) return false
  const resource = tab.context.resource
  if (resource) {
    if (resource.kind === 'project' && index.projectIds && !index.projectIds.has(resource.id)) return false
    const known = index.resources?.[resource.kind]
    if (known && !known.has(resource.id)) return false
  }
  return true
}

export function useWorkspaceTabs(validationIndex: WorkspaceTabValidationIndex = EMPTY_VALIDATION_INDEX) {
  const [state, setState] = useState<WorkspaceTabsState>(loadWorkspaceTabs)
  const dispatch = useCallback((action: WorkspaceTabsAction) => setState((current) => workspaceTabsReducer(current, action)), [])
  useEffect(() => {
    setState((current) => workspaceTabsReducer(current, { type: 'clean', validate: (tab) => validateWorkspaceTab(tab, validationIndex) }))
  }, [validationIndex])
  useEffect(() => persistWorkspaceTabs(state), [state])
  const activeTab = useMemo(() => state.tabs.find((tab) => tab.tabId === state.activeTabId) ?? null, [state.activeTabId, state.tabs])

  const openTab = useCallback((input: Parameters<typeof createWorkspaceTab>[0], newTab = false) => {
    const tab = createWorkspaceTab(input)
    if (!newTab && state.activeTabId) {
      dispatch({ type: 'update-current', patch: { route: tab.route, context: tab.context, title: tab.title } })
      return state.activeTabId
    }
    dispatch({ type: 'open', tab, activate: true })
    return tab.tabId
  }, [dispatch, state.activeTabId])
  const duplicateTab = useCallback((tabId: string) => {
    const tab = state.tabs.find((entry) => entry.tabId === tabId)
    if (!tab) return null
    const duplicate = createWorkspaceTab({ route: tab.route, context: tab.context, pinned: tab.pinned, createdAt: nowIso(), title: `${tab.title}（副本）` })
    dispatch({ type: 'duplicate', tabId, tab: duplicate })
    return duplicate.tabId
  }, [dispatch, state.tabs])

  return {
    state,
    tabs: state.tabs,
    activeTab,
    dispatch,
    selectTab: (tabId: string) => dispatch({ type: 'select', tabId }),
    updateCurrent: (patch: Partial<Pick<WorkspaceTab, 'route' | 'context' | 'title'>>) => dispatch({ type: 'update-current', patch }),
    updateContext: (tabId: string, context: WorkspaceTab['context']) => dispatch({ type: 'update-context', tabId, context }),
    openTab,
    duplicateTab,
    close: (tabId: string) => dispatch({ type: 'close', tabId }),
    closeCurrent: () => dispatch({ type: 'close-current' }),
    closeOthers: (tabId: string) => dispatch({ type: 'close-others', tabId }),
    closeRight: (tabId: string) => dispatch({ type: 'close-right', tabId }),
    closeAll: () => dispatch({ type: 'close-all' }),
    togglePin: (tabId: string) => dispatch({ type: 'pin', tabId })
  }
}

export type WorkspaceTabAction = 'close-current' | 'close-others' | 'close-right' | 'close-all' | 'pin' | 'duplicate' | 'open-new-tab'
export type { ResourceRef }
