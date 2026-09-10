import type { CoreRpcTransport, SecureRpcRouter } from './ipc.js'

export interface ScheduleNotificationSink {
  show(title: string, body: string): void
}

interface ScheduleCoordinatorOptions {
  readonly intervalMs?: number
  readonly now?: () => Date
  readonly notifications?: ScheduleNotificationSink
}

export class ScheduleCoordinator {
  constructor(
    _client: CoreRpcTransport,
    _router: Pick<SecureRpcRouter, 'runSchedule'>,
    _options: ScheduleCoordinatorOptions = {}
  ) {}

  start(): void {
    // The Workspace Service owns Agent schedule ticks. Main keeps this
    // compatibility shell so there is no second scheduler or duplicate run.
  }

  stop(): void {
    // Scheduling/automation is intentionally disabled in the current V2.
  }

  async tick(): Promise<void> {
    // Agent schedules are ticked inside the Core service host, where the
    // repository transaction and runtime lifecycle are colocated.
  }
}
