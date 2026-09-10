import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { safeStorage } from 'electron'

interface StoredSecrets {
  readonly version: 1
  readonly entries: Readonly<Record<string, string>>
}

export interface SecretCryptography {
  isAvailable(): boolean
  encrypt(value: string): Buffer
  decrypt(value: Buffer): string
}

export type CredentialKind = 'integration' | 'provider' | 'engine'

export type CredentialVaultErrorCode =
  | 'CREDENTIAL_DECRYPTION_FAILED'
  | 'CREDENTIAL_STORAGE_CORRUPT'
  | 'CREDENTIAL_STORAGE_UNAVAILABLE'

export class CredentialVaultError extends Error {
  readonly code: CredentialVaultErrorCode

  constructor(code: CredentialVaultErrorCode, message: string) {
    super(message)
    this.name = 'CredentialVaultError'
    this.code = code
  }
}

export function credentialKey(kind: CredentialKind, id: string): string {
  if (!id || /[\r\n\0]/.test(id)) {
    throw new CredentialVaultError('CREDENTIAL_STORAGE_CORRUPT', 'Credential identifier is invalid.')
  }
  return `v2:${kind}:${id}`
}

export function electronSecretCryptography(): SecretCryptography {
  return {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: (value) => safeStorage.encryptString(value),
    decrypt: (value) => safeStorage.decryptString(value)
  }
}

export class CredentialVault {
  private queue: Promise<void> = Promise.resolve()

  constructor(
    private readonly filePath: string,
    private readonly cryptography: SecretCryptography
  ) {}

  has(key: string): Promise<boolean> {
    return this.exclusive(async () => {
      const store = await this.readStore()
      return Object.hasOwn(store.entries, key)
    })
  }

  get(key: string): Promise<string | null> {
    return this.exclusive(async () => {
      const store = await this.readStore()
      const encrypted = store.entries[key]
      if (encrypted === undefined) return null
      this.requireEncryption()
      try {
        return this.cryptography.decrypt(Buffer.from(encrypted, 'base64'))
      } catch {
        throw new CredentialVaultError(
          'CREDENTIAL_DECRYPTION_FAILED',
          'The stored credential could not be decrypted for this Windows user.'
        )
      }
    })
  }

  set(key: string, secret: string): Promise<void> {
    return this.exclusive(async () => {
      this.requireEncryption()
      const store = await this.readStore()
      const entries = { ...store.entries }
      entries[key] = this.cryptography.encrypt(secret).toString('base64')
      await this.writeStore({ version: 1, entries })
    })
  }

  remove(key: string): Promise<void> {
    return this.exclusive(async () => {
      const store = await this.readStore()
      if (!Object.hasOwn(store.entries, key)) return
      const entries = { ...store.entries }
      delete entries[key]
      await this.writeStore({ version: 1, entries })
    })
  }

  private requireEncryption(): void {
    if (!this.cryptography.isAvailable()) {
      throw new CredentialVaultError(
        'CREDENTIAL_STORAGE_UNAVAILABLE',
        'Secure credential storage is unavailable for the current Windows session.'
      )
    }
  }

  private async readStore(): Promise<StoredSecrets> {
    let raw: string
    try {
      raw = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: 1, entries: {} }
      }
      throw error
    }

    try {
      const parsed: unknown = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object') throw new Error('not an object')
      const value = parsed as Record<string, unknown>
      if (value['version'] !== 1 || !value['entries'] || typeof value['entries'] !== 'object') {
        throw new Error('unsupported format')
      }
      const entries: Record<string, string> = {}
      for (const [key, encrypted] of Object.entries(value['entries'])) {
        if (typeof encrypted !== 'string' || !/^v2:(integration|provider|engine):/.test(key)) {
          throw new Error('invalid entry')
        }
        entries[key] = encrypted
      }
      return { version: 1, entries }
    } catch {
      throw new CredentialVaultError(
        'CREDENTIAL_STORAGE_CORRUPT',
        'The encrypted credential store is not readable. It was left unchanged.'
      )
    }
  }

  private async writeStore(store: StoredSecrets): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    const temporaryPath = `${this.filePath}.${process.pid}-${randomUUID()}.tmp`
    try {
      await writeFile(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600
      })
      await rename(temporaryPath, this.filePath)
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined)
      throw error
    }
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation)
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }
}
