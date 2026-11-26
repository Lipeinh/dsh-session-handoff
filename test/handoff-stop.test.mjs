/**
 * dsh-session-handoff 自包含回归测试（重点：交接后终止原会话）。
 *
 * 为什么需要沙箱：真实的 `@deepseek-ai/dsh-llm` / `dsh-tools` 被打包在 DSH 的
 * `app.asar` 里，普通 Node 解析不到。这里把**本仓库的插件源码**复制进一个临时沙箱，
 * 再放上两个模块的最小替身，于是用一条 `node` 命令就能跑完，不依赖已安装的 DSH。
 *
 * 三层检查：
 *   A. 单元   —— 直接驱动 stopSessionWork 的每个分支
 *   B. 端到端 —— 真的 apply() 挂起插件，走 /api/handoff/run 触发交接，
 *                逐项核对原会话收到的 cancel 参数
 *   C. 契约   —— handoff_now 的输出 schema 与渲染文案
 *
 * 用法：node test/handoff-stop.test.mjs
 * 退出码 0 = 全过。
 */
import { pathToFileURL, fileURLToPath } from 'node:url'
import { mkdirSync, writeFileSync, copyFileSync, rmSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = join(here, '..')                 // 仓库根
const SANDBOX = join(here, '.sandbox')

let failures = 0
const check = (label, ok, detail) => {
  if (ok) console.log('PASS ' + label)
  else { failures += 1; console.log('FAIL ' + label + (detail === undefined ? '' : ' :: ' + detail)) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 把仓库源码搬进临时沙箱，配上最小替身，返回入口路径。 */
function buildSandbox() {
  const entry = join(ROOT, 'lib/index.js')
  if (!existsSync(entry)) {
    console.error('找不到插件入口：' + entry)
    process.exit(2)
  }
  rmSync(SANDBOX, { recursive: true, force: true })

  // 插件本体（连 package.json 一起，保证 exports/type 与真实安装一致）
  const pkgDir = join(SANDBOX, 'node_modules/dsh-session-handoff')
  mkdirSync(join(pkgDir, 'lib'), { recursive: true })
  copyFileSync(entry, join(pkgDir, 'lib/index.js'))
  copyFileSync(join(ROOT, 'package.json'), join(pkgDir, 'package.json'))

  // 替身：@deepseek-ai/dsh-llm —— 插件只用到 createUserMessage
  const llm = join(SANDBOX, 'node_modules/@deepseek-ai/dsh-llm')
  mkdirSync(llm, { recursive: true })
  writeFileSync(join(llm, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-llm', version: '0.0.0-stub', type: 'module',
    main: 'index.js', exports: { '.': './index.js' },
  }, null, 2))
  writeFileSync(join(llm, 'index.js'), [
    '/** 测试替身：插件只用到 createUserMessage。 */',
    'export function createUserMessage(input) {',
    "  return { id: 'msg-stub', role: 'user', content: input.content, source: input.source }",
    '}',
  ].join('\n'))

  // 替身：@deepseek-ai/dsh-tools —— 插件只用到 defineTool
  const tools = join(SANDBOX, 'node_modules/@deepseek-ai/dsh-tools')
  mkdirSync(tools, { recursive: true })
  writeFileSync(join(tools, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-tools', version: '0.0.0-stub', type: 'module',
    main: 'index.js', exports: { '.': './index.js' },
  }, null, 2))
  writeFileSync(join(tools, 'index.js'), [
    '/** 测试替身：defineTool 原样返回定义。 */',
    'export function defineTool(options) { return options }',
  ].join('\n'))

  return join(pkgDir, 'lib/index.js')
}

const mod = await import(pathToFileURL(buildSandbox()).href)

// ── A. 单元：stopSessionWork 各分支 ──────────────────────────────────────
console.log('\n── A. stopSessionWork 分支 ──')
check('导出 stopSessionWork', typeof mod.stopSessionWork === 'function')
check('导出 handoffToolOptions', typeof mod.handoffToolOptions === 'function')

const CFG = { stopOldSession: true, stopDelayMs: 0 }
const mkState = () => ({ timers: new Set() })
const makeCtx = (agent, timeoutImpl) => ({
  agents: { get: (id) => (agent && agent.id === id ? agent : undefined) },
  logger: { info() {}, warn() {} },
  ...(timeoutImpl ? { timeout: timeoutImpl } : {}),
})

// A1 运行中 → 必须 cancel，cause={kind:'user'}，keepInbox=false
{
  let seen = null
  const agent = { id: 's1', status: 'running', inbox: { nextTurn: [], nextStep: [] }, cancel(c, o) { seen = { c, o } } }
  const state = mkState()
  const r = mod.stopSessionWork(makeCtx(agent), state, 's1', CFG)
  check('A1 运行中 → canceled', r.status === 'canceled' && r.requested === true, JSON.stringify(r))
  await sleep(20)
  check('A1 cancel 被调用', seen !== null)
  check("A1 cause.kind = 'user'", seen !== null && seen.c && seen.c.kind === 'user', JSON.stringify(seen && seen.c))
  check('A1 keepInbox = false（否则会再开一回合）', seen && seen.o.keepInbox === false, JSON.stringify(seen && seen.o))
  check('A1 计时器已自清', state.timers.size === 0, String(state.timers.size))
}

// A2 空闲且队列空 → 不按停止
{
  let n = 0
  const agent = { id: 's2', status: 'idle', inbox: { nextTurn: [], nextStep: [] }, cancel() { n += 1 } }
  const r = mod.stopSessionWork(makeCtx(agent), mkState(), 's2', CFG)
  await sleep(20)
  check('A2 空闲 → idle 且不 cancel', r.status === 'idle' && n === 0, r.status + '/' + n)
}

// A3 空闲但队列有货 → 仍要停（否则残留输入会再开一回合）
{
  let n = 0
  const agent = { id: 's3', status: 'idle', inbox: { nextTurn: [{ id: 'm' }], nextStep: [] }, cancel() { n += 1 } }
  const r = mod.stopSessionWork(makeCtx(agent), mkState(), 's3', CFG)
  await sleep(20)
  check('A3 空闲+待发输入 → 要终止', r.status === 'canceled' && n === 1, r.status + '/' + n)
}

// A4 冷会话（不在活跃表）
{
  const r = mod.stopSessionWork(makeCtx(null), mkState(), 's4', CFG)
  check('A4 冷会话 → not-live', r.status === 'not-live' && r.requested === false, JSON.stringify(r))
}

// A5 配置关闭
{
  let n = 0
  const agent = { id: 's5', status: 'running', inbox: { nextTurn: [], nextStep: [] }, cancel() { n += 1 } }
  const r = mod.stopSessionWork(makeCtx(agent), mkState(), 's5', { stopOldSession: false, stopDelayMs: 0 })
  await sleep(20)
  check('A5 stopOldSession=false → disabled 且不 cancel', r.status === 'disabled' && n === 0, r.status + '/' + n)
}

// A6 ctx.timeout 路径：跑完自摘句柄
{
  let n = 0
  const agent = { id: 's6', status: 'running', inbox: { nextTurn: [], nextStep: [] }, cancel() { n += 1 } }
  const ctx = makeCtx(agent, (cb, d) => { const t = setTimeout(cb, d); return () => clearTimeout(t) })
  const state = mkState()
  const r = mod.stopSessionWork(ctx, state, 's6', { stopOldSession: true, stopDelayMs: 5 })
  check('A6 ctx.timeout 路径 → canceled', r.status === 'canceled', JSON.stringify(r))
  check('A6 已登记句柄', state.timers.size === 1, String(state.timers.size))
  await sleep(40)
  check('A6 cancel 被调用', n === 1, String(n))
  check('A6 跑完自摘句柄', state.timers.size === 0, String(state.timers.size))
}

// A7 插件卸载时，未到点的停止要被清掉
{
  let n = 0
  const agent = { id: 's7', status: 'running', inbox: { nextTurn: [], nextStep: [] }, cancel() { n += 1 } }
  const ctx = makeCtx(agent, (cb, d) => { const t = setTimeout(cb, d); return () => clearTimeout(t) })
  const state = mkState()
  mod.stopSessionWork(ctx, state, 's7', { stopOldSession: true, stopDelayMs: 50 })
  for (const clear of state.timers) clear()   // 模拟 ctx.effect 卸载清理
  state.timers.clear()
  await sleep(80)
  check('A7 卸载后不再 cancel', n === 0, String(n))
}

// ── B. 端到端：apply() + HTTP 路由 ───────────────────────────────────────
console.log('\n── B. 端到端（apply + /api/handoff/run） ──')
const events = [
  { type: 'turn/start', data: { turn: 1 } },
  { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '把 A 改成 B' }] } },
  { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: '改到一半' }] } } },
]
const oldSession = { id: 'session-old', header: { id: 'session-old', cwd: 'C:/work' }, snapshotEvents: () => events }
let cancelCalls = []
const oldAgent = {
  id: 'session-old', session: oldSession, status: 'running',
  inbox: { nextTurn: [{ id: 'm9' }], nextStep: [] },
  cancel(cause, options) { cancelCalls.push({ cause, options }) },
}
const routes = new Map()
const logs = []
const ctx = {
  logger: { info: (m) => logs.push('I ' + m), warn: (m) => logs.push('W ' + m) },
  timeout(cb, delay) { const t = setTimeout(cb, delay); return () => clearTimeout(t) },
  effect(setup) { return setup() },
  on() { return () => {} },
  agents: {
    get: (id) => (id === 'session-old' ? oldAgent : undefined),
    list: () => [oldAgent],
    create: async (o) => ({ agent: { session: { id: o.sessionId }, followup() {} }, dispose: async () => {} }),
  },
  agentPresets: { resolve: async () => ({ id: 'default' }), mount: async () => ({}) },
  permissionPresets: { defaultPreset: 'default', resolve() {}, set() {} },
  agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
  sessionTitle: { get: () => ({ title: '原会话' }), rename() {} },
  workspaceRegistry: { create: async () => ({ path: 'C:/work', attachSession: async () => {}, detachSession: async () => {} }) },
  sessionProjections: { stateOf: () => undefined },
  connection: { fetch: { register(r) { routes.set(r.path + ' ' + r.methods.join(','), r) } } },
  tools: { register() {} },
}

await mod.apply(ctx, { stopOldSession: true, stopDelayMs: 10 })

const runRoute = [...routes.entries()].find(([k]) => k.startsWith('/api/handoff/run'))
check('B 注册了 /api/handoff/run', runRoute !== undefined, [...routes.keys()].join(' | '))

if (runRoute) {
  const res = await runRoute[1].fetch(new Request('http://x/api/handoff/run', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 'session-old', reason: 'e2e' }),
  }))
  const body = await res.json()
  check('B HTTP 200', res.status === 200, String(res.status) + ' ' + JSON.stringify(body).slice(0, 200))
  check('B 建了新会话', typeof body.newSessionId === 'string' && body.newSessionId.startsWith('session-'), JSON.stringify(body.newSessionId))
  check('B 结果报告已终止', body.stopped && body.stopped.status === 'canceled', JSON.stringify(body.stopped))
  await sleep(60)
  check('B 原会话 cancel 真的被调用', cancelCalls.length === 1, String(cancelCalls.length))
  check("B cause.kind = 'user'", cancelCalls[0] && cancelCalls[0].cause.kind === 'user', JSON.stringify(cancelCalls[0]))
  check('B keepInbox = false', cancelCalls[0] && cancelCalls[0].options.keepInbox === false, JSON.stringify(cancelCalls[0]))

  const statusRoute = [...routes.entries()].find(([k]) => k.startsWith('/api/handoff/status'))
  const status = await (await statusRoute[1].fetch(new Request('http://x/api/handoff/status'))).json()
  check('B status.stops = 1', status.stops === 1, String(status.stops))
  check('B lastResult 带 stopped', status.lastResult && status.lastResult.stopped
    && status.lastResult.stopped.status === 'canceled', JSON.stringify(status.lastResult && status.lastResult.stopped))

  // dryRun 绝不能终止原会话
  cancelCalls = []
  const dry = await (await runRoute[1].fetch(new Request('http://x/api/handoff/run', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 'session-old', dryRun: true, reason: 'dry' }),
  }))).json()
  await sleep(60)
  check('B dryRun 不终止原会话', cancelCalls.length === 0, String(cancelCalls.length))
  check('B dryRun 结果不含终止', !dry.stopped || dry.stopped.status !== 'canceled', JSON.stringify(dry.stopped))
}

// ── C. handoff_now 输出契约 ──────────────────────────────────────────────
console.log('\n── C. handoff_now 输出契约 ──')
{
  const props = mod.handoffToolOptions(async () => ({ ok: true })).output.schema.properties
  check('C 声明 stopped', props.stopped !== undefined && props.stopped.required === true)
  check('C 声明 stopError', props.stopError !== undefined && props.stopError.required === true)

  // failed 分支：必须如实上报，不能谎称已终止
  const tool = mod.handoffToolOptions(async () => ({
    ok: true, dryRun: false, newSessionId: 'session-n', newTitle: '会话交接（接 10-00）',
    filePath: 'D:/x/包.md', stopped: { status: 'failed', requested: false, error: 'boom' },
  }))
  const out = await tool.execute({}, { agent: { session: { id: 's' } } })
  check('C failed 如实上报', out.stopped === 'failed', out.stopped)
  check('C 带出 stopError', out.stopError === 'boom', out.stopError)
  const text = tool.output.render({}, out)[0].text
  check('C 渲染说明终止失败', text.includes('终止失败') && text.includes('boom'), text)
  check('C 不谎称已终止', !text.includes('原会话已终止'), text)

  // canceled 分支：应当明确说已终止
  const okTool = mod.handoffToolOptions(async () => ({
    ok: true, dryRun: false, newSessionId: 'session-n', newTitle: 'T', filePath: 'f',
    stopped: { status: 'canceled', requested: true },
  }))
  const okOut = await okTool.execute({}, { agent: { session: { id: 's' } } })
  check('C canceled → stopError 为空', okOut.stopError === '', JSON.stringify(okOut.stopError))
  check('C canceled 渲染声明已终止', okTool.output.render({}, okOut)[0].text.includes('原会话已终止'))
}

rmSync(SANDBOX, { recursive: true, force: true })

console.log('\n' + (failures === 0 ? 'ALL PASS' : failures + ' FAILURES'))
if (failures !== 0) console.log('--- logs ---\n' + logs.join('\n'))
process.exit(failures === 0 ? 0 : 1)
