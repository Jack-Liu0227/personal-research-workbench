import type {
  AdapterProbe,
  AdapterProfile,
  AdapterPullResult,
  ManagedProjection,
  NormalizedExternalPaper,
  ProjectionReceipt,
  ProjectionTarget
} from './types.js'
import { IntegrationRuntimeError } from './types.js'

type FetchLike = typeof fetch
const notionVersion = '2026-03-11'

function requireCredential(profile: AdapterProfile): string {
  if (!profile.credential) throw new IntegrationRuntimeError('AUTH_REQUIRED', 'Notion 需要 integration token')
  return profile.credential
}

function headers(profile: AdapterProfile): Headers {
  return new Headers({
    Authorization: `Bearer ${requireCredential(profile)}`,
    'Content-Type': 'application/json',
    'Notion-Version': notionVersion
  })
}

function dataSourceId(profile: AdapterProfile): string {
  const id = String(profile.settings['dataSourceId'] ?? profile.location).trim()
  if (!id || !/^[0-9a-f-]{32,36}$/i.test(id)) {
    throw new IntegrationRuntimeError('INVALID_MAPPING', 'Notion data source ID 无效')
  }
  return id
}

function mapHttpError(response: Response): never {
  if (response.status === 401) throw new IntegrationRuntimeError('AUTH_REQUIRED', 'Notion token 无效')
  if (response.status === 403) throw new IntegrationRuntimeError('PERMISSION_DENIED', 'Notion 页面未共享或权限不足')
  if (response.status === 404) throw new IntegrationRuntimeError('NOT_FOUND', 'Notion 对象不存在')
  if (response.status === 409) throw new IntegrationRuntimeError('REVISION_CONFLICT', 'Notion 对象冲突')
  if (response.status === 429) throw new IntegrationRuntimeError('RATE_LIMITED', 'Notion 请求达到速率限制')
  throw new IntegrationRuntimeError('TEMPORARILY_UNAVAILABLE', `Notion 请求失败（${response.status}）`)
}

function textProperty(properties: Record<string, unknown>, name: string): string {
  const property = properties[name]
  if (!property || typeof property !== 'object') return ''
  const value = property as Record<string, unknown>
  const collection = Array.isArray(value['title']) ? value['title'] : Array.isArray(value['rich_text']) ? value['rich_text'] : []
  return collection.flatMap((part) => {
    if (!part || typeof part !== 'object') return []
    const plain = (part as Record<string, unknown>)['plain_text']
    return typeof plain === 'string' ? [plain] : []
  }).join('')
}

function multiSelectProperty(properties: Record<string, unknown>, name: string): string[] {
  const property = properties[name]
  if (!property || typeof property !== 'object') return []
  const values = (property as Record<string, unknown>)['multi_select']
  if (!Array.isArray(values)) return []
  return values.flatMap((item) => item && typeof item === 'object' && typeof (item as Record<string, unknown>)['name'] === 'string'
    ? [(item as Record<string, string>)['name']!]
    : [])
}

function normalizePage(page: Record<string, unknown>, profile: AdapterProfile): NormalizedExternalPaper | null {
  if (typeof page['id'] !== 'string' || !page['properties'] || typeof page['properties'] !== 'object') return null
  const properties = page['properties'] as Record<string, unknown>
  const titleName = String(profile.settings['titleProperty'] ?? 'Name')
  const title = textProperty(properties, titleName).trim()
  if (!title) return null
  const yearText = textProperty(properties, String(profile.settings['yearProperty'] ?? 'Year'))
  return {
    externalId: page['id'],
    locator: typeof page['url'] === 'string' ? page['url'] : `https://www.notion.so/${page['id'].replaceAll('-', '')}`,
    remoteRevision: typeof page['last_edited_time'] === 'string' ? page['last_edited_time'] : null,
    managedBlockId: null,
    title,
    authors: multiSelectProperty(properties, String(profile.settings['authorsProperty'] ?? 'Authors')),
    year: /^\d{4}$/.test(yearText) ? Number(yearText) : null,
    venue: textProperty(properties, String(profile.settings['venueProperty'] ?? 'Venue')),
    abstract: textProperty(properties, String(profile.settings['abstractProperty'] ?? 'Abstract')),
    doi: textProperty(properties, String(profile.settings['doiProperty'] ?? 'DOI')) || null,
    url: textProperty(properties, String(profile.settings['urlProperty'] ?? 'URL')) || null,
    citationKey: textProperty(properties, String(profile.settings['citationKeyProperty'] ?? 'Citation Key')) || null,
    tags: multiSelectProperty(properties, String(profile.settings['tagsProperty'] ?? 'Tags')),
    collections: multiSelectProperty(properties, String(profile.settings['collectionsProperty'] ?? 'Collections')),
    localPdfPath: null
  }
}

export async function probeNotion(profile: AdapterProfile, fetcher: FetchLike = fetch): Promise<AdapterProbe> {
  try {
    const response = await fetcher(`https://api.notion.com/v1/data_sources/${dataSourceId(profile)}`, {
      headers: headers(profile),
      signal: AbortSignal.timeout(10_000)
    })
    if (!response.ok) mapHttpError(response)
    return {
      ok: true,
      message: 'Notion data source 已连接；同步范围仅限该对象',
      capabilities: { read: true, write: true, attachments: 'link_only', incremental: false }
    }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : '无法连接 Notion',
      capabilities: { read: false, write: false, attachments: 'link_only', incremental: false }
    }
  }
}

export async function pullNotion(profile: AdapterProfile, fetcher: FetchLike = fetch): Promise<AdapterPullResult> {
  const response = await fetcher(`https://api.notion.com/v1/data_sources/${dataSourceId(profile)}/query`, {
    method: 'POST',
    headers: headers(profile),
    body: JSON.stringify({ page_size: Math.min(Number(profile.settings['limit'] ?? 100), 100) }),
    signal: AbortSignal.timeout(20_000)
  })
  if (!response.ok) mapHttpError(response)
  const payload = await response.json() as Record<string, unknown>
  const results = Array.isArray(payload['results']) ? payload['results'] : []
  return {
    cursor: typeof payload['next_cursor'] === 'string' ? payload['next_cursor'] : null,
    papers: results.flatMap((page) => {
      const normalized = page && typeof page === 'object' ? normalizePage(page as Record<string, unknown>, profile) : null
      return normalized ? [normalized] : []
    })
  }
}

export async function writeNotionProjection(
  profile: AdapterProfile,
  target: ProjectionTarget,
  projection: ManagedProjection,
  fetcher: FetchLike = fetch
): Promise<ProjectionReceipt> {
  const propertyName = String(profile.settings['managedProperty'] ?? 'Workbench Summary')
  if (!propertyName) throw new IntegrationRuntimeError('INVALID_MAPPING', 'Notion 托管属性未配置')
  if (!target.remoteRevision) {
    throw new IntegrationRuntimeError('REVISION_CONFLICT', 'Notion 写回前必须先拉取页面版本')
  }
  const pageUrl = `https://api.notion.com/v1/pages/${encodeURIComponent(target.externalId)}`
  const currentResponse = await fetcher(pageUrl, {
    headers: headers(profile),
    signal: AbortSignal.timeout(20_000)
  })
  if (!currentResponse.ok) mapHttpError(currentResponse)
  const current = await currentResponse.json() as Record<string, unknown>
  if (current['last_edited_time'] !== target.remoteRevision) {
    throw new IntegrationRuntimeError('REVISION_CONFLICT', 'Notion 页面已在外部更新')
  }
  const tagsProperty = String(profile.settings['tagsProperty'] ?? 'Tags')
  const collectionsProperty = String(profile.settings['collectionsProperty'] ?? 'Collections')
  const response = await fetcher(pageUrl, {
    method: 'PATCH',
    headers: headers(profile),
    body: JSON.stringify({
      properties: {
        [propertyName]: {
          rich_text: [{ type: 'text', text: { content: projection.markdown.slice(0, 2_000) } }]
        },
        [tagsProperty]: { multi_select: projection.tags.map((name) => ({ name })) },
        [collectionsProperty]: { multi_select: projection.collections.map((name) => ({ name })) }
      }
    }),
    signal: AbortSignal.timeout(20_000)
  })
  if (!response.ok) mapHttpError(response)
  const page = await response.json() as Record<string, unknown>
  return {
    externalId: target.externalId,
    locator: typeof page['url'] === 'string' ? page['url'] : target.locator,
    remoteRevision: typeof page['last_edited_time'] === 'string' ? page['last_edited_time'] : null
  }
}
