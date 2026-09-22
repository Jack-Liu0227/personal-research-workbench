import { z } from 'zod'

/**
 * 飞书本机扫码绑定（Feishu self-built app OAuth binding).
 *
 * The workbench binds a Feishu self-built app by completing Feishu's web
 * authorization flow inside the local app: Main starts a local HTTP callback
 * server on a fixed port, opens the authorize page (QR scan / account login),
 * exchanges the returned code for a user_access_token, fetches the bound
 * user's open_id, and stores every secret in Main's safeStorage vault
 * (`v2:integration:feishu:*`). Messages are then sent with the app's
 * tenant_access_token (bot identity) to the bound user's open_id.
 *
 * All secrets stay in Main; the renderer and Core only see status.
 */

/** Bound state as the renderer renders it. `bound` is the single source of
 * truth for the card state machine: `false` plus `message` explains why. */
export const FeishuBindingStatusSchema = z.strictObject({
  bound: z.boolean(),
  appId: z.string().trim().min(1).max(200).nullable().default(null),
  boundUserOpenId: z.string().trim().min(1).max(200).nullable().default(null),
  boundUserName: z.string().trim().min(1).max(200).nullable().default(null),
  /** Expiry of the stored user_access_token, ISO string; null when unknown. */
  expiresAt: z.iso.datetime({ offset: true }).nullable().default(null),
  /** Human-readable state detail (not a stack trace). */
  message: z.string().trim().max(500).default('')
})
export type FeishuBindingStatus = z.infer<typeof FeishuBindingStatusSchema>

/** `beginBind` starts the local callback wait and opens the authorize page in
 * the system browser. The renderer then polls `feishu.getStatus` until bound,
 * failed or timed out. */
export const FeishuBeginBindInputSchema = z.strictObject({})
export type FeishuBeginBindInput = z.infer<typeof FeishuBeginBindInputSchema>

export const FeishuBeginBindResultSchema = z.strictObject({
  ok: z.boolean(),
  /** Human-readable instruction shown in the UI while waiting. */
  message: z.string().trim().max(500)
})
export type FeishuBeginBindResult = z.infer<typeof FeishuBeginBindResultSchema>

/** Test message result: a send either reached the API or reports a structured
 * failure so the user can fix the app configuration instead of guessing. */
export const FeishuSendTestResultSchema = z.strictObject({
  ok: z.boolean(),
  message: z.string().trim().max(500)
})
export type FeishuSendTestResult = z.infer<typeof FeishuSendTestResultSchema>

/** App credentials entered in the settings card. `app_secret` is stored in
 * Main's safeStorage vault and never returned to the renderer. */
export const FeishuSaveAppInputSchema = z.strictObject({
  appId: z.string().trim().min(1).max(200),
  appSecret: z.string().trim().min(1).max(500)
})
export type FeishuSaveAppInput = z.infer<typeof FeishuSaveAppInputSchema>
