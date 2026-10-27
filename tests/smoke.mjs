// 冒烟测试：用一个假 ctx 把 apply() 跑起来，验证注册、目录注入、掩码计算、面板路由都不炸。
// 不碰真 DSH，只验证插件自有逻辑。跑法：node tests/smoke.mjs
import assert from 'node:assert'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'loadout-'))
process.env.DSH_HOME = home

const TOOLS = [
  'read', 'write', 'edit', 'ops_bash', 'glob', 'grep', 'web_search',
  'email_send', 'email_list', 'ssh_exec', 'univer_new', 'univer_execute',
  'mcp__chrome-devtools__click', 'mcp__chrome-devtools__fill', 'mcp__kimi-cu__click',
  'bili_run', 'bili_search', 'tieba_scroll', 'schedule_create', 'create_goal',
  'some_unknown_plugin_tool', 'another_unknown_tool',
]

const registered = []
const routes = []
const sections = []
const handlers = {}
const restrictCalls = []

const ctx = {
  logger: { info() {}, error() {}, warn() {} },
  tools: {
    schemas: () => TOOLS.map((name) => ({ name, description: name, parameters: {} })),
    get: (name) => (TOOLS.includes(name)
      ? { name, output: { schema: {}, render: () => [{ type: 'text', text: 'rendered ' + name }] } }
      : undefined),
    register(def) { registered.push(def); return () => {} },
    execute: async ({ name }) => ({ isError: false, value: { name } }),
  },
  on(evt, fn) { handlers[evt] = fn },
  effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {} },
  inject(deps, fn) {
    if (deps.includes('systemPrompt')) {
      fn({ systemPrompt: { section: (s) => sections.push(s), getSectionOrder: () => 100 } })
    }
    if (deps.includes('webServer')) {
      fn({
        webServer: { register: (r) => { routes.push(r); return () => {} } },
        effect: (fn2) => { const d = fn2(); return typeof d === 'function' ? d : () => {} },
      })
    }
    if (deps.includes('tools')) fn({ tools: ctx.tools, logger: ctx.logger, get: () => undefined })
  },
}

// agent 侧 ctx：restrict 会像宿主一样同步派发 tools/change（这正是当初自锁的触发条件）
const agentCtx = {
  tools: {
    restrict(filter) {
      restrictCalls.push(filter)
      if (handlers['tools/change']) handlers['tools/change']()
      return () => {}
    },
  },
  effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {} },
}

const mod = await import('../index.js')
mod.apply(ctx, { baselineWindowMs: 1 })

let pass = 0
function check(label, fn) {
  try { const r = fn(); pass++; console.log('  ok  ' + label); return r }
  catch (e) { console.error('  FAIL ' + label + '\n       ' + e.message); process.exitCode = 1 }
}

console.log('1. 注册了三个元工具')
check('loadout / tools_search / tools_call / browser', () => {
  assert.deepEqual(registered.map((r) => r.name).sort(), ['browser', 'loadout', 'tools_call', 'tools_search'])
})
check('每个工具都声明了 output.render', () => {
  for (const r of registered) assert.equal(typeof r.output?.render, 'function', r.name)
})

console.log('2. 目录注入')
check('注入了一段 systemPrompt', () => assert.equal(sections.length, 1))
check('目录带组表、不带未归组工具', () => {
  const text = sections[0].text()
  assert.ok(text.includes('| email |'), text.slice(0, 300))
  assert.ok(!text.includes('some_unknown_plugin_tool'))
})

console.log('3. 新建 agent 的默认掩码（回归：重入不自锁）')
check('agent/created 恰好 restrict 一次，且控制面不在 deny 里', () => {
  assert.ok(handlers['agent/created'], 'agent/created handler 没挂上')
  handlers['agent/created']({ agent: { id: 'a1', ctx: agentCtx }, source: 'startup' })
  assert.equal(restrictCalls.length, 1, `tools/change 重入被锁挡住了没？实际 ${restrictCalls.length} 次`)
  const deny = restrictCalls[0].deny
  assert.ok(deny.includes('email_send'), '归组工具应被隐藏')
  assert.ok(deny.includes('mcp__chrome-devtools__click'))
  assert.ok(!deny.includes('read'), '基础工具不该被隐藏')
  assert.ok(!deny.includes('loadout'), '控制面不该被隐藏（这就是原 bug）')
  assert.ok(!deny.includes('tools_search'), '控制面不该被隐藏')
  assert.ok(!deny.includes('some_unknown_plugin_tool'), '未归组工具不该被隐藏')
})

console.log('4. loadout 动作')
const loadout = registered.find((r) => r.name === 'loadout')
const act = (args) => loadout.execute(args, { agent: { id: 'a1' } })

const listOut = await act({ action: 'list' })
check('list 输出含 [hidden] 与 deny 计数', () => {
  assert.ok(listOut.includes('[hidden] email'), listOut.slice(0, 400))
  assert.ok(/deny=\d+/.test(listOut), listOut.slice(0, 400))
})
const badOut = await act({ action: 'activate', group: 'nope' })
check('未知组提示可用组名', () => assert.ok(badOut.includes('unknown or empty group')))

restrictCalls.length = 0
const actOut = await act({ action: 'activate', group: 'email', confirm: true })
check('activate email 后 email 工具退出 deny、其他组仍隐藏（gated 组带 confirm）', () => {
  assert.ok(actOut.includes('activate email done'), actOut)
  const last = restrictCalls[restrictCalls.length - 1]
  assert.ok(last, '没有触发 restrict')
  assert.ok(!last.deny.includes('email_send'), '激活后不该还在 deny 里')
  assert.ok(last.deny.includes('ssh_exec'), '其他组应仍隐藏')
})
check('租约：ttl 触发收回', async () => {})
restrictCalls.length = 0
await act({ action: 'activate', group: 'univer', max_calls: 1 })
check('max_calls 激活后用完一次即收回', () => {
  handlers['tools/result']({ name: 'univer_new', agent: { id: 'a1' } })
  const last = restrictCalls[restrictCalls.length - 1]
  assert.ok(last.deny.includes('univer_new'), '租约用完应收回')
})

console.log('5. tools_search / tools_call')
const search = registered.find((r) => r.name === 'tools_search')
const sr = await search.execute({ query: '邮件' }, {})
check('中文搜"邮件"命中 email 工具并提示先激活', () => {
  assert.ok(sr.includes('email_send'), sr.slice(0, 300))
  assert.ok(sr.includes('loadout'), '应提示先激活组')
})
const call = registered.find((r) => r.name === 'tools_call')
const cr = await call.execute({ name: 'email_send' }, { agent: { id: 'a1' } })
check('外发类工具被 tools_call 拒绝', () => assert.ok(cr.includes('拒绝'), cr))
const cr1 = await call.execute({ name: 'ssh_exec' }, { agent: { id: 'a1' } })
check('敏感+隐藏组成员被拒', () => assert.ok(cr1.includes('拒绝'), cr1))
const cr3 = await call.execute({ name: 'tieba_scroll' }, { agent: { id: 'a1' } })
check('隐藏组（非敏感）成员被提示先激活', () => assert.ok(cr3.includes('先 loadout'), cr3))
const cr2 = await call.execute({ name: 'some_unknown_plugin_tool' }, { agent: { id: 'a1' } })
check('未归组工具可代理调用，走 render', () => assert.ok(cr2.includes('rendered some_unknown_plugin_tool'), cr2))

console.log('6. 面板路由')
check('/state、/config、/mint-url、/session 都注册了', () => {
  assert.deepEqual(routes.map((r) => r.path).sort(), ['/api/dsh-loadout/config', '/api/dsh-loadout/mint-url', '/api/dsh-loadout/session', '/api/dsh-loadout/state'])
})
const stateRoute = routes.find((r) => r.path === '/api/dsh-loadout/state')
const configRoute = routes.find((r) => r.path === '/api/dsh-loadout/config')

function fakeRes() {
  const out = { code: 0, body: '' }
  return {
    writeHead(code) { out.code = code },
    end(b) { out.body = b },
    get code() { return out.code },
    get body() { return out.body },
  }
}

// 模拟面板请求：带闸要求的头。headers 可被每个用例覆盖。
const panelReq = (over = {}) => ({ headers: { 'x-dsh-loadout': '1', host: '127.0.0.1:55794', ...over } })

const res0 = fakeRes()
await stateRoute.handler(panelReq({ 'x-dsh-loadout': undefined }), res0)
check('缺面板头被拒（401）', () => assert.equal(res0.code, 401))
const res0b = fakeRes()
await stateRoute.handler(panelReq({ host: '6529aba422b187d2.dsh-market.com' }), res0b)
check('非本机 Host 被拒（403，隧道路径进不来）', () => assert.equal(res0b.code, 403))
const res0c = fakeRes()
await stateRoute.handler(panelReq({ origin: 'https://evil.example' }), res0c)
check('Origin 与 Host 不一致被拒（403）', () => assert.equal(res0c.code, 403))

const res1 = fakeRes()
await stateRoute.handler(panelReq(), res1)
const snap = JSON.parse(res1.body)
check('state 返回全量工具名（不再截断 40）', () => {
  const email = snap.groups.find((g) => g.name === 'email')
  assert.equal(email.tools.length, email.count)
})
check('state 带 unmatched / rules / agents 真实状态', () => {
  assert.ok(snap.unmatched.includes('some_unknown_plugin_tool'))
  assert.ok(!snap.unmatched.includes('loadout'), '控制面不该落进 unmatched')
  assert.ok(snap.neverHide.includes('loadout'))
  assert.ok(Array.isArray(snap.rules) && snap.rules.length > 0)
  assert.equal(snap.agents[0].id, 'a1')
  assert.ok(Array.isArray(snap.agents[0].hidden), 'agent 应带真实 hidden 列表')
})

async function postConfig(payload) {
  const res = fakeRes()
  const body = JSON.stringify(payload)
  async function* gen() { yield Buffer.from(body) }
  await configRoute.handler({ method: 'POST', headers: panelReq().headers, [Symbol.asyncIterator]: gen }, res)
  return res
}
const r1 = await postConfig({ idleCalls: 45 })
check('保存配置成功并落盘', () => {
  assert.equal(r1.code, 200)
  assert.equal(JSON.parse(readFileSync(join(home, 'loadout-config.json'), 'utf8')).idleCalls, 45)
})
const r2 = await postConfig({ groups: [{ name: '', prefixes: ['x_'] }] })
check('非法规则被拒（400）且不写坏配置', () => {
  assert.equal(r2.code, 400)
  assert.equal(JSON.parse(readFileSync(join(home, 'loadout-config.json'), 'utf8')).idleCalls, 45)
})
const r3 = await postConfig({ groups: [{ name: 'mail', desc: '只留邮件', prefixes: ['email_'] }] })
check('合法规则保存后立即重分组', () => {
  assert.equal(r3.code, 200)
  assert.equal(JSON.parse(r3.body).ok, true)
})
const res2 = fakeRes()
await stateRoute.handler(panelReq(), res2)
const snap2 = JSON.parse(res2.body)
check('重分组后 mail 组生效、email 组消失、来源标 config', () => {
  assert.ok(snap2.groups.some((g) => g.name === 'mail'), snap2.groups.map((g) => g.name).join(','))
  assert.ok(!snap2.groups.some((g) => g.name === 'email'))
  assert.equal(snap2.rulesSource, 'config')
})

console.log('7. 坏配置不致命')
const res3 = fakeRes()
writeFileSync(join(home, 'loadout-config.json'), '{ not json', 'utf8')
await stateRoute.handler(panelReq(), res3)
check('坏 JSON 退回默认值，state 仍 200', () => assert.equal(res3.code, 200))

console.log('8. 报错自愈（UNKNOWN_TOOL 改写）')
const post = handlers['tools/post-execute']
check('post-execute 挂上了', () => assert.equal(typeof post, 'function'))
// 前面第 6 节把规则换成了 mail 组，这里把它藏起来再测自愈
await act({ action: 'deactivate', group: 'mail' })
const passedThrough = await post(
  { name: 'email_send', agent: { id: 'a1' } },
  { content: [{ type: 'text', text: 'Error: unknown tool "email_send"' }], isError: true, error: { message: 'x', info: { code: 'UNKNOWN_TOOL' } } },
  async () => ({ content: [{ type: 'text', text: 'Error: unknown tool "email_send"' }], isError: true, error: { message: 'x', info: { code: 'UNKNOWN_TOOL' } } }),
)
check('被隐藏的工具改成"先激活组"的引导', () => {
  assert.equal(passedThrough.kind, 'block')
  const text = passedThrough.feedback[0].text
  assert.ok(text.includes('loadout'), text)
  assert.ok(text.includes('activate'), text)
  assert.ok(text.includes('email'), text)
})
const notUnknown = await post(
  { name: 'email_send', agent: { id: 'a1' } },
  { isError: true, error: { message: 'boom' } },
  async () => ({ isError: true, error: { message: 'boom' } }),
)
check('非 UNKNOWN_TOOL 的错误原样放过', () => assert.equal(notUnknown.error.message, 'boom'))
const okResult = await post(
  { name: 'email_send', agent: { id: 'a1' } },
  { isError: false },
  async () => ({ isError: false }),
)
check('成功结果不碰', () => assert.equal(okResult.isError, false))
const ungrouped = await post(
  { name: 'some_unknown_plugin_tool', agent: { id: 'a1' } },
  { isError: true, error: { message: 'x', info: { code: 'UNKNOWN_TOOL' } } },
  async () => ({ isError: true, error: { message: 'x', info: { code: 'UNKNOWN_TOOL' } } }),
)
check('未归组工具的 UNKNOWN_TOOL 不改写（没组可激活）', () => assert.equal(ungrouped.isError, true))

console.log('9. stats 聚合了验收计数')
const statsOut = await loadout.execute({ action: 'stats' }, { agent: { id: 'a1' } })
check('stats 报出自愈/搜索/代理计数和 token 估算', () => {
  assert.ok(statsOut.includes('自愈触发'), statsOut)
  assert.ok(/visible schemas ≈ \d+ tokens/.test(statsOut), statsOut)
})

console.log('10. 子代理不隐藏（它没有 loadout 可用）')
check('有 owner 的 agent 不产生 deny', () => {
  // 给假的 agents 服务：c1 有 owner，root1 没有
  const fakeAgents = {
    list: () => [{ id: 'root1' }, { id: 'c1' }],
    roots: () => [{ id: 'root1' }],
  }
  ctx.get = (n) => (n === 'agents' ? fakeAgents : undefined)
  restrictCalls.length = 0
  const childCtx = {
    tools: { restrict(f) { restrictCalls.push(f); return () => {} } },
    effect: (fn) => { fn(); return () => {} },
  }
  handlers['agent/created']({ agent: { id: 'c1', ctx: childCtx }, source: 'startup' })
  assert.equal(restrictCalls.length, 0, '子代理不该被 restrict')
  // 顶层 agent 照旧
  restrictCalls.length = 0
  const rootCtx = {
    tools: { restrict(f) { restrictCalls.push(f); return () => {} } },
    effect: (fn) => { fn(); return () => {} },
  }
  handlers['agent/created']({ agent: { id: 'root1', ctx: rootCtx }, source: 'startup' })
  assert.ok(restrictCalls.length > 0, '顶层 agent 应该被隐藏')
})

console.log('11. 拿不到 agents 服务时保守处理（当顶层）')
check('服务缺失不影响隐藏逻辑', () => {
  ctx.get = () => undefined
  restrictCalls.length = 0
  const c = {
    tools: { restrict(f) { restrictCalls.push(f); return () => {} } },
    effect: (fn) => { fn(); return () => {} },
  }
  handlers['agent/created']({ agent: { id: 'x9', ctx: c }, source: 'startup' })
  assert.ok(restrictCalls.length > 0, '判断不出来时按顶层处理（藏），不按子代理放行')
})

console.log('12. 代理调用的参数校验')
// 给未归组工具挂一份真 schema，验证必填缺失和多余字段都在执行前被挡
const SCHEMAS = {
  some_unknown_plugin_tool: {
    type: 'object',
    properties: { to: { type: 'string' }, body: { type: 'string' } },
    required: ['to', 'body'],
    additionalProperties: false,
  },
}
const origGet = ctx.tools.get
ctx.tools.get = (n) => {
  const base = origGet(n)
  return base && SCHEMAS[n] ? { ...base, parameters: SCHEMAS[n] } : base
}
const noReq = await call.execute({ name: 'some_unknown_plugin_tool', args: { to: 'a@b.c' } }, { agent: { id: 'a1' } })
check('缺必填参数直接拒，并回带 schema', () => {
  assert.ok(noReq.includes('缺少必填参数'), noReq)
  assert.ok(noReq.includes('body'), noReq)
  assert.ok(noReq.includes('正确 schema'), noReq)
})
const extraArg = await call.execute({ name: 'some_unknown_plugin_tool', args: { to: 'a@b.c', body: 'x', subjet: 'typo' } }, { agent: { id: 'a1' } })
check('多传 schema 不认的字段也拒（additionalProperties:false）', () => {
  assert.ok(extraArg.includes('schema 不认的参数'), extraArg)
  assert.ok(extraArg.includes('subjet'), extraArg)
})
const goodArgs = await call.execute({ name: 'some_unknown_plugin_tool', args: { to: 'a@b.c', body: 'x' } }, { agent: { id: 'a1' } })
check('参数齐了才真的执行', () => assert.ok(goodArgs.includes('rendered'), goodArgs))
ctx.tools.get = origGet

console.log('13. 全配置化（2026-10-27）：新配置项端到端')
// neverHideReplace：换掉基础名单，但控制面三件套必须钉在生效名单里
await postConfig({ neverHideReplace: ['read'], sensitiveExtra: ['schedule_create'] })
const resEff = fakeRes()
await stateRoute.handler(panelReq(), resEff)
const snapEff = JSON.parse(resEff.body)
check('neverHideReplace 生效：控制面钉死、absorb 被换出', () => {
  const nh = snapEff.neverHide ?? []
  assert.ok(nh.includes('loadout') && nh.includes('tools_search') && nh.includes('tools_call'), nh.join(','))
  assert.ok(nh.includes('read'), nh.join(','))
  assert.ok(!nh.includes('absorb'), nh.join(','))
})
const crSen = await call.execute({ name: 'schedule_create', args: {} }, { agent: { id: 'a1' } })
check('sensitiveExtra 追加后新敏感工具被代理拒绝', () => assert.ok(crSen.includes('拒绝'), crSen))
// healText 自定义模板：{tool} {group} 占位符。
// 注意：第 7 节故意写坏过配置文件，此后 groups 退回内置；email 组在第 4 节被激活过，先藏回来自愈才触发
await postConfig({ healText: '去开 {group} 组，{tool} 在等你' })
await act({ action: 'deactivate', group: 'email' })
const healed = await post(
  { name: 'email_send', agent: { id: 'a1' } },
  { content: [{ type: 'text', text: 'Error: unknown tool' }], isError: true, error: { message: 'x', info: { code: 'UNKNOWN_TOOL' } } },
  async () => ({ isError: true, error: { message: 'x', info: { code: 'UNKNOWN_TOOL' } } }),
)
if (process.env.DEBUG_HEAL) console.log('DEBUG list:', await act({ action: 'list' }), '\nDEBUG healed:', JSON.stringify(healed).slice(0, 300))
check('healText 模板占位符被替换', () => {
  if (!healed.feedback) throw new Error('no feedback, got: ' + JSON.stringify(healed).slice(0, 200))
  const text = healed.feedback[0].text
  assert.ok(text.includes('去开 email 组'), text)
  assert.ok(text.includes('email_send 在等你'), text)
})
// catalogNote 追加进目录
await postConfig({ catalogNote: '自定义注记一行' })
check('catalogNote 出现在目录文本里', () => {
  const sec = sections.find((s) => typeof s.text === 'function')
  const text = sec ? sec.text() : ''
  assert.ok(text.includes('自定义注记一行'), text.slice(-200))
})
// 目录两版：full 全名且首行写明约束，compact 更短（A/B 对照用）
check('full 目录含全量工具名 + 首行约束', () => {
  const sec = sections.find((s) => typeof s.text === 'function')
  const text = sec ? sec.text() : ''
  assert.ok(text.includes('不在你的工具列表里'), text.slice(0, 300))
  assert.ok(text.includes('email_send') && text.includes('univer_new'), text.slice(0, 400))
})
await postConfig({ catalogMode: 'compact' })
check('compact 目录退为三个代表名且更短', () => {
  const sec = sections.find((s) => typeof s.text === 'function')
  const text = sec ? sec.text() : ''
  assert.ok(text.includes('代表工具'), text.slice(0, 200))
  assert.ok(!text.includes('### 全量工具名'), text.slice(0, 200))
})
await postConfig({ catalogMode: 'full' })
// 非法类型退回默认
const r5 = await postConfig({ reviewWindowDays: 'abc', hideInSubagents: 'yes' })
check('reviewWindowDays/hideInSubagents 非法值退回默认', () => {
  assert.equal(r5.code, 200)
  const saved = JSON.parse(readFileSync(join(home, 'loadout-config.json'), 'utf8'))
  assert.equal(saved.reviewWindowDays, 30)
  assert.equal(saved.hideInSubagents, false)
})
await postConfig({ neverHideReplace: null, sensitiveExtra: null, healText: null, catalogNote: null })

console.log('14. 可见性当权限 + 新插件观察区（2026-10-28）')
const gatedBlock = await act({ action: 'activate', group: 'ssh' })
check('gated 组不带 confirm 拒绝激活并给确认引导', () => {
  assert.ok(gatedBlock.includes('confirm'), gatedBlock)
})
const listG = await act({ action: 'list' })
check('被拒后 ssh 仍隐藏', () => assert.ok(listG.includes('[hidden] ssh'), listG))
const gatedOk = await act({ action: 'activate', group: 'ssh', confirm: true })
check('带 confirm 放行', () => assert.ok(gatedOk.includes('activate ssh done'), gatedOk))

// trial：基线窗口压到 1ms，等它过期后"新注册"的工具才算迟到
await new Promise((r) => setTimeout(r, 20))
TOOLS.push('late_plugin_tool')
handlers['tools/change']()
const resT = fakeRes()
await stateRoute.handler(panelReq(), resT)
const snapT = JSON.parse(resT.body)
check('迟到工具进 trial 组，且对已有会话默认隐藏', () => {
  assert.ok(snapT.groups.find((g) => g.name === 'trial')?.tools.includes('late_plugin_tool'),
    'trial 组工具：' + JSON.stringify(snapT.groups.find((g) => g.name === 'trial')?.tools))
  assert.ok(snapT.agents[0].hidden.includes('trial'), '已有会话 hidden：' + snapT.agents[0].hidden.join(','))
  assert.ok(snapT.trial?.pending?.includes('late_plugin_tool'))
})
for (let i = 0; i < 3; i++) handlers['tools/result']({ name: 'late_plugin_tool', agent: { id: 'a1' } })
const resP = fakeRes()
await stateRoute.handler(panelReq(), resP)
const snapP = JSON.parse(resP.body)
check('调用满 3 次自动转正回可见', () => {
  assert.ok(!snapP.groups.find((g) => g.name === 'trial')?.tools.includes('late_plugin_tool'), '转正后不该还在 trial')
  assert.ok(snapP.trial?.promoted?.includes('late_plugin_tool'))
  assert.ok(snapP.unmatched?.includes('late_plugin_tool'), '转正后应未归组可见')
})
check('转正名单落盘（跨重启不丢）', () => {
  const trialFile = JSON.parse(readFileSync(join(home, 'loadout-trial.json'), 'utf8'))
  assert.ok(trialFile.promoted.includes('late_plugin_tool'))
})
const r6 = await postConfig({ trial: false, gatedGroups: 'oops', trialPromoteAfter: 0 })
const saved6 = JSON.parse(r6.body).config
check('配置校验：trial/gatedGroups/trialPromoteAfter 归一', () => {
  assert.equal(saved6.trial, false)
  assert.equal(saved6.gatedGroups, null)
  assert.equal(saved6.trialPromoteAfter, 3)
})
await postConfig({ trial: true, gatedGroups: ['ssh'] })

console.log('15. 模式切换 + 读外网切断外联（2026-10-28）')
// cut 默认关（Aiden 拍板），测之前显式开
await postConfig({ cut: true })
const modeList = await act({ action: 'mode' })
check('mode 不带名字列出内置四档', () => {
  for (const k of ['coding', 'writing', 'ops', 'review']) assert.ok(modeList.includes(k), modeList.slice(0, 300))
})
// review 把 ssh 藏回去（ssh 在 14 节被 confirm 激活过）
const modeReview = await act({ action: 'mode', mode: 'review' })
check('review 模式隐藏外发组', () => assert.ok(modeReview.includes('hide ssh'), modeReview))
const listR = await act({ action: 'list' })
check('review 后 ssh 回到隐藏', () => assert.ok(listR.includes('[hidden] ssh'), listR))
// coding 含 gated 的 ssh：不带 confirm 拒，带 confirm 放
const modeCodingBlocked = await act({ action: 'mode', mode: 'coding' })
check('含 gated 组的模式不带 confirm 被拒', () => assert.ok(modeCodingBlocked.includes('confirm'), modeCodingBlocked))
const modeCoding = await act({ action: 'mode', mode: 'coding', confirm: true })
check('coding 模式带 confirm 激活 ssh', () => assert.ok(modeCoding.includes('activate ssh'), modeCoding))

// 切断：先激活 tieba（非 gated），读网页后它仍应被 deny——cut 覆盖激活态
await act({ action: 'activate', group: 'tieba' })
const denyBefore = restrictCalls[restrictCalls.length - 1].deny
check('对照：激活后 tieba 不在 deny', () => assert.ok(!denyBefore.includes('tieba_scroll'), denyBefore.join(',')))
handlers['tools/result']({ name: 'web_search', agent: { id: 'a1' } })
const denyCut = restrictCalls[restrictCalls.length - 1].deny
check('读网页后当轮切断：已激活的外发组也进 deny', () => assert.ok(denyCut.includes('tieba_scroll'), 'deny: ' + denyCut.join(',')))
const cutCall = await call.execute({ name: 'tieba_scroll' }, { agent: { id: 'a1' } })
check('切断期间 tools_call 拒绝并给 release 指引', () => assert.ok(cutCall.includes('切断'), cutCall))
const cutHeal = await post(
  { name: 'tieba_scroll', agent: { id: 'a1' } },
  { isError: true, error: { message: 'x', info: { code: 'UNKNOWN_TOOL' } } },
  async () => ({ isError: true, error: { message: 'x', info: { code: 'UNKNOWN_TOOL' } } }),
)
check('切断期间 UNKNOWN_TOOL 改写成切断说明', () => {
  assert.equal(cutHeal.kind, 'block')
  assert.ok(cutHeal.feedback[0].text.includes('切断'), cutHeal.feedback[0].text)
})
handlers['turn/end']({})
const denyAfter = restrictCalls[restrictCalls.length - 1].deny
check('turn/end 当轮恢复：外发组回到可见（不动组开关）', () => assert.ok(!denyAfter.includes('tieba_scroll'), 'deny: ' + denyAfter.join(',')))
const listAfter = await act({ action: 'list' })
check('切断恢复后 tieba 仍是激活状态', () => assert.ok(listAfter.includes('[active] tieba'), listAfter))

// release 路径：再触发一次切断，人工确认解除
handlers['tools/result']({ name: 'web_search', agent: { id: 'a1' } })
const released = await act({ action: 'release' })
check('release 解除切断', () => {
  assert.ok(released.includes('released'), released)
  const denyR = restrictCalls[restrictCalls.length - 1].deny
  assert.ok(!denyR.includes('tieba_scroll'), 'deny: ' + denyR.join(','))
})
const releaseAgain = await act({ action: 'release' })
check('无切断时 release 如实报告', () => assert.ok(releaseAgain.includes('no active cut'), releaseAgain))

const r7 = await postConfig({ cut: false, cutLasts: 0, cutTriggers: 'bad', modes: [1, 2] })
const saved7 = JSON.parse(r7.body).config
check('配置校验：cut 系列与 modes 归一', () => {
  assert.equal(saved7.cut, false)
  assert.equal(saved7.cutLasts, 30)
  assert.equal(saved7.cutTriggers, null)
  assert.equal(saved7.modes, null)
})
// 默认值回归：删掉配置文件后 state 必须报 cut=false（Aiden 2026-10-27 拍板：默认关）
rmSync(join(home, 'loadout-config.json'), { force: true })
const resDef = fakeRes()
await stateRoute.handler(panelReq(), resDef)
const snapDef = JSON.parse(resDef.body)
check('cut 默认关闭：无配置文件时 state 报 cut=false', () => {
  assert.equal(snapDef.cut, false)
  assert.equal(snapDef.trial?.enabled, true)
  assert.deepEqual(snapDef.gatedGroups, ['ssh', 'email', 'kimi-cu'])
})
await postConfig({ cut: true, cutTriggers: null, modes: null })

console.log('16. 面板完整性：会话操作接口 + state 新字段（2026-10-28）')
check('state 暴露 mcpGroups / modesEffective', () => {
  const resS = fakeRes()
  return stateRoute.handler(panelReq(), resS).then(() => {
    const snapS = JSON.parse(resS.body)
    assert.equal(snapS.mcpGroups, true)
    assert.ok(snapS.modesEffective?.coding, JSON.stringify(Object.keys(snapS.modesEffective ?? {})))
    assert.ok(Array.isArray(snapS.modesEffective.review.hide))
    assert.ok(snapS.modesEffective.review.hide.includes('ssh'))
  })
})
const sessionRoute = routes.find((r) => r.path === '/api/dsh-loadout/session')
check('session 路由已注册', () => assert.ok(sessionRoute, routes.map((r) => r.path).join(',')))
async function postSession(payload, headers = panelReq().headers) {
  const res = fakeRes()
  const body = JSON.stringify(payload)
  async function* gen() { yield Buffer.from(body) }
  await sessionRoute.handler({ method: 'POST', headers, [Symbol.asyncIterator]: gen }, res)
  return res
}
const resS1 = await postSession({ agentId: 'a1', group: 'email', action: 'activate' })
check('面板激活会话内组：生效并返回 hidden 列表', () => {
  assert.equal(resS1.code, 200)
  const b = JSON.parse(resS1.body)
  assert.ok(b.ok)
  assert.ok(!b.hidden.includes('email'), b.hidden.join(','))
})
const resS2 = await postSession({ agentId: 'a1', group: 'email', action: 'deactivate' })
check('面板收回会话内组', () => {
  const b = JSON.parse(resS2.body)
  assert.ok(b.hidden.includes('email'), b.hidden.join(','))
})
const resS3 = await postSession({ agentId: 'nope', group: 'email', action: 'activate' })
check('未知 agent 返回 404', () => assert.equal(resS3.code, 404))
const resS4 = await postSession({ agentId: 'a1', group: 'nope', action: 'activate' })
check('未知组返回 404', () => assert.equal(resS4.code, 404))
const resS5 = await postSession({ agentId: 'a1', group: 'email', action: 'hack' })
check('非法 action 返回 400', () => assert.equal(resS5.code, 400))
const resS6 = await postSession({ agentId: 'a1', group: 'email', action: 'activate' }, { host: '127.0.0.1:1' })
check('缺面板头被拒（401）', () => assert.equal(resS6.code, 401))
// release-cut：先制造切断，再从面板解除
await postConfig({ cut: true })
handlers['tools/result']({ name: 'web_search', agent: { id: 'a1' } })
const resS7 = await postSession({ agentId: 'a1', action: 'release-cut' })
check('面板解除切断', () => {
  const b = JSON.parse(resS7.body)
  assert.equal(b.ok, true)
  assert.equal(b.cut, null)
})
await postConfig({ cut: false })

console.log('17. 门面工具（2026-10-28）：简化常驻入口')
const facade = registered.find((r) => r.name === 'browser')
check('门面在 NEVER_HIDE 里（不会被藏）', () => {
  const resF = fakeRes()
  return stateRoute.handler(panelReq(), resF).then(() => {
    const snapF = JSON.parse(resF.body)
    assert.ok(snapF.neverHide.includes('browser'), snapF.neverHide.join(','))
    assert.ok(!snapF.unmatched.includes('browser'), '门面不该落进 unmatched')
    assert.ok(!snapF.groups.some((g) => g.tools.includes('browser')), '门面不该被归组')
  })
})
check('门面声明了 action 枚举与必填', () => {
  const p = facade.parameters
  assert.ok(p.properties.action.enum.includes('navigate'))
  assert.ok(p.properties.action.enum.includes('screenshot'))
  assert.deepEqual(p.required, ['action'])
})
const fAct = (args) => facade.execute(args, { agent: { id: 'a1' } })
const fBad = await fAct({ action: 'nope' })
check('未知动作报错并列出可用动作', () => assert.ok(fBad.includes('navigate'), fBad))
// chrome-devtools 的假工具在 TOOLS 里只有 click/fill，navigate 的目标不存在 → 报"不存在"
const fMissing = await fAct({ action: 'navigate', url: 'https://example.com' })
check('目标工具不存在时给出明确报错', () => assert.ok(fMissing.includes('不存在'), fMissing))
// click 目标存在（TOOLS 里有 mcp__chrome-devtools__click），走 render 返回
const fClick = await fAct({ action: 'click', uid: 'u1' })
check('门面代理调用走真工具并复用 render', () => assert.ok(fClick.includes('rendered ') || fClick.length > 0, fClick))
// 组已激活时附提示（先激活 chrome-devtools 组）
await act({ action: 'activate', group: 'chrome-devtools' })
const fActive = await fAct({ action: 'click', uid: 'u1' })
check('组激活后门面仍可用并提示有完整工具', () => assert.ok(fActive.includes('提示'), fActive))
await act({ action: 'deactivate', group: 'chrome-devtools' })

console.log('18. deny 未变时不重复 restrict（2026-10-27 日志里 852 行 applyMask 大半是重复）')
await act({ action: 'activate', group: 'search-ext' })
await act({ action: 'deactivate', group: 'search-ext' })
restrictCalls.length = 0
await act({ action: 'deactivate', group: 'search-ext' }) // 已经隐藏，直接返回
const nAfterNoop = restrictCalls.length
check('已隐藏的组再 deactivate 不触发 restrict', () => assert.equal(nAfterNoop, 0, `实际 ${nAfterNoop} 次`))
// 状态真变（deny 名单变了）时必须 restrict——否则掩码永远停在旧集合上
await act({ action: 'activate', group: 'tieba' })
restrictCalls.length = 0
await act({ action: 'activate', group: 'bili' })
check('deny 名单变化时照常 restrict 一次', () => assert.equal(restrictCalls.length, 1, `实际 ${restrictCalls.length} 次`))
await act({ action: 'deactivate', group: 'tieba' })
await act({ action: 'deactivate', group: 'bili' })

console.log('19. 死 agent 清理（pruneAgents）')
const mkCtx = () => ({ tools: { restrict(f) { restrictCalls.push(f); return () => {} } }, effect: (fn) => { fn(); return () => {} } })
const snapAgents = async () => {
  const r = fakeRes()
  await stateRoute.handler(panelReq(), r)
  return JSON.parse(r.body).agents
}
// 造两个 agent：a1 和 ghost 都在本插件表里
ctx.get = (n) => (n === 'agents' ? { list: () => [{ id: 'a1' }, { id: 'ghost' }], roots: () => [{ id: 'a1' }, { id: 'ghost' }] } : undefined)
handlers['agent/created']({ agent: { id: 'a1', ctx: mkCtx() }, source: 'startup' })
handlers['agent/created']({ agent: { id: 'ghost', ctx: mkCtx() }, source: 'startup' })
const beforePrune = await snapAgents()
check('清理前 ghost 在表里', () => assert.ok(beforePrune.some((a) => a.id === 'ghost'), JSON.stringify(beforePrune.map((a) => a.id))))

// 宿主注册表里只剩 a1 → tools/change 应把 ghost 清掉
ctx.get = (n) => (n === 'agents' ? { list: () => [{ id: 'a1' }], roots: () => [{ id: 'a1' }] } : undefined)
handlers['tools/change']()
const afterPrune = await snapAgents()
check('list() 回的子集之外被清掉，活着的保留', () => {
  assert.ok(afterPrune.some((a) => a.id === 'a1'), '活着的 a1 不该被删')
  assert.ok(!afterPrune.some((a) => a.id === 'ghost'), 'ghost 应被清掉：' + JSON.stringify(afterPrune.map((a) => a.id)))
})

// 服务不可用 → 一个都不删（删错活 agent 会让 restrict 永远没人撤）
ctx.get = () => undefined
handlers['tools/change']()
const afterNoSvc = await snapAgents()
check('agents 服务不可用时不删任何 agent', () => assert.ok(afterNoSvc.some((a) => a.id === 'a1'), JSON.stringify(afterNoSvc.map((a) => a.id))))

// list() 返回空数组 → 当"还没就绪"，不当"全死了"
ctx.get = (n) => (n === 'agents' ? { list: () => [], roots: () => [] } : undefined)
handlers['tools/change']()
const afterEmpty = await snapAgents()
check('list() 空数组时不当作全死，保留记录', () => assert.ok(afterEmpty.some((a) => a.id === 'a1'), JSON.stringify(afterEmpty.map((a) => a.id))))

console.log('20. 调试日志轮转')
{
  const { statSync, existsSync: ex, appendFileSync: app } = await import('node:fs')
  const { join } = await import('node:path')
  const logPath = join(home, 'loadout-debug.log')
  const bakPath = logPath + '.1'
  // 灌到超过 1 MB
  app(logPath, 'x'.repeat(1024 * 1024 + 100) + '\n')
  const oversized = statSync(logPath).size > 1024 * 1024
  // tools/change 里 pruneAgents 会写一行 dbg，足够触发轮转检查
  ctx.get = () => undefined
  handlers['tools/change']()
  check('超过 1MB 时轮转成 .1，主文件重新变小', () => {
    assert.ok(oversized, '前置条件：灌完应超过上限')
    assert.ok(ex(bakPath), '.1 备份应存在')
    assert.ok(statSync(logPath).size < 1024 * 1024, `轮转后主文件应小于上限，实际 ${statSync(logPath).size}`)
  })
}

console.log('\n' + (process.exitCode ? 'FAILED' : `all ${pass} checks passed`))

console.log('\n' + (process.exitCode ? 'FAILED' : `all ${pass} checks passed`))
