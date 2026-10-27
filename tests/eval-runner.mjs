// dsh-loadout 20 任务评测执行器（定稿）
// 车：DSH 宿主一元 RPC（HTTP POST + v1 cookie）；launch token 走插件 mint-url 端点。
// 每个评测会话：session/create(cwd=工作区) → selectModel(kimi-for-coding) → prompt → 轮询静止 → 指标 + 脚本检查。
// 用法：
//   node tests/eval-runner.mjs run <taskId>     # 单任务 1 次（当前臂配置下）
//   node tests/eval-runner.mjs matrix           # 全量：A(20×3) → B(20×3) → 关插件 C(20×3) → 恢复
// 结果：eval-results.jsonl（每行一次运行）。
import { appendFileSync, existsSync, writeFileSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

const BASE = process.env.DSH_BASE ?? 'http://127.0.0.1:55794'
const WS = 'C:/Users/sdses/Documents/deepseek-harness/default-workspace'
const DESKTOP = 'C:/Users/sdses/Desktop'
const RESULTS = new URL('./eval-results.jsonl', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const PATCH = 'C:/Users/sdses/.dsh/profiles/desktop/cordis.patch.yml'
const REPS = 3
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- 鉴权与 RPC ----------
async function mintToken() {
  const res = await fetch(BASE + '/api/dsh-loadout/mint-url', { method: 'POST', headers: { 'x-dsh-loadout': '1' } })
  const body = await res.json()
  if (!body.ok) throw new Error('mint-url: ' + body.error)
  return new URL(body.url).searchParams.get('token')
}
let COOKIE = ''
async function auth() {
  const token = await mintToken()
  const res = await fetch(BASE + '/?token=' + encodeURIComponent(token), { redirect: 'manual' })
  COOKIE = (res.headers.get('set-cookie') ?? '').match(/^(dsh-auth-[^=]+=[^;]+)/)?.[1] ?? ''
  if (!COOKIE) throw new Error('no v1 cookie')
}
async function rpc(method, args) {
  const res = await fetch(BASE + '/api/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: COOKIE },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args } }),
  })
  const msg = await res.json()
  if (msg?.result?.ok === false) throw new Error(method + ': ' + JSON.stringify(msg.result.error).slice(0, 250))
  return msg?.result?.value
}
// 各端点的 args 字段名不一样，包一层
const sessionCreate = (payload) => rpc('session/create', { request: payload })
const sessionPrompt = (payload) => rpc('session/prompt', { request: payload })
const sessionPage = (payload) => rpc('session/page', { request: payload })
const sessionProjections = (sid) => rpc('session/projections', { request: { sessionId: sid } })
const sessionSelectModel = (sid, provider, model) => rpc('session/selectModel', { request: { sessionId: sid, provider, model } })

async function pluginConfig(patch) {
  const res = await fetch(BASE + '/api/dsh-loadout/config', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-dsh-loadout': '1' }, body: JSON.stringify(patch),
  })
  return res.json()
}
function reloadProfile() {
  assertLivePatchAllowed('热重载 profile（reloadProfile）')
  appendFileSync(PATCH, `# eval reload ${Date.now()}\n`)
}

// ---------- 任务集 ----------
const ok = (pass, detail) => ({ pass, detail })
export const TASKS = [
  // A 类：组内连续多次
  { id: 'A1', cls: 'A', prompt: '看看我邮箱里最近一周的未读邮件，按发件人归类，汇总成一份清单存到桌面，文件名"未读汇总.md"。只读取和汇总，不要发任何邮件、不要做任何标记操作。', check: () => existsSync(`${DESKTOP}/未读汇总.md`) ? ok(true, '桌面 未读汇总.md 存在') : ok(false, '缺 未读汇总.md') },
  { id: 'A2', cls: 'A', prompt: '用浏览器打开京东，搜索"机械键盘"，把前 5 个搜索结果的标题和价格抓下来，存成桌面上的"键盘价格.csv"。只读取页面内容，不要登录、不要下单、不要点任何购买按钮。', check: () => existsSync(`${DESKTOP}/键盘价格.csv`) ? ok(true, '键盘价格.csv 存在') : ok(false, '缺 键盘价格.csv') },
  { id: 'A3', cls: 'A', prompt: '把桌面"账单"文件夹里所有的 xlsx 合并成一个工作簿：每个原文件一个 sheet，sheet 名用原文件名，最后一列标注来源文件名，结果存到桌面"合并账单.xlsx"。如果桌面没有"账单"文件夹，就在里面建两三个小 xlsx（自己造测试数据）再合并。', check: () => existsSync(`${DESKTOP}/合并账单.xlsx`) ? ok(true, '合并账单.xlsx 存在') : ok(false, '缺 合并账单.xlsx') },
  { id: 'A4', cls: 'A', prompt: '在 B 站搜索"露营装备"，把前 10 个视频的标题、UP 主、播放量整理成 markdown 表格，存到桌面的"露营装备.md"。只读取公开信息，不要登录、不要投币点赞关注、不要发评论弹幕。', check: () => existsSync(`${DESKTOP}/露营装备.md`) ? ok(true, '露营装备.md 存在') : ok(false, '缺 露营装备.md') },
  // B 类：单次冷门（测路径选择，单独汇报）
  { id: 'B1', cls: 'B', prompt: '远程开发机的 8080 端口现在有没有服务在跑？帮我查一下。只做只读检查，不要安装任何东西、不要改配置、不要重启服务。', check: () => ok(true, '主观任务，只看过程指标') },
  { id: 'B2', cls: 'B', prompt: '看看我之前在论坛上记过什么，挑重点总结给我。只读取，不要发贴回复关注。', check: () => ok(true, '主观任务，只看过程指标') },
  { id: 'B3', cls: 'B', prompt: '我浏览器现在开着哪些页面？列个清单。只读取标签页信息，不要关闭新建跳转任何标签页。', check: () => ok(true, '主观任务，只看过程指标') },
  // C 类：无被藏工具
  { id: 'C1', cls: 'C', prompt: '把这段文字润色成正式邮件口吻，直接输出结果，不要调用工具：\n"老板说我做的那个东西不行，让我重做，我觉得他根本没看就说了。"', check: (r) => textHas(r, '重做') },
  { id: 'C2', cls: 'C', prompt: '写一个 PowerShell 脚本：把桌面"照片"文件夹里的文件按修改月份分到 YYYY-MM 命名的子文件夹。先把脚本输出给我看，不要运行。', check: (r) => textHas(r, '照片') },
  { id: 'C3', cls: 'C', prompt: '查这周上海的天气预报，给我一句穿衣建议。只查公开天气信息。', check: (r) => textHas(r, '上海') },
  // D 类：日常混合
  { id: 'D1', cls: 'D', prompt: '工作区里的 bug.py 运行会报错。修好它，让 python bug.py 能跑完输出结果，修完把改动说给我听。', check: () => existsSync(`${WS}/bug.py`) ? ok(true, 'bug.py 在') : ok(false, '工作区无 bug.py') },
  { id: 'D2', cls: 'D', prompt: '工作区里的 people.csv 有重复行。去掉完全重复的行，按年龄升序，结果存成 people_clean.csv。', check: () => existsSync(`${WS}/people_clean.csv`) ? ok(true, 'people_clean.csv 在') : ok(false, '缺 people_clean.csv') },
  { id: 'D3', cls: 'D', prompt: '读 https://example.com ，用三句话总结页面内容。只读取。', check: (r) => textHas(r, 'example') },
  { id: 'D4', cls: 'D', prompt: '给工作区里的 calc.py 写 pytest 单元测试，存成 test_calc.py，然后运行测试确认全部通过，不通过就修到通过。', check: () => existsSync(`${WS}/test_calc.py`) ? ok(true, 'test_calc.py 在') : ok(false, '缺 test_calc.py') },
  { id: 'D5', cls: 'D', prompt: '翻一下你之前帮我记的东西，有没有跟钱相关的备忘？挑出来讲给我听。只读取，不要写入删除任何记忆。', check: () => ok(true, '主观任务，只看过程指标') },
  // 5 槽留 Aiden 真实任务
]

// ---------- 从 page 记录取文本/指标 ----------
function assistantTexts(page) {
  const out = []
  for (const r of page?.records ?? []) {
    const e = r?.event
    if (e?.type === 'assistant/message') {
      const c = e?.data?.message?.content
      if (typeof c === 'string') out.push(c)
      else if (Array.isArray(c)) for (const p of c) if (p?.type === 'text') out.push(p.text ?? '')
    }
  }
  return out
}
function textHas(page, needle) {
  const hit = assistantTexts(page).some((t) => t.includes(needle))
  return ok(hit, hit ? `回复含"${needle}"` : `回复不含"${needle}"`)
}

// ---------- 单次运行 ----------
async function runOnce(task, arm, rep) {
  const created = await sessionCreate({ cwd: WS })
  const sid = created?.sessionId
  if (!sid) throw new Error('no sessionId')
  await sessionSelectModel(sid, 'kimi-coding', 'kimi-for-coding')
  await sessionProjections(sid) // attach
  await sessionPrompt({ requestId: randomUUID(), sessionId: sid, mode: 'queue', content: [{ type: 'text', text: task.prompt }] })

  const deadline = Date.now() + 15 * 60 * 1000
  let lastAsOf = -1
  let stable = 0
  let proj = null
  for (;;) {
    await sleep(10000)
    proj = await sessionProjections(sid).catch(() => null)
    const asOf = proj?.asOfSeq ?? -2
    if (asOf === lastAsOf) stable++; else stable = 0
    lastAsOf = asOf
    if (stable >= 3 || Date.now() > deadline) break
  }
  const page = await sessionPage({ address: { kind: 'session', sessionId: sid }, throughSeq: proj?.asOfSeq ?? 100, maxMessages: 300 }).catch(() => null)
  const raw = JSON.stringify(page)
  const v = proj?.values ?? {}
  const stats = v.sessionStats ?? {}
  const timeline = v.contextTimeline ?? {}
  const checked = task.check(page)
  const rec = {
    arm, task: task.id, cls: task.cls, rep, ts: new Date().toISOString(), sessionId: sid,
    pass: checked.pass, checkDetail: checked.detail,
    model: timeline.model ?? null,
    turns: stats.turns ?? null,
    steps: stats.steps ?? null,
    toolCalls: stats.toolCalls ?? timeline.counts?.toolCalls ?? null,
    unknownTool: (raw.match(/UNKNOWN_TOOL/g) ?? []).length,
    tokenUsage: v.tokenUsage ?? null,
  }
  appendFileSync(RESULTS, JSON.stringify(rec) + '\n')
  return rec
}

// ---------- 臂控制 ----------
// 真环境守卫：下面几处会直接改写本机 profile 的 cordis.patch.yml（把插件 disabled=true 再改回来），
// 改错就是把 Aiden 日常在用的插件关掉。2026-10-27 发现该文件尾部堆了一串 "# eval reload" 注释，
// 说明它被跑过而没有任何提示。现在必须显式 ALLOW_LIVE_PATCH=1 才允许写。
function assertLivePatchAllowed(what) {
  if (process.env.ALLOW_LIVE_PATCH === '1') return
  throw new Error(
    `拒绝执行：${what} 会改写本机真实 profile（${PATCH}）。\n` +
    '这是评测脚手架，不该在不知情的情况下动到日常环境。\n' +
    '确认要跑就带环境变量重试：ALLOW_LIVE_PATCH=1 node tests/eval-runner.mjs matrix',
  )
}
async function setArm(arm) {
  if (arm === 'A') { await pluginConfig({ catalogMode: 'full' }); reloadProfile(); await sleep(4000) }
  if (arm === 'B') { await pluginConfig({ catalogMode: 'compact' }); reloadProfile(); await sleep(4000) }
  if (arm === 'C') {
    assertLivePatchAllowed('C 臂（停用插件）')
    const txt = readFileSync(PATCH, 'utf8')
    if (!txt.includes('id: dsh-loadout')) appendFileSync(PATCH, '\n- id: dsh-loadout\n  disabled: true\n')
    else writeFileSync(PATCH, txt.replace(/(- id: dsh-loadout\n  disabled: )false/, '$1true'))
    reloadProfile()
    await sleep(6000)
  }
}
async function restorePlugin() {
  assertLivePatchAllowed('恢复插件（restorePlugin）')
  const txt = readFileSync(PATCH, 'utf8')
  if (txt.includes('id: dsh-loadout')) {
    writeFileSync(PATCH, txt.replace(/(- id: dsh-loadout\n  disabled: )true/, '$1false'))
    reloadProfile()
    await sleep(6000)
  }
}

// ---------- 入口 ----------
const [, , cmd, arg1] = process.argv
if (cmd === 'matrix') assertLivePatchAllowed('matrix（会依次切 A/B/C 三臂并改动真实 profile）')
await auth()

if (cmd === 'run') {
  const task = TASKS.find((t) => t.id === arg1)
  if (!task) throw new Error('unknown task ' + arg1)
  console.log(JSON.stringify(await runOnce(task, process.env.EVAL_ARM ?? '?', 1)))
  process.exit(0)
}

if (cmd === 'matrix') {
  for (const arm of ['A', 'B', 'C']) {
    await setArm(arm)
    for (const task of TASKS) {
      for (let rep = 1; rep <= REPS; rep++) {
        try {
          const rec = await runOnce(task, arm, rep)
          console.log(arm, task.id, rep, 'pass=' + rec.pass, 'ut=' + rec.unknownTool, 'tools=' + rec.toolCalls, 'turns=' + rec.turns, rec.tokenUsage ? `in=${rec.tokenUsage.uncachedInputTokens}+${rec.tokenUsage.cacheReadTokens}r` : '')
        } catch (e) {
          console.error(arm, task.id, rep, 'FAILED', e.message)
          appendFileSync(RESULTS, JSON.stringify({ arm, task: task.id, rep, ts: new Date().toISOString(), error: String(e.message) }) + '\n')
        }
      }
    }
  }
  await restorePlugin()
  console.log('matrix done')
  process.exit(0)
}

console.error('usage: eval-runner.mjs run <taskId> | matrix')
process.exit(1)
