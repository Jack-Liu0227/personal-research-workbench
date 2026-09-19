import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { controlledPiResourcePaths } from '../src/index.js'

const normalize = (path: string): string => path.split(String.fromCharCode(92)).join('/')

describe('controlled Pi resource roots', () => {
  it('uses only the checkout-owned skill and extension roots in development', () => {
    const result = controlledPiResourcePaths({
      projectRoot: 'C:/workbench',
      packagedApp: false,
      exists: (path) => normalize(path).endsWith('/.agents/skills') || normalize(path).endsWith('/.pi/extensions')
    })
    assert.deepEqual({ skillPaths: result.skillPaths.map(normalize), extensionPaths: result.extensionPaths.map(normalize) }, {
      skillPaths: ['C:/workbench/.agents/skills'],
      extensionPaths: ['C:/workbench/.pi/extensions']
    })
  })

  it('uses only the packaged resources mirror when packaged', () => {
    const result = controlledPiResourcePaths({
      projectRoot: 'C:/checkout',
      packagedApp: true,
      resourcesPath: 'C:/Program Files/Research Workbench/resources',
      exists: (path) => normalize(path).endsWith('/skills')
    })
    assert.deepEqual({ skillPaths: result.skillPaths.map(normalize), extensionPaths: result.extensionPaths.map(normalize) }, {
      skillPaths: ['C:/Program Files/Research Workbench/resources/skills'],
      extensionPaths: []
    })
  })

  it('does not invent a fallback path when no app-owned anchor exists', () => {
    const result = controlledPiResourcePaths({ projectRoot: '', packagedApp: false })
    assert.deepEqual(result, { skillPaths: [], extensionPaths: [] })
  })
})
