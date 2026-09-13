import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

/**
 * "Which project does a new flow start in?"
 *
 * Literature search/staging, Zotero import/export and the Agent composer all
 * accept an explicit project. Remembering the most recently used project
 * removes the repeated pick-my-project step, while an explicit `未分类`
 * (unbound) choice stays reachable so binding a record to no project remains a
 * deliberate decision instead of an accident of the default.
 */
export const RECENT_PROJECT_STORAGE_KEY = 'workbench-recent-project:v1'

/** Renderer-only preference; never a source of truth for stored records. */
export function readRecentProjectId(): string | null {
  try {
    const stored = localStorage.getItem(RECENT_PROJECT_STORAGE_KEY)
    return stored && stored.trim() ? stored : null
  } catch {
    return null
  }
}

/** Remember (or clear) the project a flow should default to next time. */
export function rememberProjectId(id: string | null): void {
  try {
    if (id) localStorage.setItem(RECENT_PROJECT_STORAGE_KEY, id)
    else localStorage.removeItem(RECENT_PROJECT_STORAGE_KEY)
  } catch {
    /* optional renderer storage */
  }
}

/**
 * The remembered project, but only while it still exists in the list the page
 * can actually see. An archived or deleted project must not be pre-selected:
 * defaulting to it would make the first save fail with an unknown id.
 */
export function resolveRecentProjectId(projects: readonly { id: string }[]): string | null {
  const stored = readRecentProjectId()
  if (!stored) return null
  return projects.some((project) => project.id === stored) ? stored : null
}

export interface DefaultProjectId {
  readonly projectId: string
  /** Explicit user choice: applied now and remembered as the default. */
  readonly chooseProjectId: (id: string) => void
  /** Programmatic value (for example opening an existing conversation): applied without changing the remembered default. */
  readonly setProjectId: (id: string) => void
}

/**
 * Controlled project id for a flow that starts on the most recently used
 * project.
 *
 * The remembered default is only applied while the user has not chosen a value
 * in this flow, so an explicit `未分类` is never overwritten when the project
 * list arrives after the first render.
 */
export function useDefaultProjectId(projects: readonly { id: string }[]): DefaultProjectId {
  const recentProjectId = useMemo(() => resolveRecentProjectId(projects), [projects])
  const [projectId, setProjectIdState] = useState('')
  const explicitChoice = useRef(false)
  useEffect(() => {
    if (explicitChoice.current) return
    if (recentProjectId === null) return
    setProjectIdState((current) => (current === '' ? recentProjectId : current))
  }, [recentProjectId])
  const chooseProjectId = useCallback((id: string) => {
    explicitChoice.current = true
    setProjectIdState(id)
    // Choosing 未分类 in a flow-start control is itself a decision: the next
    // flow should start unbound as well rather than resurrecting an old project.
    rememberProjectId(id || null)
  }, [])
  return { chooseProjectId, projectId, setProjectId: setProjectIdState }
}
