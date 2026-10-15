import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { AgentMcpServerSchema } from '@prw/contracts'
import { mcpCredentialKey, readMcpCredential, replaceMcpCredential, withMcpCredentialLock, type McpCredentialStore } from '../src/main/mcp-credentials.js'

const current = AgentMcpServerSchema.parse({ id:'mcp.fixture',name:'Fixture',transport:'streamable-http',endpoint:'https://example.com/mcp',enabled:true,
  tools:[],lastProbe:null,archivedAt:null,createdAt:'2026-10-15T00:00:00.000Z',updatedAt:'2026-10-15T00:00:00.000Z',revision:0 })
function store() {
  const values = new Map<string,string>()
  const vault: McpCredentialStore = {get:async k=>values.get(k)??null,set:async(k,v)=>{values.set(k,v)},remove:async k=>{values.delete(k)}}
  return { values, vault }
}
const active = (token:string, revision=0, state='active') => JSON.stringify({version:1,state,id:current.id,revision,endpoint:current.endpoint,token})

test('staged orphan cannot revive on same endpoint, endpoint edit, restart or clear', async()=>{
  const {values,vault}=store()
  values.set(mcpCredentialKey(current.id,1),active('fixture-only',1,'staged'))
  assert.equal(await readMcpCredential(vault,{...current,revision:1}),null)
  assert.equal(await readMcpCredential(vault,{...current,revision:1,endpoint:'https://example.org/mcp'}),null)
  const next={...current,revision:1}
  await replaceMcpCredential(vault,current,null,async()=>next,r=>r)
  assert.equal(await readMcpCredential(vault,next),null)
  assert.equal(values.has(mcpCredentialKey(current.id,1)),false)
})
test('vault stage failure preserves current credential and does not commit DB',async()=>{
  const {values,vault}=store(); values.set(mcpCredentialKey(current.id,0),active('old-fixture'))
  let commits=0
  await assert.rejects(replaceMcpCredential({...vault,set:async()=>{throw new Error('fixture storage unavailable')}},current,'new-fixture',async()=>{commits++;return current},r=>r))
  assert.equal(commits,0); assert.equal(await readMcpCredential(vault,current),'old-fixture')
})
test('CAS failure removes only stage; success activates exact config and retires old',async()=>{
  const {values,vault}=store(); values.set(mcpCredentialKey(current.id,0),active('old-fixture'))
  await replaceMcpCredential(vault,current,'new-fixture',async()=>null,r=>r)
  assert.equal(values.has(mcpCredentialKey(current.id,1)),false)
  assert.equal(await readMcpCredential(vault,current),'old-fixture')
  const next={...current,revision:1}
  await replaceMcpCredential(vault,current,'new-fixture',async()=>next,r=>r)
  assert.equal(await readMcpCredential(vault,next),'new-fixture')
  assert.equal(await readMcpCredential(vault,next,0),null)
  assert.equal(await readMcpCredential(vault,{...next,enabled:false}),null)
  assert.equal(await readMcpCredential(vault,{...next,endpoint:'https://example.org/mcp'}),null)
  assert.equal(values.has(mcpCredentialKey(current.id,0)),false)
})
test('activation failure after CAS fails closed rather than using staged token',async()=>{
  const {values,vault}=store(); let writes=0
  const next={...current,revision:1}
  await assert.rejects(replaceMcpCredential({...vault,set:async(k,v)=>{if(++writes===2)throw new Error('fixture activation failed');values.set(k,v)}},current,'new-fixture',async()=>next,r=>r))
  assert.equal(await readMcpCredential(vault,next),null)
})
test('same-server readers and remove wait for mutation; other server is independent',async()=>{
  const {vault}=store(); const next={...current,revision:1}
  let release!:()=>void
  const barrier=new Promise<void>(r=>{release=r})
  const order:string[]=[]
  const mutation=withMcpCredentialLock(current.id,()=>replaceMcpCredential(vault,current,'fixture-only',async()=>{order.push('stage');await barrier;return next},r=>r))
  await new Promise(r=>setImmediate(r))
  const reader=withMcpCredentialLock(current.id,async()=>{order.push('read');return readMcpCredential(vault,next)})
  await withMcpCredentialLock('mcp.other',async()=>{order.push('other')})
  assert.deepEqual(order,['stage','other']); release(); await mutation
  assert.equal(await reader,'fixture-only')
  await withMcpCredentialLock(current.id,()=>vault.remove(mcpCredentialKey(current.id,1)))
  assert.equal(await readMcpCredential(vault,next),null)
})
