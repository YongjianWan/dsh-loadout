// 离线单测：只测分组/匹配/配置这几块纯逻辑，不碰 DSH 运行时。
// 跑法：node tests/test-grouping.mjs
import assert from 'node:assert'
import { readFileSync } from 'node:fs'

// index.js 里 apply() 依赖 ctx，没法直接 import。这里把纯函数段抽出来 eval——
// 用文件切片而不是复制代码，避免测试和实现漂移。
const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
const start = src.indexOf('const NEVER_HIDE')
const end = src.indexOf('const agents = new Map()')
assert.ok(start > 0 && end > start, 'index.js 结构变了，切片锚点失效')

const shim = src.slice(start, end)
const factory = new Function('IDLE_CALLS', `
  ${shim}
  return { NEVER_HIDE, BUILTIN_GROUPS, buildGroups, buildCatalog, parseRule, matchGroup, effectiveGated, effectiveCutGroups, effectiveCutTriggerGroups, effectiveCutTriggerTools, effectiveModes }
`)
const M = factory(30)

let pass = 0
const check = (label, fn) => {
  try { fn(); pass++; console.log('  ok  ' + label) }
  catch (e) { console.error('  FAIL ' + label + '\n       ' + e.message); process.exitCode = 1 }
}

console.log('1. 控制面永不进组（原 extras 自锁 bug 的回归测试）')
check('loadout/tools_search/tools_call 不被归组', () => {
  const { toolToGroup } = M.buildGroups(['loadout', 'tools_search', 'tools_call'])
  assert.equal(toolToGroup.size, 0)
})
check('absorb/compress 也不归组', () => {
  const { toolToGroup } = M.buildGroups(['absorb', 'compress', 'decompress'])
  assert.equal(toolToGroup.size, 0)
})
check('未归组工具进 unmatched，不进任何组', () => {
  const r = M.buildGroups(['read', 'ops_bash', 'some_new_plugin_tool'])
  assert.equal(r.toolToGroup.size, 0)
  assert.deepEqual(r.unmatched.sort(), ['ops_bash', 'read', 'some_new_plugin_tool'])
})

console.log('2. 边界：未知即可见（不是未知即隐藏）')
check('新插件的未知工具不会被隐藏', () => {
  const r = M.buildGroups(['brand_new_thing', 'another_novel_tool'])
  for (const g of r.groups) assert.equal(g.tools.includes('brand_new_thing'), false)
})
check('空组仍然出现在组表里（面板要展示"规则没匹配到"）', () => {
  const r = M.buildGroups(['univer_new'])
  const empty = r.groups.filter((g) => g.tools.length === 0).map((g) => g.name)
  assert.ok(empty.includes('tieba'), '空规则组应保留')
})
check('没有任何工具时也不炸', () => {
  const r = M.buildGroups([])
  assert.equal(r.toolToGroup.size, 0)
  assert.equal(r.unmatched.length, 0)
})

console.log('3. MCP 自动分组')
check('mcp__server__tool 按 server 归组', () => {
  const r = M.buildGroups(['mcp__chrome-devtools__click', 'mcp__chrome-devtools__fill', 'mcp__context7__query-docs'])
  assert.equal(r.byName.get('chrome-devtools').tools.length, 2)
  assert.equal(r.byName.get('context7').tools.length, 1)
})
check('server 名里带下划线也能正确切分', () => {
  const r = M.buildGroups(['mcp__kimi_cu__click'])
  assert.ok(r.byName.has('kimi_cu'), '实际得到: ' + [...r.byName.keys()].join(','))
})
check('mcpGroups:false 时 MCP 工具不再自动归组', () => {
  const r = M.buildGroups(['mcp__chrome-devtools__click'], { mcpGroups: false })
  assert.equal(r.toolToGroup.size, 0)
})

console.log('4. 前缀 / 全名 / 正则三种匹配')
check('前缀匹配', () => {
  const r = M.buildGroups(['email_send', 'email_list'])
  assert.equal(r.byName.get('email').tools.length, 2)
})
check('全名精确匹配（不当前缀用）', () => {
  const r = M.buildGroups(['present'])
  assert.equal(r.byName.get('ops').tools.length, 1)
  const r2 = M.buildGroups(['presentation_maker'])
  assert.equal(r2.toolToGroup.size, 0, 'present 不应吃掉 presentation_maker')
})
check('正则匹配', () => {
  const rules = [{ name: 'goalish', desc: 'x', patterns: ['^(create|update|get)_goal$'] }]
  const r = M.buildGroups(['create_goal', 'get_goal', 'goal_random'], { groups: rules })
  assert.equal(r.byName.get('goalish').tools.length, 2)
})
check('非法正则不抛错、只是不匹配', () => {
  const rules = [{ name: 'bad', prefixes: [], patterns: ['([unclosed'] }]
  const r = M.buildGroups(['anything'], { groups: rules })
  assert.equal(r.toolToGroup.size, 0)
})

console.log('5. 配置优先于内置规则')
check('groups 传空数组 → 退回内置', () => {
  const r = M.buildGroups(['email_send'], { groups: [] })
  assert.equal(r.byName.get('email').tools.length, 1)
})
check('groups 非空 → 完全替换内置', () => {
  const r = M.buildGroups(['email_send'], { groups: [{ name: 'mail2', prefixes: ['email_'] }] })
  assert.equal(r.byName.has('email'), false)
  assert.equal(r.byName.get('mail2').tools.length, 1)
})
check('neverHide 配置能追加豁免', () => {
  const r = M.buildGroups(['email_send'], { neverHide: ['email_send'] })
  assert.equal(r.toolToGroup.size, 0)
})

console.log('6. buildCatalog 输出')
check('目录里列出有工具的组、跳过空组', () => {
  const r = M.buildGroups(['email_send'])
  const cat = M.buildCatalog(r.byName, { idleCalls: 42, unmatchedCount: 3 })
  assert.ok(cat.includes('| email |'))
  assert.ok(cat.includes('42'), '阈值应写进目录')
  assert.ok(!cat.includes('| tieba |'), '空组不该出现')
  assert.ok(cat.includes('3 个工具未归组'))
})
check('model 不会被指去找不存在的工具', () => {
  const r = M.buildGroups(['loadout'])
  const cat = M.buildCatalog(r.byName, {})
  assert.ok(!cat.includes('tools_search 检索'), '空组提示残留')
})

console.log('7. 新插件观察区（trial）：迟到的未认领工具默认隐藏，用够次数转正')
check('候选工具进 trial 组，不进 unmatched', () => {
  const r = M.buildGroups(['late_thing'], {}, new Set(['late_thing']))
  assert.equal(r.toolToGroup.get('late_thing'), 'trial')
  assert.deepEqual(r.unmatched, [])
})
check('非候选的未认领工具仍 fail-open 可见', () => {
  const r = M.buildGroups(['old_thing'], {}, new Set(['late_thing']))
  assert.deepEqual(r.unmatched, ['old_thing'])
})
check('trial:false 时候选工具退回 fail-open', () => {
  const r = M.buildGroups(['late_thing'], { trial: false }, new Set(['late_thing']))
  assert.deepEqual(r.unmatched, ['late_thing'])
})
check('控制面不进 trial（neverHide 先行）', () => {
  const r = M.buildGroups(['loadout', 'tools_search', 'tools_call'], {}, new Set(['loadout', 'tools_search', 'tools_call']))
  assert.equal(r.toolToGroup.size, 0)
})
check('规则认领的迟到工具进规则组，不进 trial', () => {
  const r = M.buildGroups(['email_send'], {}, new Set(['email_send']))
  assert.equal(r.toolToGroup.get('email_send'), 'email')
})
check('trial 组带转正说明，次数取自配置', () => {
  const r = M.buildGroups(['late_thing'], { trialPromoteAfter: 5 }, new Set(['late_thing']))
  assert.ok(r.byName.has('trial'))
  assert.ok(r.byName.get('trial').desc.includes('5 次'), r.byName.get('trial').desc)
})
check('空候选时 trial 组不进组表', () => {
  const r = M.buildGroups(['old_thing'], {}, new Set())
  assert.ok(!r.byName.has('trial'))
})

console.log('8. 模式切换与切断外联的配置纯逻辑')
check('内置四档模式齐全', () => {
  const modes = M.effectiveModes({})
  for (const k of ['coding', 'writing', 'ops', 'review']) assert.ok(modes[k], Object.keys(modes).join(','))
  assert.ok(modes.review.hide.includes('ssh') && modes.review.hide.includes('email'))
})
check('config.modes 同名覆盖、新名新增、未动的不变', () => {
  const modes = M.effectiveModes({ modes: { coding: { label: '码码', activate: ['ssh'] }, mymode: { activate: ['bili'], hide: ['email'] } } })
  assert.equal(modes.coding.label, '码码')
  assert.deepEqual(modes.coding.activate, ['ssh'])
  assert.ok(modes.mymode && modes.mymode.hide.includes('email'))
  assert.equal(modes.writing.label, '写材料')
})
check('切断清单：null 用默认、数组整体替换', () => {
  assert.ok(M.effectiveCutGroups({}).has('email'))
  assert.ok(M.effectiveCutGroups({}).has('ssh'))
  assert.ok(!M.effectiveCutGroups({ cutGroups: ['ssh'] }).has('email'))
  assert.ok(M.effectiveCutTriggerGroups({}).has('chrome-devtools'))
  assert.ok(M.effectiveCutTriggerTools({}).has('web_fetch'))
  assert.ok(!M.effectiveCutTriggerTools({ cutTriggerTools: [] }).has('web_fetch'))
})
check('gated 默认 ssh/email/kimi-cu，可替换可清空', () => {
  assert.ok(M.effectiveGated({}).has('ssh') && M.effectiveGated({}).has('email') && M.effectiveGated({}).has('kimi-cu'))
  assert.equal(M.effectiveGated({ gatedGroups: [] }).size, 0)
  assert.ok(M.effectiveGated({ gatedGroups: ['ops'] }).has('ops'))
})

console.log('\n' + (process.exitCode ? 'FAILED' : `all ${pass} checks passed`))
