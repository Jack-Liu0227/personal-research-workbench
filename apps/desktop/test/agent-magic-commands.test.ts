import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { filterAgentMagicSuggestions, parseAgentMagicCommand } from '../src/renderer/src/features/agent/magic-commands.ts'

describe('Agent magic commands', () => {
  it('parses quoted URLs and provider/model selectors without accepting secrets', () => {
    assert.deepEqual(parseAgentMagicCommand('/provider add lab openai-responses "http://127.0.0.1:9000/v1"'), {
      kind: 'provider-add', id: 'lab', api: 'openai-responses', baseUrl: 'http://127.0.0.1:9000/v1'
    })
    assert.deepEqual(parseAgentMagicCommand('/model use lab/gpt-5.1'), { kind: 'model-use', selector: 'lab/gpt-5.1' })
    assert.deepEqual(parseAgentMagicCommand('/key lab'), { kind: 'key', provider: 'lab' })
  })

  it('rejects a key argument and leaves unknown natural language untouched', () => {
    assert.equal('error' in (parseAgentMagicCommand('/key lab secret-value') ?? {}), true)
    assert.equal(parseAgentMagicCommand('请帮我安排明天的任务'), null)
  })

  it('completes only slash-prefixed text and keeps a fully typed command selectable', () => {
    assert.deepEqual(filterAgentMagicSuggestions(''), [])
    assert.deepEqual(filterAgentMagicSuggestions('帮我安排任务'), [])
    // A partial word narrows the list, and the full command stays in it: that is
    // the form Enter accepts when the user typed it out themselves.
    const partial = filterAgentMagicSuggestions('/mo').map((suggestion) => suggestion.command)
    assert.deepEqual([...partial], ['/model list', '/model use '])
    const exact = filterAgentMagicSuggestions('/help').map((suggestion) => suggestion.command)
    assert.deepEqual([...exact], ['/help'])
    // A command that still needs an argument advertises it by trailing space.
    const key = filterAgentMagicSuggestions('/key ')[0]
    assert.equal(key?.command, '/key ')
    assert.equal(key?.command.endsWith(' '), true)
  })
})
