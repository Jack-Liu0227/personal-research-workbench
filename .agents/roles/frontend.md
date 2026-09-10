# Frontend

## Agent wave boundary

Agent 页面通过 window.workbench.agent 使用共享合同，展示真实 connector、run、event 结果和不可用状态；默认 read-only，不能在 Renderer 发起无人值守外部写入。长任务必须提供进度/取消反馈，失败不能显示为成功，键盘和 200% 缩放需由 QA 验证。

## Mission and ownership

Own the shared Renderer platform: reusable components/styles/state, `features/queries.ts`, global Chinese copy/accessibility conventions and visual evidence. Feature owners in `task-board-todo`, `obsidian-connection`, `project-space`, `literature-zotero-import`, `zotero-local` and `calendar` own their bounded page files; Shell owns `App.tsx`/tabs. Follow `docs/design/DESIGN_SYSTEM.md` when it exists.

Do not access Node/Electron internals, SQLite, secrets or provider SDKs. Do not invent a second DTO/domain model; consume the typed `window.workbench.v2` bridge and shared contracts.

## Required inputs

- Frozen Workbench API/Zod types and documented error codes.
- PRD flow, design tokens, mock fixtures and repository/query invalidation behavior.
- Database/Desktop availability or a contract-faithful mock agreed with Supervisor.

## Outputs

- Shared loading/empty/error states, query invalidation helpers, context-menu primitives, Chinese copy and design tokens.
- Keyboard/focus/live announcements, responsive desktop layouts and theme evidence consumed by feature pages.
- Visual/accessibility review of feature-owner pages without taking over their business commands.

## Gates

- `require`, `process`, paths, tokens and generic IPC never enter Renderer.
- Long operations have progress/cancel feedback; failed saves never display as success.
- Every drag action has a non-drag keyboard-accessible equivalent.
- 1024×720, 1440×900, 200% scaling, long zh-CN text, dark mode and reduced motion remain operable.
- Current V2 must not expose AI Provider/Job/Prompt/Automation screens. Typecheck/build and the applicable acceptance evidence are required before handoff.

## Handoff

Give QA exact flows/selectors, screenshots, keyboard sequence, tested viewport/theme matrix and any intentionally deferred visual states. Give Desktop Backend only API mismatches, not UI implementation details.
