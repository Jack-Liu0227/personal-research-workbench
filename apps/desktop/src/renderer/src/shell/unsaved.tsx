import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { WorkspaceTab } from '@prw/contracts'

export interface UnsavedObsidianGuard {
  isDirty: () => boolean
  save: () => void | Promise<void | boolean>
  discard: () => void
}

interface PendingPrompt {
  tab: WorkspaceTab
  resolve: (approved: boolean) => void
}

interface UnsavedContextValue {
  register: (tabId: string, guard: UnsavedObsidianGuard) => void
  unregister: (tabId: string) => void
  confirmClose: (tabs: WorkspaceTab[]) => Promise<boolean>
}

const UnsavedContext = createContext<UnsavedContextValue | null>(null)

export function UnsavedObsidianProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const guards = useRef(new Map<string, UnsavedObsidianGuard>())
  const [pending, setPending] = useState<PendingPrompt | null>(null)

  const register = useCallback((tabId: string, guard: UnsavedObsidianGuard) => {
    guards.current.set(tabId, guard)
  }, [])
  const unregister = useCallback((tabId: string) => {
    guards.current.delete(tabId)
  }, [])
  const prompt = useCallback((tab: WorkspaceTab): Promise<boolean> => new Promise((resolve) => {
    setPending({ tab, resolve })
  }), [])
  const confirmClose = useCallback(async (tabs: WorkspaceTab[]): Promise<boolean> => {
    for (const tab of tabs) {
      const guard = guards.current.get(tab.tabId)
      if (!guard?.isDirty()) continue
      const approved = await prompt(tab)
      if (!approved) return false
    }
    return true
  }, [prompt])

  const resolvePrompt = useCallback((approved: boolean) => {
    const current = pending
    if (!current) return
    setPending(null)
    current.resolve(approved)
  }, [pending])
  const saveAndClose = useCallback(async () => {
    const current = pending
    if (!current) return
    const guard = guards.current.get(current.tab.tabId)
    if (!guard) {
      resolvePrompt(true)
      return
    }
    try {
      const saved = await guard.save()
      resolvePrompt(saved !== false)
    } catch {
      // A save failure keeps the note open; the feature can show its typed error.
      resolvePrompt(false)
    }
  }, [pending, resolvePrompt])

  const value = useMemo(() => ({ register, unregister, confirmClose }), [confirmClose, register, unregister])
  return <UnsavedContext.Provider value={value}>
    {children}
    {pending ? <div aria-label="未保存更改" className="fixed inset-0 z-[110] grid place-items-center bg-scrim p-4" role="presentation">
      <section aria-describedby="unsaved-description" aria-labelledby="unsaved-title" className="w-[min(92vw,28rem)] rounded-lg border border-border bg-surface p-5 shadow-xl" role="dialog">
        <h2 className="text-base font-bold text-foreground" id="unsaved-title">笔记尚未保存</h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground" id="unsaved-description">关闭“{pending.tab.title}”前请选择保存、放弃或取消。取消会保留当前编辑内容。</p>
        <div className="mt-5 flex justify-end gap-2">
          <button className="inline-flex h-9 items-center justify-center rounded-md border border-border px-3 text-sm font-semibold text-foreground hover:bg-muted" onClick={() => resolvePrompt(false)} type="button">取消</button>
          <button className="inline-flex h-9 items-center justify-center rounded-md border border-danger/30 bg-danger-subtle px-3 text-sm font-semibold text-danger hover:bg-danger-subtle/75" onClick={() => { guards.current.get(pending.tab.tabId)?.discard(); resolvePrompt(true) }} type="button">放弃更改</button>
          <button autoFocus className="inline-flex h-9 items-center justify-center rounded-md border border-primary bg-primary px-3 text-sm font-semibold text-primary-foreground hover:bg-primary-strong" onClick={() => void saveAndClose()} type="button">保存并关闭</button>
        </div>
      </section>
    </div> : null}
  </UnsavedContext.Provider>
}

export function useUnsavedObsidian(tabId: string | null, guard: UnsavedObsidianGuard | null): void {
  const context = useContext(UnsavedContext)
  useEffect(() => {
    if (!context || !tabId || !guard) return
    context.register(tabId, guard)
    return () => context.unregister(tabId)
  }, [context, guard, tabId])
}

export function useUnsavedCloseConfirmation(): (tabs: WorkspaceTab[]) => Promise<boolean> {
  const context = useContext(UnsavedContext)
  if (!context) throw new Error('useUnsavedCloseConfirmation 必须位于 UnsavedObsidianProvider 内。')
  return context.confirmClose
}
