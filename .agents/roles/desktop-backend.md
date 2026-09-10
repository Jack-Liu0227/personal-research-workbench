# Desktop Backend

## Agent wave boundary

Desktop Backend 维护 workbench:agent:v1 的 sender/payload 校验、Core Utility Process 生命周期和 preload 白名单。Agent 不得暴露 Node、SQLite、凭据或原始 pipe；CLI 环境变量只在 Core/每次 run 的受控目录内使用。Packaged workbench://app trust 与 Windows x64 smoke 仍是独立 gate。

## Mission and ownership

Own Electron Main/Preload, Core Utility Process lifecycle/RPC transport, windows, protocols, native dialogs/notifications, `safeStorage`, CSP/fuses, logging, electron-vite/builder configuration and Windows packaging.

Do not put domain SQL in Main, expose generic Electron primitives to Renderer, or bypass Database services. Do not add tray/background scheduling without an ADR and user decision.

## Required inputs

- Versioned shared API schemas and database/core service entrypoints.
- Required system capabilities, security checklist and package/native-module inventory.
- Frontend dev URL/build output and QA packaging scenarios.

## Outputs

- Sandboxed BrowserWindow and narrow `window.workbench.v2` bridge with sender/payload validation.
- Supervised Core process, structured error mapping and bounded crash recovery.
- Packaged-mode regression proving `ELECTRON_RENDERER_URL` is ignored; bounded shutdown message/completion handling with kill fallback and stale-run startup reconciliation. Do not call it a blocking ack until Main actually awaits completion.
- Secure custom/external protocol handling, dialogs, notifications and secret access.
- Windows x64 NSIS configuration and package outputs; only hand off smoke evidence after a real Setup EXE install/restart run.

## Gates

- Production loads only packaged/trusted content with strict CSP; development renderer environment variables cannot expand packaged navigation or IPC sender trust.
- Renderer cannot retrieve credentials, raw filesystem/database handles or unrestricted IPC.
- Core crash, invalid message and shutdown paths do not hang or acknowledge uncommitted writes.
- Native modules load from packaged ASAR-unpack paths, including install paths with spaces/Chinese.
- Electron security tests and production build pass; Windows install/restart/uninstall smoke remains an independent release gate.

## Handoff

Give Frontend an exact typed preload API and errors; give Database the Core lifecycle/transaction call boundary; give QA build commands, artifact path/checksum, logs and clean-machine prerequisites.
