# Task 08 — 跨模块 QA

## 范围

验证 Literature Zotero 入口、URL 跳转、工具连接批量删除、通用 schedule 编辑器、AI daily digest、两个新 skill 的选择和安全边界。

## 自动化证据（2026-09-13）

- `pnpm typecheck`：PASS（10/10 workspace packages）。
- `pnpm build`：PASS（Electron main/preload/renderer 构建成功）。
- `pnpm test:e2e`：PASS，包含 schedule 默认值、skill 选择、连接批量删除、URL allowlist、响应式和滚动检查。
- `pnpm test:literature-skills`：PASS（21/21，结构、registry、注入、阻断、镜像）。
- `pnpm test:last30days`：PASS（20 项通过，2 项按参数 skip）。
- `pnpm test:daily-literature`：PASS（25/25）。
- `pnpm test:last30days:digest`：10 项通过、1 项明确 BLOCKED；未传 `--engine-run`，不能将真实 engine 运行写成 PASS。
- `pnpm test`：已执行；仓库脚本明确为 intentional no-op，不作为真实测试证据。
- `git diff --check`：无差异错误；仅有 Windows 换行转换警告。

## 真实环境状态

保持 `IN_REVIEW` / `BLOCKED`，因为以下项目没有在真实环境验收：

- Zotero 9/10：当前 Zotero 9 缺少 `Zotero-Server-ID`，写授权不可用；仅只读与 RIS/BibTeX fallback 已验证。
- 用户真实 Obsidian Vault、外部编辑冲突的大批量场景：未验收。
- Pi/Codex 带 app-owned 凭据的真实模型生成：未执行；keyless last30days engine 已有独立证据。
- cron 到点触发、启动补跑和长期运行：未验收。
- Windows x64 NSIS 安装、启动、重启、卸载 smoke：未执行。
- 两个 instruction-only skill 的真实联网/模型矩阵与综述正文：未执行；registry/UI/安全边界已通过离线 smoke 和 E2E。

不得把上述项目描述为已完成；任何后续 DONE 必须补充对应真实证据。
