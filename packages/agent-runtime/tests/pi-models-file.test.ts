import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { piModelsFilePath, readPiModelsFile, writePiModelsFile, type PiModelsFileError } from '../src/index.js'
import type { AgentCustomProvider } from '@prw/contracts'

const roots: string[] = []

function temporaryProfile(): string {
  const root = mkdtempSync(join(tmpdir(), 'prw-models-file-'))
  roots.push(root)
  const profileDir = join(root, 'pi')
  // The writer creates the directory, but hand-edit fixtures do not go through
  // the writer, so the profile is materialized up front.
  mkdirSync(profileDir, { recursive: true })
  return profileDir
}

function provider(overrides: Partial<AgentCustomProvider> = {}): AgentCustomProvider {
  return {
    id: 'my-gateway',
    name: 'My Gateway',
    baseUrl: 'https://gateway.example.com/v1',
    api: 'openai-responses',
    models: [{ id: 'gpt-5.1', name: '', reasoning: true, contextWindow: 400000, maxTokens: null }],
    ...overrides
  }
}

function readDocument(profileDir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(piModelsFilePath(profileDir), 'utf8')) as Record<string, unknown>
}

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

describe('models.json file access', () => {
  it('reports a missing file as an empty configuration instead of an error', () => {
    const profileDir = temporaryProfile()
    const snapshot = readPiModelsFile(profileDir)
    assert.equal(snapshot.path, join(profileDir, 'models.json'))
    assert.deepEqual(snapshot.providers, [])
    assert.deepEqual(snapshot.unmanaged, [])
    assert.equal(snapshot.error, null)
  })

  it('creates the profile directory and round-trips a provider', () => {
    const profileDir = temporaryProfile()
    const saved = writePiModelsFile(profileDir, [provider()])
    assert.equal(saved.error, null)
    assert.deepEqual(saved.providers, [provider()])
    // Optional empty values are omitted rather than written as "" so the entry
    // keeps satisfying Pi's own minLength(1) schema.
    assert.deepEqual(readDocument(profileDir), {
      providers: {
        'my-gateway': {
          name: 'My Gateway',
          baseUrl: 'https://gateway.example.com/v1',
          api: 'openai-responses',
          models: [{ id: 'gpt-5.1', reasoning: true, contextWindow: 400000 }]
        }
      }
    })
  })

  it('preserves hand-written fields, other top-level keys and unmanaged entries', () => {
    const profileDir = temporaryProfile()
    writePiModelsFile(profileDir, [provider()])
    const document = readDocument(profileDir)
    writeFileSync(piModelsFilePath(profileDir), `${JSON.stringify({
      ...document,
      $comment: 'hand edit',
      providers: {
        // Header-carrying entry: not representable in the editor, so it stays.
        'corp-proxy': { baseUrl: 'https://proxy.example.com/v1', api: 'openai-completions', headers: { 'x-org': 'lab' }, models: [{ id: 'internal' }] },
        // Plain-HTTP LAN endpoint: refused by the app's URL policy on purpose.
        'lab-box': { baseUrl: 'http://192.168.1.9:8000/v1', api: 'openai-completions', models: [{ id: 'local' }] },
        'my-gateway': document.providers && (document.providers as Record<string, unknown>)['my-gateway']
      }
    }, null, 2)}\n`, 'utf8')

    const before = readPiModelsFile(profileDir)
    assert.deepEqual(before.unmanaged.sort(), ['corp-proxy', 'lab-box'])
    assert.deepEqual(before.providers.map((entry) => entry.id), ['my-gateway'])

    // Removing the managed provider must delete it and leave the other two
    // byte-identical, including the fields the editor cannot represent.
    const after = writePiModelsFile(profileDir, [])
    assert.deepEqual(after.providers, [])
    assert.deepEqual(after.unmanaged.sort(), ['corp-proxy', 'lab-box'])
    const rewritten = readDocument(profileDir)
    assert.equal(rewritten.$comment, 'hand edit')
    const providers = rewritten.providers as Record<string, unknown>
    assert.deepEqual(Object.keys(providers), ['corp-proxy', 'lab-box'])
    assert.deepEqual(providers['corp-proxy'], { baseUrl: 'https://proxy.example.com/v1', api: 'openai-completions', headers: { 'x-org': 'lab' }, models: [{ id: 'internal' }] })
  })

  it('refuses to overwrite a file it cannot parse', () => {
    const profileDir = temporaryProfile()
    writePiModelsFile(profileDir, [provider()])
    writeFileSync(piModelsFilePath(profileDir), '{ "providers": {', 'utf8')

    const snapshot = readPiModelsFile(profileDir)
    assert.match(snapshot.error ?? '', /无法解析/u)
    assert.throws(() => writePiModelsFile(profileDir, [provider()]), (error: PiModelsFileError) => {
      assert.equal(error.name, 'VALIDATION_FAILED')
      assert.match(error.message, /不是有效的 JSON/u)
      return true
    })
    // The broken content is still there: nothing was replaced.
    assert.equal(readFileSync(piModelsFilePath(profileDir), 'utf8'), '{ "providers": {')
  })

  it('tolerates comments the way Pi does, including URLs inside strings', () => {
    const profileDir = temporaryProfile()
    writeFileSync(piModelsFilePath(profileDir), `{
  // a line comment
  "providers": {
    /* block comment */
    "commented": {
      "baseUrl": "https://host.example.com/v1", // trailing comment
      "api": "openai-completions",
      "models": [{ "id": "a//b" }]
    }
  }
}\n`, 'utf8')
    const snapshot = readPiModelsFile(profileDir)
    assert.equal(snapshot.error, null)
    assert.deepEqual(snapshot.providers.map((entry) => entry.id), ['commented'])
    assert.deepEqual(snapshot.providers[0]?.models.map((model) => model.id), ['a//b'])
  })

  it('rejects a provider list that would make Pi discard the whole file', () => {
    const profileDir = temporaryProfile()
    assert.throws(() => writePiModelsFile(profileDir, [provider({ baseUrl: 'https://user:secret@host.example.com/v1' })]), /不能包含用户名或密码/u)
    assert.throws(() => writePiModelsFile(profileDir, [provider({ baseUrl: 'http://remote.example.com/v1' })]), /必须使用 HTTPS/u)
    assert.throws(() => writePiModelsFile(profileDir, [provider({ id: 'Bad Id' })]), /Provider id/u)
  })

  it('marks entries with a shape this app cannot edit as unmanaged', () => {
    const profileDir = temporaryProfile()
    writeFileSync(piModelsFilePath(profileDir), `${JSON.stringify({
      providers: {
        // Model-level api override is a supported Pi field but not one the
        // editor writes, so the entry must not be silently flattened.
        'mixed': { baseUrl: 'https://mixed.example.com/v1', models: [{ id: 'm', api: 'openai-completions' }] },
        'unknown-api': { baseUrl: 'https://other.example.com/v1', api: 'made-up-api', models: [{ id: 'm' }] },
        'no-url': { api: 'openai-completions', models: [{ id: 'm' }] },
        'plain': { baseUrl: 'https://plain.example.com/v1', api: 'anthropic-messages', models: [{ id: 'claude' }] }
      }
    }, null, 2)}\n`, 'utf8')
    const snapshot = readPiModelsFile(profileDir)
    assert.deepEqual(snapshot.providers.map((entry) => entry.id), ['plain'])
    assert.deepEqual(snapshot.unmanaged.sort(), ['mixed', 'no-url', 'unknown-api'])
  })
})
