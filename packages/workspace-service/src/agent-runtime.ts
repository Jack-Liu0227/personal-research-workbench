import {
  artifactKindForWorkflow,
  previewSchedule,
  PromptRenderError,
  ProviderRuntimeError,
  runWorkflow,
  type GenerationResult
} from '@prw/ai-runtime'
import type {
  AgentRun,
  AiProviderProfile,
  PromptTemplate,
  SaveScheduleInput,
  Schedule,
  StartAgentRunInput
} from '@prw/contracts'
import { ProjectIdSchema } from '@prw/contracts'
import type { WorkbenchRepository } from '@prw/database'

export class AgentCoordinator {
  private readonly controllers = new Map<string, AbortController>()
  private disposed = false

  constructor(
    private readonly repository: WorkbenchRepository,
    private readonly now: () => Date = () => new Date()
  ) {}

  start(input: StartAgentRunInput, secret: string | null): AgentRun {
    if (this.disposed) throw new Error('Agent runtime is shutting down.')
    const prompt = this.repository.getPromptTemplate(input.promptTemplateId)
    const provider = input.providerProfileId === null
      ? mockProvider(this.now())
      : this.repository.getAiProviderProfile(input.providerProfileId)
    const papers = this.repository.getPapersByIds(input.paperIds)
    if (papers.length !== input.paperIds.length) {
      throw new Error('One or more selected papers no longer exist.')
    }

    const queued = this.repository.createAgentRun(input)
    const running = this.repository.updateAgentRun({ id: queued.id, status: 'running' })
    const controller = new AbortController()
    this.controllers.set(running.id, controller)
    void this.execute(running, input, prompt, provider, papers, secret, controller)
    return running
  }

  cancel(id: string): void {
    this.controllers.get(id)?.abort()
    this.controllers.delete(id)
    this.repository.cancelAgentRun(id)
  }

  saveSchedule(input: SaveScheduleInput): Schedule {
    const preview = previewSchedule(input.cron, input.timezone, 1, this.now())
    const stored = this.repository.saveSchedule(input)
    const nextRunAt = input.enabled
      ? preview.nextRunAt
      : null
    return this.repository.updateScheduleTiming({
      id: stored.id,
      nextRunAt,
      expectedRevision: stored.revision
    })
  }

  runSchedule(id: string, secret: string | null): AgentRun {
    const schedule = this.repository.getSchedule(id)
    // Resolve all durable dependencies before consuming this cron occurrence.
    this.repository.getPromptTemplate(schedule.promptTemplateId)
    if (schedule.providerProfileId !== null) {
      this.repository.getAiProviderProfile(schedule.providerProfileId)
    }
    const paperIds = this.scheduledPaperIds(schedule.projectId)
    const timestamp = this.now().toISOString()
    const nextRunAt = schedule.enabled
      ? previewSchedule(schedule.cron, schedule.timezone, 1, this.now()).nextRunAt
      : null
    this.repository.markScheduleRun(schedule.id, schedule.revision, nextRunAt, timestamp)
    return this.start({
      workflowKey: schedule.workflowKey,
      providerProfileId: schedule.providerProfileId,
      promptTemplateId: schedule.promptTemplateId,
      projectId: schedule.projectId,
      paperIds,
      variables: { topic: schedule.name },
      instructions: `Scheduled run: ${schedule.name}`
    }, secret)
  }

  private scheduledPaperIds(projectId: string | null): string[] {
    if (projectId !== null) {
      const scopedProjectId = ProjectIdSchema.parse(projectId)
      return this.repository.listPapers({ projectId: scopedProjectId }).slice(0, 8).map((paper) => paper.id)
    }

    const queued = this.repository.listPapers({ status: 'queued' })
    const remaining = Math.max(0, 8 - queued.length)
    const inbox = remaining === 0
      ? []
      : this.repository.listPapers({ status: 'inbox' }).slice(0, remaining)
    return [...queued.slice(0, 8), ...inbox].map((paper) => paper.id)
  }

  dispose(): void {
    this.disposed = true
    for (const [id, controller] of this.controllers) {
      controller.abort()
      this.repository.cancelAgentRun(id)
    }
    this.controllers.clear()
  }

  private async execute(
    run: AgentRun,
    input: StartAgentRunInput,
    prompt: PromptTemplate,
    provider: AiProviderProfile,
    papers: ReturnType<WorkbenchRepository['getPapersByIds']>,
    secret: string | null,
    controller: AbortController
  ): Promise<void> {
    try {
      if (!provider.enabled) {
        throw new ProviderRuntimeError('PROVIDER_ERROR', 'The selected provider is disabled.')
      }
      const result = await runWorkflow(input, {
        provider,
        prompt,
        papers,
        ...(secret === null ? {} : { credential: secret }),
        signal: controller.signal
      })
      if (controller.signal.aborted || this.disposed) {
        if (!this.disposed) this.repository.cancelAgentRun(run.id)
        return
      }
      this.createArtifact(input, prompt, result)
      this.repository.completeAgentRun(run.id, {
        output: result.text,
        citations: result.citations,
        error: null
      })
    } catch (error) {
      if (controller.signal.aborted || this.disposed || (error instanceof Error && error.name === 'AbortError')) {
        if (!this.disposed) this.repository.cancelAgentRun(run.id)
      } else {
        this.repository.completeAgentRun(run.id, {
          status: 'failed',
          output: '',
          citations: [],
          error: safeAgentMessage(error)
        })
      }
    } finally {
      this.controllers.delete(run.id)
    }
  }

  private createArtifact(
    input: StartAgentRunInput,
    prompt: PromptTemplate,
    result: GenerationResult
  ): void {
    this.repository.createResearchArtifact({
      projectId: input.projectId === null ? null : ProjectIdSchema.parse(input.projectId),
      kind: artifactKindForWorkflow[input.workflowKey],
      title: `${prompt.name} · ${this.now().toLocaleDateString('zh-CN')}`,
      content: result.text,
      sourcePaperIds: input.paperIds,
      citations: result.citations,
      status: 'draft'
    })
  }
}

function mockProvider(now: Date): AiProviderProfile {
  const timestamp = now.toISOString()
  return {
    id: 'builtin-mock',
    provider: 'mock',
    api: 'mock',
    name: 'Offline Mock',
    model: 'mock-v1',
    baseUrl: '',
    enabled: true,
    credentialPresent: false,
    createdAt: timestamp,
    updatedAt: timestamp,
    revision: 0
  }
}

function safeAgentMessage(error: unknown): string {
  if (error instanceof PromptRenderError) return error.message
  if (error instanceof ProviderRuntimeError) {
    switch (error.code) {
      case 'AUTH_REQUIRED': return 'The selected provider requires a valid credential.'
      case 'INVALID_ENDPOINT': return 'The selected provider endpoint is invalid.'
      case 'RATE_LIMITED': return 'The selected provider is rate limited. Try again later.'
      case 'INVALID_RESPONSE': return 'The selected provider returned an invalid response.'
      case 'PROVIDER_ERROR': return 'The selected provider could not complete the request.'
    }
  }
  return 'Agent execution failed. Review the selected provider, prompt, and papers.'
}
