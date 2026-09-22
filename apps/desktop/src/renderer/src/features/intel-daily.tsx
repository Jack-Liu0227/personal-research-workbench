import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import { useState } from 'react'
import type { RssItemsQueryInput } from '@prw/contracts'
import { ExternalUrlLink } from '../components/external-link'
import { EmptyState, ErrorState, InlineLoadingState, PageHeader } from '../components/states'
import { Button, Input } from '../components/ui'
import { getWorkbenchApi } from '../lib/workbench'
import { useRssItemsQuery } from './queries'

function RssIntelPanel(): React.JSX.Element {
  const queryClient = useQueryClient()
  const [sourceId, setSourceId] = useState<string | null>(null)
  const [keyword, setKeyword] = useState('')
  const [author, setAuthor] = useState('')
  const [year, setYear] = useState('')
  const [refreshMessage, setRefreshMessage] = useState<string | null>(null)
  const parsedYear = Number(year)
  const sources = useQuery({ queryKey: ['rss-sources'], queryFn: () => getWorkbenchApi().rss.sources.list() })
  const input: RssItemsQueryInput = { sourceIds: sourceId ? [sourceId] : [], keywords: keyword.trim() ? [keyword.trim()] : [], authors: author.trim() ? [author.trim()] : [], ...(year.trim() && Number.isInteger(parsedYear) ? { yearFrom: parsedYear, yearTo: parsedYear } : {}), includeHidden: false, cursor: null, limit: 50 }
  const itemsQuery = useRssItemsQuery(input)
  const refreshMutation = useMutation({ mutationFn: () => getWorkbenchApi().rss.sources.refresh({ sourceIds: [] }), onSuccess: (result) => { setRefreshMessage(`已抓取 ${result.fetchedSources} 个来源，新增 ${result.addedItems} 条${result.failures.length > 0 ? `，失败 ${result.failures.length} 个` : ''}`); void queryClient.invalidateQueries({ queryKey: ['rss-items'] }) }, onError: (error) => setRefreshMessage(error instanceof Error ? error.message : 'RSS 刷新失败') })
  const sourceName = sources.data?.find((source) => source.id === sourceId)?.title ?? '全部来源'
  return <section className="mt-4 rounded-xl border border-border bg-card" aria-label="RSS 情报结果">
    <header className="flex flex-wrap items-center gap-2 border-b border-border p-4"><div><p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">RSS INTELLIGENCE</p><h2 className="text-base font-bold text-foreground">{sourceName}</h2></div><Button className="ml-auto" disabled={refreshMutation.isPending} loading={refreshMutation.isPending} onClick={() => { setRefreshMessage(null); refreshMutation.mutate() }} size="sm" variant="secondary"><RefreshCw aria-hidden="true" className="size-3.5" />刷新 RSS</Button></header>
    {refreshMessage ? <p className="border-b border-border bg-muted/30 px-4 py-2 text-xs text-muted-foreground" role="status">{refreshMessage}</p> : null}
    <div className="grid gap-2 border-b border-border p-4 md:grid-cols-[12rem_1fr_1fr_8rem]"><select aria-label="RSS 来源" className="select-control" onChange={(event) => setSourceId(event.target.value || null)} value={sourceId ?? ''}><option value="">全部来源</option>{(sources.data ?? []).map((source) => <option key={source.id} value={source.id}>{source.title}</option>)}</select><Input aria-label="关键词筛选" onChange={(event) => setKeyword(event.target.value)} placeholder="关键词（标题或摘要）" value={keyword} /><Input aria-label="作者筛选" onChange={(event) => setAuthor(event.target.value)} placeholder="作者" value={author} /><Input aria-label="年份筛选" inputMode="numeric" onChange={(event) => setYear(event.target.value)} placeholder="年份" value={year} /></div>
    {itemsQuery.isError ? <div className="p-4"><ErrorState error={itemsQuery.error} onRetry={() => void itemsQuery.refetch()} /></div> : null}{itemsQuery.isLoading ? <div className="p-4"><InlineLoadingState label="正在读取 RSS 情报…" /></div> : null}{itemsQuery.data && itemsQuery.data.items.length === 0 ? <div className="p-4"><EmptyState title="暂无匹配条目" description="可调整筛选条件，或点击刷新 RSS 获取最新内容。" /></div> : null}
    {itemsQuery.data && itemsQuery.data.items.length > 0 ? <ul className="divide-y divide-border">{itemsQuery.data.items.map((item) => <li className="flex items-start gap-3 p-4" key={item.sourceId + ':' + item.guid}><div className="min-w-0 flex-1"><p className="text-sm font-semibold text-foreground">{item.title}</p><p className="mt-1 text-xs text-muted-foreground">{item.authors.join('、') || '作者未知'} · {item.publishedAt ? new Date(item.publishedAt).toLocaleDateString('zh-CN') : '日期未知'} · {item.sourceTitle}{item.sourceDeleted ? ' · 来源已删除' : ''}</p>{item.summary ? <p className="mt-2 line-clamp-2 text-xs leading-5 text-muted-foreground">{item.summary}</p> : null}</div><ExternalUrlLink ariaLabel={'打开：' + item.title} className="shrink-0" fieldLabel="RSS 原文" href={item.url} iconMode label="打开" showCopy={false} /></li>)}</ul> : null}{itemsQuery.data?.nextCursor ? <p className="border-t border-border p-3 text-center text-xs text-muted-foreground">还有更多结果，可通过 MCP 使用 cursor 继续查询。</p> : null}
  </section>
}

export function IntelDailyPage(): React.JSX.Element {
  const queryClient = useQueryClient()
  const refresh = (): void => { void queryClient.invalidateQueries({ queryKey: ['rss-items'] }) }
  return <div className="px-6 py-5"><PageHeader actions={<Button aria-label="刷新情报日报" onClick={refresh} size="icon" variant="ghost"><RefreshCw aria-hidden="true" className="size-4" /></Button>} description="RSS 技术新闻与文献的统一结果视图；来源、启停和显示策略在设置中管理。" eyebrow="研究工作台" title="情报日报" /><RssIntelPanel /></div>
}
