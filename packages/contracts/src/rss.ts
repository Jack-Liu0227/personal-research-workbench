import { z } from 'zod'
import { IsoInstantSchema } from './v2.js'

export const RssSourceIdSchema = z.string().trim().min(1).max(80)
export type RssSourceId = z.infer<typeof RssSourceIdSchema>
export const RssCategoryIdSchema = z.string().trim().min(1).max(80)
export type RssCategoryId = z.infer<typeof RssCategoryIdSchema>

export const RssCategorySchema = z.strictObject({
  id: RssCategoryIdSchema,
  name: z.string().trim().min(1).max(80),
  builtIn: z.boolean(),
  sortOrder: z.int().nonnegative(),
  createdAt: IsoInstantSchema
})
export type RssCategory = z.infer<typeof RssCategorySchema>

export const RssSourceSchema = z.strictObject({
  id: RssSourceIdSchema,
  title: z.string().trim().min(1).max(120),
  url: z.string().trim().url().max(2048),
  siteUrl: z.string().trim().url().max(2048).nullable(),
  description: z.string().max(20_000),
  categoryId: RssCategoryIdSchema,
  categoryName: z.string().trim().min(1).max(80),
  enabled: z.boolean(),
  displayEnabled: z.boolean(),
  sortOrder: z.int().nonnegative(),
  createdAt: IsoInstantSchema
})
export type RssSource = z.infer<typeof RssSourceSchema>

export const RssSourcePreviewInputSchema = z.strictObject({ url: z.string().trim().url().max(2048) })
export type RssSourcePreviewInput = z.infer<typeof RssSourcePreviewInputSchema>
export const RssSourcePreviewSchema = z.strictObject({
  url: z.string().trim().url().max(2048),
  title: z.string().trim().min(1).max(120),
  siteUrl: z.string().trim().url().max(2048).nullable(),
  description: z.string().max(20_000),
  format: z.enum(['rss1', 'rss2', 'atom'])
})
export type RssSourcePreview = z.infer<typeof RssSourcePreviewSchema>

export const RssSaveSourceInputSchema = z.strictObject({
  id: RssSourceIdSchema.optional(),
  title: z.string().trim().min(1).max(120),
  url: z.string().trim().url().max(2048),
  siteUrl: z.string().trim().url().max(2048).nullable().default(null),
  description: z.string().max(20_000).default(''),
  categoryId: RssCategoryIdSchema,
  enabled: z.boolean().optional(),
  displayEnabled: z.boolean().optional(),
  sortOrder: z.int().nonnegative().optional()
})
export type RssSaveSourceInput = z.infer<typeof RssSaveSourceInputSchema>
export const RssSourceDeleteInputSchema = z.strictObject({ id: RssSourceIdSchema })
export type RssSourceDeleteInput = z.infer<typeof RssSourceDeleteInputSchema>
export const RssSourceSetEnabledInputSchema = z.strictObject({ id: RssSourceIdSchema, enabled: z.boolean() })
export type RssSourceSetEnabledInput = z.infer<typeof RssSourceSetEnabledInputSchema>
export const RssSourceSetDisplayEnabledInputSchema = z.strictObject({ id: RssSourceIdSchema, displayEnabled: z.boolean() })
export type RssSourceSetDisplayEnabledInput = z.infer<typeof RssSourceSetDisplayEnabledInputSchema>
export const RssSourceListSchema = z.array(RssSourceSchema)
export type RssSourceList = z.infer<typeof RssSourceListSchema>

export const RssCategorySaveInputSchema = z.strictObject({ id: RssCategoryIdSchema.optional(), name: z.string().trim().min(1).max(80) })
export type RssCategorySaveInput = z.infer<typeof RssCategorySaveInputSchema>
export const RssCategoryDeleteInputSchema = z.strictObject({ id: RssCategoryIdSchema })
export type RssCategoryDeleteInput = z.infer<typeof RssCategoryDeleteInputSchema>
export const RssCategoryListSchema = z.array(RssCategorySchema)
export type RssCategoryList = z.infer<typeof RssCategoryListSchema>

export const RssFeedItemSchema = z.strictObject({
  guid: z.string().min(1).max(500), title: z.string().trim().min(1).max(500), url: z.string().trim().url().max(2048),
  summary: z.string().max(20_000).default(''), authors: z.array(z.string().trim().min(1).max(300)).max(50).default([]),
  publishedAt: IsoInstantSchema.nullable(), sourceId: RssSourceIdSchema
})
export type RssFeedItem = z.infer<typeof RssFeedItemSchema>
export const RssItemSchema = RssFeedItemSchema.extend({
  sourceTitle: z.string().trim().min(1).max(120), sourceUrl: z.string().trim().url().max(2048),
  sourceCategoryId: RssCategoryIdSchema, sourceCategoryName: z.string().trim().min(1).max(80), sourceDeleted: z.boolean()
})
export type RssItem = z.infer<typeof RssItemSchema>

export const RssItemsQueryInputSchema = z.strictObject({
  sourceIds: z.array(RssSourceIdSchema).max(100).default([]),
  keywords: z.array(z.string().trim().min(1).max(100)).max(20).default([]), authors: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
  yearFrom: z.int().min(1900).max(3000).optional(), yearTo: z.int().min(1900).max(3000).optional(),
  publishedFrom: IsoInstantSchema.optional(), publishedTo: IsoInstantSchema.optional(), includeHidden: z.boolean().default(false),
  cursor: z.string().nullable().default(null), limit: z.int().min(1).max(100).default(50)
}).superRefine((value, ctx) => {
  if (value.yearFrom !== undefined && value.yearTo !== undefined && value.yearFrom > value.yearTo) ctx.addIssue({ code: 'custom', path: ['yearFrom'], message: 'yearFrom must be <= yearTo' })
  if (value.publishedFrom !== undefined && value.publishedTo !== undefined && Date.parse(value.publishedFrom) > Date.parse(value.publishedTo)) ctx.addIssue({ code: 'custom', path: ['publishedFrom'], message: 'publishedFrom must be <= publishedTo' })
})
export type RssItemsQueryInput = z.infer<typeof RssItemsQueryInputSchema>
export const RssItemsPageSchema = z.strictObject({ items: z.array(RssItemSchema), nextCursor: z.string().nullable(), total: z.int().nonnegative() })
export type RssItemsPage = z.infer<typeof RssItemsPageSchema>
export const RssItemsRefreshInputSchema = z.strictObject({ sourceIds: z.array(RssSourceIdSchema).max(100).default([]) })
export type RssItemsRefreshInput = z.infer<typeof RssItemsRefreshInputSchema>
export const RssItemsRefreshResultSchema = z.strictObject({ fetchedSources: z.int().nonnegative(), addedItems: z.int().nonnegative(), failures: z.array(z.strictObject({ sourceId: z.string(), message: z.string() })) })
export type RssItemsRefreshResult = z.infer<typeof RssItemsRefreshResultSchema>

export const RSS_DAILY_MSG_MAX_ITEMS = 20
export const RSS_DEFAULT_CATEGORIES: readonly Omit<RssCategory, 'createdAt'>[] = [
  { id: 'rsscat.technology-news', name: '技术新闻', builtIn: true, sortOrder: 0 },
  { id: 'rsscat.academic-papers', name: '学术论文', builtIn: true, sortOrder: 1 },
  { id: 'rsscat.industry', name: '行业动态', builtIn: true, sortOrder: 2 },
  { id: 'rsscat.ai-technology', name: 'AI / 科技', builtIn: true, sortOrder: 3 }
]
export const RSS_DEFAULT_SOURCES: readonly { readonly id: string; readonly title: string; readonly url: string; readonly categoryId: RssCategoryId }[] = [
  { id: 'rss.juejin', title: '掘金', url: 'https://juejin.cn/rss', categoryId: 'rsscat.technology-news' },
  { id: 'rss.hacker-news', title: 'Hacker News', url: 'https://hnrss.org/frontpage', categoryId: 'rsscat.technology-news' },
  { id: 'rss.nature', title: 'Nature', url: 'https://www.nature.com/nature.rss', categoryId: 'rsscat.academic-papers' },
  { id: 'rss.npj-computational-materials', title: 'npj Computational Materials', url: 'https://www.nature.com/npjcompumats.rss', categoryId: 'rsscat.academic-papers' },
  { id: 'rss.nature-machine-intelligence', title: 'Nature Machine Intelligence', url: 'https://www.nature.com/natmachintell.rss', categoryId: 'rsscat.ai-technology' }
]
