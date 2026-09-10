export * from './types.js'
export {
  listObsidianNotes,
  assertObsidianVault,
  createObsidianLayoutFileSystem,
  inspectObsidianPaths,
  pullObsidian,
  probeObsidian,
  readObsidianNote,
  deleteObsidianNote,
  deleteObsidianFolder,
  snapshotObsidianRoot,
  upsertManagedBlock,
  writeObsidianNote,
  writeObsidianProjection
} from './obsidian.js'
export type { ObsidianNote } from './obsidian.js'
export { authorizeZotero, createZoteroProjection, exportZoteroBibtex, listZoteroCollections, pullZotero, probeZotero, writeZoteroProjection } from './zotero.js'
export type { ZoteroBibtexExport, ZoteroCollectionPage, ZoteroCollectionSummary } from './zotero.js'
export { pullNotion, probeNotion, writeNotionProjection } from './notion.js'

import type { AdapterProfile, AdapterProbe, AdapterPullResult } from './types.js'
import { pullObsidian, probeObsidian } from './obsidian.js'
import { pullZotero, probeZotero } from './zotero.js'
import { pullNotion, probeNotion } from './notion.js'

export function probeIntegration(profile: AdapterProfile): Promise<AdapterProbe> {
  switch (profile.provider) {
    case 'obsidian': return probeObsidian(profile)
    case 'zotero': return probeZotero(profile)
    case 'notion': return probeNotion(profile)
  }
}

export function pullIntegration(profile: AdapterProfile): Promise<AdapterPullResult> {
  switch (profile.provider) {
    case 'obsidian': return pullObsidian(profile)
    case 'zotero': return pullZotero(profile)
    case 'notion': return pullNotion(profile)
  }
}
