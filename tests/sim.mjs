// 对拍：拿本机正在运行的工具表（面板接口）跑一遍当前分组规则，
// 看"哪些被藏、哪些保持可见、有没有把控制面藏掉"。改完规则拿它复核，别靠猜。
// 用法：node tests/sim.mjs [http://127.0.0.1:<port>]
import { readFileSync } from 'node:fs'

const base = process.argv[2] || process.env.DSH_WEB_URL || 'http://127.0.0.1:55794'
const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
const start = src.indexOf('const NEVER_HIDE')
const end = src.indexOf('const agents = new Map()')
const M = new Function('IDLE_CALLS', src.slice(start, end) + '\nreturn { buildGroups, NEVER_HIDE }')(30)

// 旧版接口每组只回前 40 个，新版回全量；两种都能用
let snap
try {
  const res = await fetch(`${base}/api/dsh-loadout/state`, { headers: { 'x-dsh-loadout': '1' } })
  snap = await res.json()
} catch (e) {
  console.error(`拉不到 ${base}/api/dsh-loadout/state：${e.message}\n先确认 DSH 在跑，或用 node tests/sim.mjs http://127.0.0.1:<port>`)
  process.exit(1)
}

const names = new Set()
for (const g of snap.groups ?? []) for (const t of g.tools ?? []) names.add(t)
for (const t of snap.unmatched ?? []) names.add(t)
// 宿主侧默认可见的核心工具：接口不会列它们，这里补上才好验证"没被误藏"
for (const t of ['ops_bash', 'read', 'write', 'edit', 'glob', 'grep', 'pwsh', 'web_search', 'web_fetch',
  'skill', 'todo_write', 'ask_user_question', 'read_image', 'present', 'workflow', 'subagent',
  'subagent_fork', 'spawn_teammate', 'send_message', 'wait_agent', 'interrupt_agent', 'list_agents',
  'team_task_create', 'team_task_list', 'team_task_get', 'team_task_update', 'job_output', 'job_list',
  'job_kill', 'loadout', 'tools_search', 'tools_call', 'exit_plan_mode', 'ops_discover_tools',
  'compress', 'decompress', 'search_context', 'absorb']) names.add(t)

const r = M.buildGroups([...names])
console.log(`实例：${base}`)
console.log(`输入 ${names.size} 个工具 → 归组 ${r.toolToGroup.size}，保持可见 ${r.unmatched.length}，共 ${r.byName.size} 组\n`)
for (const [n, row] of r.byName) {
  if (row.tools.length > 0) console.log(`  ${n.padEnd(16)} ${String(row.tools.length).padStart(3)}`)
}
const leaked = ['loadout', 'tools_search', 'tools_call'].filter((t) => r.toolToGroup.has(t))
console.log(`\n控制面被藏：${leaked.length ? '✗ ' + leaked.join(',') : '✓ 没有'}`)
if (r.unmatched.length > 0) {
  console.log(`\n保持可见（未归组，${r.unmatched.length}）：`)
  console.log('  ' + r.unmatched.sort().join('  '))
}
