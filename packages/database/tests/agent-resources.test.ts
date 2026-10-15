import { afterEach, test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type BetterSqlite3 from 'better-sqlite3'
import { AgentMcpServerSaveInputSchema, AgentMcpToolSchema, AgentInstructionSkillSaveInputSchema, AgentAssistantSaveInputSchema, RpcRequestSchema } from '@prw/contracts'
import { WorkbenchRepository } from '../src/repository.ts'

const opened: WorkbenchRepository[] = []
const sha = (text: string): string => createHash('sha256').update(text).digest('hex')
function open(filePath = ':memory:'): WorkbenchRepository {
  const repository = new WorkbenchRepository({ filePath })
  opened.push(repository)
  return repository
}
function sql(repository: WorkbenchRepository): BetterSqlite3.Database {
  return (repository as unknown as { sqlite: BetterSqlite3.Database }).sqlite
}
const markdown = '---\nname: test-instructions\ndescription: A local instruction fixture\n---\n\nExplain the evidence and never run code or invent citations.'
const serverInput = { id: 'mcp.fixture', name: 'Fixture', transport: 'streamable-http' as const, endpoint: 'http://127.0.0.1:9876/mcp', enabled: true, expectedRevision: null }
afterEach(() => { while (opened.length) opened.pop()?.close() })

test('strict resources reject executable transports, arbitrary paths and credential URLs', () => {
  for (const endpoint of ['file:///tmp/a', 'http://192.168.1.1/mcp', 'http://localhost/mcp', 'https://u:p@example.com', 'https://example.com/mcp?token=x', 'https://example.com/#x'])
    assert.equal(AgentMcpServerSaveInputSchema.safeParse({ ...serverInput, endpoint }).success, false)
  for (const field of ['command','args','env','headers','token','path'])
    assert.equal(AgentMcpServerSaveInputSchema.safeParse({ ...serverInput, [field]: 'forbidden' }).success, false)
  assert.equal(AgentMcpServerSaveInputSchema.safeParse({ ...serverInput, transport: 'stdio' }).success, false)
  assert.equal(AgentInstructionSkillSaveInputSchema.safeParse({ id:'literature-matrix', name:'x', description:'', markdown, enabled:true, expectedRevision:null }).success, false)
  assert.equal(RpcRequestSchema.safeParse({ id:'request', method:'agentMcpServers.save', payload:serverInput }).success, true)
})

test('migration 39 upgrades actual v38 profile and preserves assistant/chat/settings on restart', () => {
  const file = join(mkdtempSync(join(tmpdir(),'prw-resource-upgrade-')),'workspace.sqlite3')
  const repository = open(file)
  const conversation = repository.createAgentConversation({ title:'Existing history' })
  const settings = repository.getAgentSettings()
  sql(repository).exec('DROP TABLE agent_mcp_calls; DROP TABLE agent_mcp_servers; DROP TABLE agent_instruction_skills; DELETE FROM _prw_migrations WHERE id=39;')
  repository.close()
  const upgraded = open(file)
  assert.equal((sql(upgraded).prepare('SELECT MAX(id) n FROM _prw_migrations').get() as { n:number }).n,39)
  assert.equal(upgraded.getAgentConversation(conversation.id).title,conversation.title)
  assert.deepEqual(upgraded.getAgentSettings(), settings)
  upgraded.agentResources.saveMcpServer(serverInput)
  upgraded.agentResources.saveInstructionSkill({confirmed:true, id:'skill.user.fixture',name:'Fixture',description:'',markdown,enabled:true,expectedRevision:null })
  upgraded.close()
  const restarted = open(file)
  assert.equal(restarted.agentResources.listMcpServers().length,1)
  assert.equal(restarted.agentResources.getInstructionSkill('skill.user.fixture').markdown,markdown)
  assert.deepEqual(sql(restarted).pragma('foreign_key_check'),[])
  assert.equal(sql(restarted).pragma('integrity_check',{simple:true}),'ok')
})

test('resource CAS and probe/config semantics fail closed without touching bindings', () => {
  const repository = open()
  const resources = repository.agentResources
  const server = resources.saveMcpServer(serverInput)
  const schema = { type:'object',properties:{} }
  const tools = [{ key:'mcp.fixture.read',name:'read',description:'Untrusted',inputSchema:schema,schemaHash:sha(JSON.stringify(schema)) }]
  assert.equal(resources.setMcpServerProbe({id:server.id,expectedRevision:server.revision,tools,probedAt:new Date().toISOString()}).revision,server.revision)
  const next = resources.saveMcpServer({...serverInput,expectedRevision:server.revision})
  assert.equal(next.tools.length,0)
  assert.equal(next.lastProbe,null)
  assert.equal(next.credentialPresent,false)
  assert.throws(()=>resources.saveMcpServer({...serverInput,expectedRevision:server.revision}), /changed/)
  assert.throws(()=>resources.removeMcpServer({id:server.id,expectedRevision:next.revision,confirmed:false}))
  resources.removeMcpServer({id:server.id,expectedRevision:next.revision,confirmed:true})
  assert.deepEqual(resources.listMcpServers(),[])
  assert.throws(()=>resources.saveMcpServer({...serverInput,expectedRevision:next.revision+1}), /archived/)
})

test('editing skill text revokes old bindings atomically and invalidates stale assistant drafts', () => {
  const repository = open()
  const resources = repository.agentResources
  const skill = resources.saveInstructionSkill({confirmed:true,id:'skill.user.fixture',name:'Fixture',description:'',markdown,enabled:true,expectedRevision:null})
  const assistant = repository.agentProfiles.saveAssistant(AgentAssistantSaveInputSchema.parse({id:'assistant.resource',name:'Reader',skillKeys:[skill.id],expectedRevision:null}))
  const disabled = resources.saveInstructionSkill({confirmed:true,id:skill.id,name:skill.name,description:'',markdown,expectedRevision:skill.revision,enabled:false})
  assert.deepEqual(repository.agentProfiles.getAssistant(assistant.id).skillKeys,[skill.id])
  const changed = resources.saveInstructionSkill({confirmed:true,id:skill.id,name:skill.name,description:'',markdown:markdown+'\nUse only verified sources.',enabled:true,expectedRevision:disabled.revision})
  assert.notEqual(changed.contentHash,skill.contentHash)
  assert.deepEqual(repository.agentProfiles.getAssistant(assistant.id).skillKeys,[])
  assert.equal(repository.agentProfiles.getAssistant(assistant.id).revision,assistant.revision+1)
  assert.throws(()=>resources.saveInstructionSkill({confirmed:true,id:skill.id,name:skill.name,description:'',markdown,enabled:true,expectedRevision:skill.revision}),/changed/)
  assert.throws(()=>resources.saveInstructionSkill({confirmed:true,id:'skill.user.invalid',name:'Invalid',description:'',markdown:'No frontmatter but more than twenty chars.',enabled:true,expectedRevision:null}),/frontmatter/)
})

function pending(repository: WorkbenchRepository, id='call.fixture') {
  const server = repository.agentResources.saveMcpServer({...serverInput,id:`mcp.${id.replaceAll('.','-')}`})
  const schema = {type:'object',properties:{}}
  const tool = {key:`${server.id}.read`,name:'read',description:'Untrusted',inputSchema:schema,schemaHash:sha(JSON.stringify(schema))}
  repository.agentResources.setMcpServerProbe({id:server.id,expectedRevision:server.revision,tools:[tool],probedAt:new Date().toISOString()})
  const assistantId = `assistant.${id.replaceAll('.','-')}`
  repository.agentProfiles.saveAssistant(AgentAssistantSaveInputSchema.parse({id:assistantId,name:'Resource',toolProfile:'approved-write',toolAllowlist:[tool.key],expectedRevision:null}))
  const conversation = repository.createAgentConversation({title:'MCP request',runtime:'pi'})
  const run = repository.startManagedAgentRun({jobId:null,conversationId:conversation.id,runtime:'pi',transport:'inprocess',workflowKey:'research_plan',projectId:null,paperIds:[],instructions:'Read fixture',assistantId,permissionMode:'auto',toolProfile:'approved-write',idempotencyKey:null})
  repository.updateManagedAgentRun({id:run.id,status:'running'})
  return repository.agentResources.createMcpCall({id,runId:run.id,assistantId,serverId:server.id,serverRevision:server.revision,endpoint:server.endpoint,toolKey:tool.key,toolName:tool.name,schemaHash:tool.schemaHash,argumentsJson:'{}',argsHash:sha('{}'),status:'pending',result:'',error:null,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),expiresAt:'2036-01-01T00:00:00.000Z'})
}

test('pending MCP calls are claimed once, never replayed, and invalidated on config edit/restart', () => {
  const repository = open()
  const resources = repository.agentResources
  const call = pending(repository)
  const claimed = resources.claimMcpCall({id:call.id,expectedRevision:call.revision,decision:'approve',now:new Date().toISOString()})
  assert.equal(claimed.status,'executing')
  assert.throws(()=>resources.claimMcpCall({id:call.id,expectedRevision:call.revision,decision:'approve',now:new Date().toISOString()}),/changed/)
  assert.equal(resources.completeMcpCall({id:claimed.id,expectedRevision:claimed.revision,status:'completed',result:'fixture answer',error:null,now:new Date().toISOString()}).status,'completed')
  const stale = pending(repository,'call.second')
  const server = resources.getMcpServer(stale.serverId)
  resources.saveMcpServer({id:server.id,name:server.name,endpoint:server.endpoint,transport:server.transport,enabled:false,expectedRevision:server.revision})
  assert.equal(resources.getMcpCall(stale.id).status,'invalidated')
  assert.throws(()=>resources.claimMcpCall({id:stale.id,expectedRevision:0,decision:'approve',now:new Date().toISOString()}))
  const restart = pending(repository,'call.third')
  assert.equal(resources.invalidateMcpCalls({now:new Date().toISOString(),reason:'Application restarted.'}),1)
  assert.equal(resources.getMcpCall(restart.id).status,'invalidated')
  assert.equal(resources.getMcpCall(call.id).status,'completed')
})

test('expired or canceled run MCP approval cannot be executed', () => {
  const repository = open()
  const expired = pending(repository,'call.expired')
  assert.throws(()=>repository.agentResources.claimMcpCall({id:expired.id,expectedRevision:0,decision:'approve',now:'2037-01-01T00:00:00.000Z'}),/expired/)
  const canceled = pending(repository,'call.canceled')
  repository.updateManagedAgentRun({id:canceled.runId,status:'canceled'})
  assert.throws(()=>repository.agentResources.claimMcpCall({id:canceled.id,expectedRevision:0,decision:'approve',now:new Date().toISOString()}),/changed/)
})

test('deep JSON rejects before recursive parsing and user skills require explicit review',()=>{
  let deep:unknown = 0
  for(let i=0;i<3000;i++) deep={a:deep}
  assert.equal(AgentMcpToolSchema.safeParse({key:'mcp.deep',name:'deep',description:'',inputSchema:{type:'object',default:deep},schemaHash:'0'.repeat(64)}).success,false)
  assert.equal(AgentInstructionSkillSaveInputSchema.safeParse({id:'skill.user.fixture',name:'Fixture',description:'',markdown,enabled:true,expectedRevision:null}).success,false)
})

test('skill edit rollback preserves bindings, assistant revision and team snapshot',()=>{
  const repository=open(), resources=repository.agentResources
  const skill=resources.saveInstructionSkill({confirmed:true,id:'skill.user.atomic',name:'Atomic',description:'',markdown,enabled:true,expectedRevision:null})
  const director=repository.agentProfiles.saveAssistant(AgentAssistantSaveInputSchema.parse({id:'assistant.atomic',name:'Director',skillKeys:[skill.id],expectedRevision:null}))
  const worker=repository.agentProfiles.saveAssistant(AgentAssistantSaveInputSchema.parse({id:'assistant.atomic-worker',name:'Worker',expectedRevision:null}))
  const team=repository.agentProfiles.saveTeam({id:'team.atomic',name:'Team',description:'',enabled:true,maxSteps:2,expectedRevision:null,members:[{assistantId:director.id,role:'director',instructions:''},{assistantId:worker.id,role:'researcher',instructions:''}]})
  const snapshot=JSON.stringify({team,assistants:[director,worker]})
  sql(repository).exec("CREATE TRIGGER fixture_block_skill_edit BEFORE UPDATE ON agent_assistants BEGIN SELECT RAISE(ABORT,'fixture rollback'); END")
  const input={confirmed:true as const,id:skill.id,name:skill.name,description:'',markdown:markdown+'\nEdited evidence.',enabled:true,expectedRevision:skill.revision}
  assert.throws(()=>resources.saveInstructionSkill(input),/fixture rollback/)
  assert.deepEqual(resources.getInstructionSkill(skill.id),skill)
  assert.deepEqual(repository.agentProfiles.getAssistant(director.id),director)
  sql(repository).exec('DROP TRIGGER fixture_block_skill_edit')
  resources.saveInstructionSkill(input)
  assert.equal(repository.agentProfiles.getAssistant(director.id).revision,director.revision+1)
  assert.equal(JSON.stringify({team,assistants:[director,worker]}),snapshot)
  assert.deepEqual(repository.agentProfiles.getTeam(team.id),team)
})

test('MCP creation and claim fail closed on run identity, state, permission and revoked binding',()=>{
  const repository=open(), resources=repository.agentResources
  const call=pending(repository,'call.identity')
  const {revision:_,...draft}=call
  assert.throws(()=>resources.createMcpCall({...draft,id:'call.forged',runId:'run.missing'}),/changed/)
  assert.throws(()=>resources.createMcpCall({...draft,id:'call.array',argumentsJson:'[]',argsHash:sha('[]')}),/changed/)
  for(const [column,bad,good] of [['assistant_id','assistant.default',call.assistantId],['permission_mode','read-only','auto'],['agent_status','planned','running']] as const){
    sql(repository).prepare(`UPDATE agent_runs SET ${column}=? WHERE id=?`).run(bad,call.runId)
    assert.throws(()=>resources.claimMcpCall({id:call.id,expectedRevision:0,decision:'approve',now:new Date().toISOString()}),/changed/)
    sql(repository).prepare(`UPDATE agent_runs SET ${column}=? WHERE id=?`).run(good,call.runId)
  }
  repository.updateManagedAgentRun({id:call.runId,status:'completed'})
  assert.equal(resources.claimMcpCall({id:call.id,expectedRevision:0,decision:'approve',now:new Date().toISOString()}).status,'executing')
  const revoked=pending(repository,'call.revoked')
  sql(repository).prepare('DELETE FROM agent_assistant_bindings WHERE assistant_id=?').run(revoked.assistantId)
  assert.throws(()=>resources.claimMcpCall({id:revoked.id,expectedRevision:0,decision:'approve',now:new Date().toISOString()}),/changed/)
})
