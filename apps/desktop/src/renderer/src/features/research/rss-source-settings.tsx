import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import type { RssCategory, RssSaveSourceInput, RssSource } from '@prw/contracts'
import { ExternalUrlLink } from '../../components/external-link'
import { EmptyState, ErrorState, LoadingState } from '../../components/states'
import { Button, Field, Input, Textarea } from '../../components/ui'
import { getErrorMessage } from '../../lib/utils'
import { getWorkbenchApi } from '../../lib/workbench'
import { ResearchPanel } from './shared'

const DEFAULT_CATEGORY = 'rsscat.academic-papers'

export function RssSourceSettings(): React.JSX.Element {
  const client = useQueryClient()
  const [editing, setEditing] = useState<RssSource | null>(null)
  const [title, setTitle] = useState('')
  const [url, setUrl] = useState('')
  const [siteUrl, setSiteUrl] = useState<string | null>(null)
  const [description, setDescription] = useState('')
  const [categoryId, setCategoryId] = useState(DEFAULT_CATEGORY)
  const [previewedUrl, setPreviewedUrl] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<string | null>(null)
  const [categoryName, setCategoryName] = useState('')
  const [editingCategory, setEditingCategory] = useState<RssCategory | null>(null)
  const sources = useQuery({ queryKey: ['rss-sources'], queryFn: () => getWorkbenchApi().rss.sources.list() })
  const categories = useQuery({ queryKey: ['rss-categories'], queryFn: () => getWorkbenchApi().rss.categories.list() })
  const refresh = (): void => { void client.invalidateQueries({ queryKey: ['rss-sources'] }); void client.invalidateQueries({ queryKey: ['rss-items'] }) }
  const resetForm = (): void => { setEditing(null); setTitle(''); setUrl(''); setSiteUrl(null); setDescription(''); setCategoryId(categories.data?.[1]?.id ?? DEFAULT_CATEGORY); setPreviewedUrl(null); setFeedback(null) }
  const preview = useMutation({ mutationFn: (value: string) => getWorkbenchApi().rss.sources.preview({ url: value }), onSuccess: (result) => { setTitle(result.title); setSiteUrl(result.siteUrl); setDescription(result.description); setPreviewedUrl(result.url); setFeedback(`已解析 ${result.format.toUpperCase()} 来源，可以保存。`) }, onError: (error) => { setPreviewedUrl(null); setFeedback(`解析失败：${getErrorMessage(error)}`) } })
  const save = useMutation({ mutationFn: (input: RssSaveSourceInput) => getWorkbenchApi().rss.sources.save(input), onSuccess: () => { refresh(); resetForm() }, onError: (error) => setFeedback(getErrorMessage(error)) })
  const toggle = useMutation({ mutationFn: (source: RssSource) => getWorkbenchApi().rss.sources.setEnabled({ id: source.id, enabled: !source.enabled }), onSuccess: refresh })
  const display = useMutation({ mutationFn: (source: RssSource) => getWorkbenchApi().rss.sources.setDisplayEnabled({ id: source.id, displayEnabled: !source.displayEnabled }), onSuccess: refresh })
  const remove = useMutation({ mutationFn: (source: RssSource) => getWorkbenchApi().rss.sources.remove({ id: source.id }), onSuccess: refresh, onError: (error) => setFeedback(getErrorMessage(error)) })
  const saveCategory = useMutation({ mutationFn: () => getWorkbenchApi().rss.categories.save(editingCategory ? { id: editingCategory.id, name: categoryName.trim() } : { name: categoryName.trim() }), onSuccess: () => { setCategoryName(''); setEditingCategory(null); void client.invalidateQueries({ queryKey: ['rss-categories'] }) }, onError: (error) => setFeedback(getErrorMessage(error)) })
  const removeCategory = useMutation({ mutationFn: (category: RssCategory) => getWorkbenchApi().rss.categories.remove({ id: category.id }), onSuccess: () => void client.invalidateQueries({ queryKey: ['rss-categories'] }), onError: (error) => setFeedback(getErrorMessage(error)) })
  const submit = (event: React.FormEvent<HTMLFormElement>): void => { event.preventDefault(); if (!title.trim() || !url.trim() || previewedUrl !== url.trim() || !categoryId) { setFeedback('请先输入 URL 并成功解析来源，再保存。'); return } save.mutate({ ...(editing ? { id: editing.id } : {}), title: title.trim(), url: url.trim(), siteUrl, description, categoryId }) }
  const startEdit = (source: RssSource): void => { setEditing(source); setTitle(source.title); setUrl(source.url); setSiteUrl(source.siteUrl); setDescription(source.description); setCategoryId(source.categoryId); setPreviewedUrl(source.url); setFeedback(null) }
  return <>
    <ResearchPanel eyebrow="RSS / INTELLIGENCE SOURCES" title="RSS 订阅源（每日文献推送）">
      <p className="border-b border-border px-4 py-3 text-xs leading-5 text-muted-foreground">新增来源会先读取 RSS/Atom 元数据；移除只删除来源配置，已抓取文章和来源快照仍会保留。</p>
      <form className="grid gap-3 p-4" onSubmit={submit}>
        <div className="grid gap-3 sm:grid-cols-[1fr_auto]"><Field htmlFor="rss-url" label="RSS 地址"><Input id="rss-url" onChange={(event) => { setUrl(event.target.value); setPreviewedUrl(null) }} placeholder="https://example.com/feed.xml" value={url} /></Field><Button aria-label="解析 RSS 来源" className="self-end" loading={preview.isPending} onClick={() => { if (url.trim()) preview.mutate(url.trim()) }} type="button" variant="secondary">解析来源</Button></div>
        <div className="grid gap-3 sm:grid-cols-2"><Field htmlFor="rss-title" label="期刊名称"><Input id="rss-title" maxLength={120} onChange={(event) => setTitle(event.target.value)} placeholder="解析后自动填充" value={title} /></Field><Field htmlFor="rss-site-url" label="网站"><Input id="rss-site-url" onChange={(event) => setSiteUrl(event.target.value || null)} placeholder="解析后自动填充" value={siteUrl ?? ''} /></Field></div>
        <Field htmlFor="rss-description" label="描述"><Textarea id="rss-description" maxLength={20_000} onChange={(event) => setDescription(event.target.value)} value={description} /></Field>
        <div className="flex flex-wrap items-end gap-2"><Field htmlFor="rss-category" label="分类"><select className="select-control" id="rss-category" onChange={(event) => setCategoryId(event.target.value)} value={categoryId}>{(categories.data ?? []).map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></Field><Button loading={save.isPending} type="submit">{editing ? '保存修改' : '添加订阅'}</Button>{editing ? <Button onClick={resetForm} type="button" variant="ghost">取消编辑</Button> : null}</div>
        {feedback ? <p aria-live="polite" className="form-feedback" role="status">{feedback}</p> : null}
      </form>
      {sources.isLoading || categories.isLoading ? <LoadingState label="正在读取 RSS 来源…" /> : null}
      {sources.error ? <ErrorState error={sources.error} onRetry={() => void sources.refetch()} /> : null}
      {sources.data?.length === 0 ? <EmptyState title="暂无 RSS 来源" description="解析并添加来源后即可抓取文章。" /> : null}
      <div className="divide-y divide-border">{sources.data?.map((source) => <article className="settings-row" data-rss-source-card={source.id} key={source.id}><div className="min-w-0 flex-1"><p className="text-sm font-bold">{source.title}</p><p className="text-xs text-muted-foreground">{source.categoryName} · {source.enabled ? '抓取已启用' : '抓取已暂停'} · {source.displayEnabled ? '加入日报' : '隐藏日报'}</p>{source.siteUrl ? <ExternalUrlLink ariaLabel={`打开网站：${source.title}`} className="mt-1" fieldLabel="来源网站" href={source.siteUrl} label={source.siteUrl} showCopy={false} /> : null}<p className="break-all text-xs text-muted-foreground">{source.url}</p>{source.description ? <p className="mt-1 text-xs text-muted-foreground">{source.description}</p> : null}</div><div className="flex flex-wrap justify-end gap-2"><Button aria-label={`${source.enabled ? '暂停' : '启用'}抓取：${source.title}`} onClick={() => toggle.mutate(source)} size="sm" variant="secondary">{source.enabled ? '暂停抓取' : '启用抓取'}</Button><Button aria-label={`${source.displayEnabled ? '隐藏' : '加入'}日报：${source.title}`} onClick={() => display.mutate(source)} size="sm" variant="secondary">{source.displayEnabled ? '隐藏日报' : '加入日报'}</Button><Button aria-label={`编辑来源：${source.title}`} onClick={() => startEdit(source)} size="sm" variant="secondary">编辑</Button><Button aria-label={`删除来源：${source.title}`} onClick={() => { if (window.confirm(`删除“${source.title}”来源配置？已抓取文章仍会保留。`)) remove.mutate(source) }} size="sm" variant="ghost">移除</Button></div></article>)}</div>
    </ResearchPanel>
    <ResearchPanel eyebrow="RSS / CATEGORIES" title="RSS 分类管理">
      <div className="grid gap-2 p-4 sm:grid-cols-[1fr_auto]"><Input aria-label="自定义分类名称" onChange={(event) => setCategoryName(event.target.value)} placeholder="新增自定义分类" value={categoryName} /><Button disabled={!categoryName.trim()} loading={saveCategory.isPending} onClick={() => saveCategory.mutate()} size="sm">新增分类</Button></div>
      <div className="divide-y divide-border">{(categories.data ?? []).map((category) => <div className="settings-row" key={category.id}><span className="text-sm font-semibold">{category.name}{category.builtIn ? <span className="ml-2 text-xs text-muted-foreground">内置</span> : null}</span>{!category.builtIn ? <div className="flex gap-2"><Button aria-label={`重命名分类：${category.name}`} onClick={() => { setEditingCategory(category); setCategoryName(category.name) }} size="sm" variant="secondary">重命名</Button><Button aria-label={`删除分类：${category.name}`} onClick={() => { if (window.confirm(`删除分类“${category.name}”？`)) removeCategory.mutate(category) }} size="sm" variant="ghost">删除</Button></div> : null}</div>)}</div>
      {editingCategory ? <div className="flex gap-2 border-t border-border p-4"><Input aria-label="新的分类名称" onChange={(event) => setCategoryName(event.target.value)} value={categoryName} /><Button loading={saveCategory.isPending} onClick={() => saveCategory.mutate()} size="sm">保存名称</Button><Button onClick={() => { setEditingCategory(null); setCategoryName('') }} size="sm" variant="ghost">取消</Button></div> : null}
    </ResearchPanel>
  </>
}
