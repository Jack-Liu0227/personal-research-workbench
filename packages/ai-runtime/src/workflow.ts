import type {
  AgentWorkflowKey,
  AiProviderProfile,
  Paper,
  PromptTemplate,
  StartAgentRunInput
} from '@prw/contracts'
import { renderPrompt } from './prompt.js'
import { generateWithProvider, type GenerationResult } from './provider.js'

export interface WorkflowRuntimeContext {
  readonly provider: AiProviderProfile
  readonly prompt: PromptTemplate
  readonly papers: Paper[]
  readonly credential?: string | undefined
  readonly fetcher?: typeof fetch | undefined
  readonly signal?: AbortSignal | undefined
}

export const artifactKindForWorkflow: Record<AgentWorkflowKey, 'daily_digest' | 'paper_summary' | 'literature_review' | 'research_idea' | 'research_plan' | 'outline' | 'manuscript'> = {
  daily_digest: 'daily_digest',
  paper_summary: 'paper_summary',
  literature_matrix: 'paper_summary',
  literature_review: 'literature_review',
  research_ideation: 'research_idea',
  research_plan: 'research_plan',
  manuscript_draft: 'manuscript',
  // 消息侧推送的 SQLite 投影沿用 daily_digest 类别（content 自带投递状态说明），
  // 不新增 Artifact 类别，避免再触发 research_artifacts.kind CHECK 重建。
  literature_daily_msg: 'daily_digest'
}

export async function runWorkflow(input: StartAgentRunInput, context: WorkflowRuntimeContext): Promise<GenerationResult> {
  const paperContext = context.papers.map((paper, index) => [
    `[P${index + 1}] ${paper.title}`,
    paper.authors.length > 0 ? `Authors: ${paper.authors.join(', ')}` : '',
    paper.doi ? `DOI: ${paper.doi}` : '',
    paper.abstract ? `Abstract: ${paper.abstract}` : 'Evidence level: metadata only'
  ].filter(Boolean).join('\n')).join('\n\n')
  const variables: Record<string, string> = {
    ...input.variables,
    instructions: input.instructions,
    papers: paperContext,
    paper: input.variables['paper'] ?? paperContext,
    matrix: input.variables['matrix'] ?? paperContext,
    evidence: input.variables['evidence'] ?? paperContext,
    context: input.variables['context'] ?? input.instructions,
    constraints: input.variables['constraints'] ?? input.instructions,
    idea: input.variables['idea'] ?? input.instructions,
    outline: input.variables['outline'] ?? input.instructions,
    draft: input.variables['draft'] ?? input.instructions,
    goal: input.variables['goal'] ?? input.instructions,
    topic: input.variables['topic'] ?? input.instructions
  }
  const expected = new Set([...context.prompt.userTemplate.matchAll(/{{\s*([a-zA-Z][a-zA-Z0-9_.-]*)\s*}}/g)].map((match) => match[1]).filter((value): value is string => Boolean(value)))
  const scopedVariables = Object.fromEntries([...expected].map((key) => [key, variables[key] ?? '']))
  const userPrompt = renderPrompt(context.prompt.userTemplate, scopedVariables)
  return generateWithProvider({
    profile: context.provider,
    credential: context.credential,
    fetcher: context.fetcher
  }, {
    workflowKey: input.workflowKey,
    systemPrompt: context.prompt.systemPrompt,
    userPrompt,
    papers: context.papers,
    webSearch: input.workflowKey === 'daily_digest'
      && context.provider.api === 'openai-responses'
      && ['openai', 'xai'].includes(context.provider.provider)
  }, context.signal)
}
