import { cp, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const LEGACY_ENTRIES = ['data', 'config'] as const
const MARKER = 'legacy-data-migration-v1.json'

export type DataMigrationResult = {
  readonly migrated: boolean
  readonly skipped: boolean
  readonly reason?: string
}

/**
 * Move the old beside-the-executable data roots into the per-user AppData
 * root without deleting the source.  Existing destination entries always win
 * so an interrupted migration or an upgrade can never overwrite newer data.
 */
export async function migrateLegacyUserData(legacyRoot: string, targetRoot: string): Promise<DataMigrationResult> {
  if (legacyRoot === targetRoot) return { migrated: false, skipped: true, reason: 'same-root' }
  const sources: string[] = []
  for (const entry of LEGACY_ENTRIES) {
    const source = join(legacyRoot, entry)
    try {
      const details = await stat(source)
      if (details.isDirectory()) sources.push(entry)
    } catch {
      // Missing legacy roots are expected on a fresh install.
    }
  }
  if (sources.length === 0) return { migrated: false, skipped: true, reason: 'no-legacy-data' }

  await mkdir(targetRoot, { recursive: true })
  const staging = join(targetRoot, `.migration-${Date.now()}-${process.pid}`)
  try {
    await mkdir(staging, { recursive: true })
    for (const entry of sources) {
      await cp(join(legacyRoot, entry), join(staging, entry), { recursive: true, errorOnExist: false, force: true })
    }

    let migrated = false
    for (const entry of sources) {
      const destination = join(targetRoot, entry)
      try {
        await stat(destination)
        // Preserve an existing destination, including data left by a prior
        // successful or partially completed migration.
        continue
      } catch {
        await rename(join(staging, entry), destination)
        migrated = true
      }
    }
    if (migrated) {
      const configRoot = join(targetRoot, 'config')
      await mkdir(configRoot, { recursive: true })
      await writeFile(join(configRoot, MARKER), JSON.stringify({ version: 1, migratedAt: new Date().toISOString() }) + '\n', 'utf8')
    }
    return migrated
      ? { migrated: true, skipped: false }
      : { migrated: false, skipped: true, reason: 'destination-exists' }
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

/** Return a bounded list of entries useful for startup diagnostics/tests. */
export async function listMigrationEntries(root: string): Promise<string[]> {
  try {
    return (await readdir(root)).slice(0, 100)
  } catch {
    return []
  }
}
