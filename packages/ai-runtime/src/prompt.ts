const variablePattern = /{{\s*([a-zA-Z][a-zA-Z0-9_.-]*)\s*}}/g

export class PromptRenderError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PromptRenderError'
  }
}

export function promptVariables(template: string): string[] {
  return [...new Set([...template.matchAll(variablePattern)].map((match) => match[1]).filter((value): value is string => Boolean(value)))]
}

export function renderPrompt(template: string, variables: Readonly<Record<string, string>>): string {
  const required = promptVariables(template)
  const missing = required.filter((key) => variables[key] === undefined)
  if (missing.length > 0) throw new PromptRenderError(`Prompt 缺少变量：${missing.join(', ')}`)
  const unknown = Object.keys(variables).filter((key) => !required.includes(key))
  if (unknown.length > 0) throw new PromptRenderError(`Prompt 包含未知变量：${unknown.join(', ')}`)
  return template.replace(variablePattern, (_match, key: string) => variables[key] ?? '')
}
