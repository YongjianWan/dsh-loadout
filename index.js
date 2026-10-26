// dsh-loadout: 按需工具分组（DSH 版渐进披露）。
// 常驻核心集，其余工具按组默认隐藏；toolctl activate 当轮生效；空闲自动收回。
// 分组在启动时从 ctx.tools.schemas() 全局视图自动归组（前缀规则），
// tools/change 时重归组（覆盖运行中热装插件与迟到的 MCP 工具）。
// 全程 fail-open：任何错误只记日志，不限制工具。

import { writeFile } from 'node:fs/promises'
import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { readFile, writeFile as writeFileAsync } from 'node:fs/promises'

const IDLE_CALLS = 30 // 组激活后连续多少次工具调用未碰组内工具就收回
const DSH_HOME = process.env.DSH_HOME ?? `${process.env.USERPROFILE}/.dsh`
const STATS_PATH = `${DSH_HOME}/toolctl-stats.json`
const CONFIG_PATH = `${DSH_HOME}/toolctl-config.json`
const DEBUG_LOG = `${DSH_HOME}/toolctl-debug.log`

// 用户配置：哪些组默认隐藏（默认全隐藏）、空闲多少轮收回。
// 面板写这个文件，插件启动/重载时读。
const DEFAULT_CONFIG = { hiddenGroups: null, idleCalls: IDLE_CALLS }

function loadConfig() {
  try {
    if (!existsSync(CONFIG_PATH)) return { ...DEFAULT_CONFIG }
    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
    return { ...DEFAULT_CONFIG, ...raw }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

function dbg(msg) {
  try { appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${msg}\n`) } catch {}
}

// 中英同义词：工具描述是英文，中文查询词要靠这张表桥接
const ZH_SYNONYMS = {
  邮件: ['email', 'mail', 'imap', 'smtp'],
  信箱: ['email', 'mail', 'inbox'],
  收信: ['email', 'list', 'inbox'],
  发信: ['email', 'send'],
  主机: ['ssh', 'host', 'server'],
  远程: ['ssh', 'remote', 'tunnel'],
  隧道: ['tunnel', 'forward'],
  浏览器: ['browser', 'chrome', 'devtools', 'page'],
  网页: ['web', 'page', 'url', 'fetch', 'html'],
  抓取: ['fetch', 'crawl', 'read'],
  截图: ['screenshot', 'snapshot', 'image'],
  办公: ['office', 'univer', 'document', 'sheet', 'slide'],
  表格: ['sheet', 'excel', 'univer', 'workbook'],
  文档: ['doc', 'document', 'univer', 'docx'],
  幻灯片: ['slide', 'pptx', 'presentation'],
  演示: ['slide', 'presentation', 'pptx'],
  记忆: ['memory', 'mnemon', 'recall'],
  提醒: ['schedule', 'reminder', 'cron', 'timer'],
  定时: ['schedule', 'timer', 'cron'],
  任务: ['task', 'schedule', 'job'],
  团队: ['team', 'agent', 'teammate', 'subagent'],
  子代理: ['subagent', 'agent', 'teammate'],
  桌面: ['desktop', 'app', 'window', 'kimi'],
  窗口: ['window', 'app'],
  插件: ['plugin', 'bundle', 'install'],
  备份: ['backup', 'archive'],
  恢复: ['restore', 'recover'],
  沙箱: ['sandbox', 'isolate'],
  图片: ['image', 'picture', 'draw', 'photo'],
  生图: ['draw', 'image', 'generate'],
  天气: ['weather', 'forecast'],
  搜索: ['search', 'query', 'find'],
  研究: ['research', 'investigate'],
  视频: ['video', 'media'],
  音乐: ['audio', 'music', 'sound'],
  语音: ['speech', 'voice', 'audio'],
  文档查询: ['docs', 'context7', 'documentation'],
  目标: ['goal', 'objective'],
  审批: ['approval', 'approve', 'confirm'],
  权限: ['permission', 'auth', 'policy'],
  会话: ['session', 'conversation'],
  工作区: ['workspace', 'directory', 'folder'],
  文件: ['file', 'fs', 'read', 'write'],
  代码: ['code', 'git', 'repo'],
  数据库: ['database', 'sql', 'query'],
  连接: ['connect', 'connection', 'server'],
  测试: ['test', 'check', 'verify'],
}

// 真正危险的工具：外发、远程执行、删除、花钱。tools_call 拒绝这几类，其余一律放行。
const SENSITIVE = new Set([
  'email_send', 'email_reply', 'email_draft', 'email_mark',
  'ssh_exec', 'ssh_cluster', 'ssh_upload', 'ssh_download',
  'workbuddy_draw_image',
  'present', 'plugin_manager', 'backup_dsh',
  'mnemon_remember', 'mnemon_forget', 'mnemon_document_create', 'mnemon_document_manage',
])

const CORE = new Set([
  'read', 'write', 'edit', 'glob', 'grep',
  'ops_read_files', 'read_image', 'ops_bash', 'pwsh', 'working_directory',
  'load_workspace_dependencies', 'skill', 'todo_write', 'ask_user_question',
  'compress', 'decompress', 'search_context', 'acp_status',
  'web_search', 'web_fetch',
  'mnemon_recall', 'mnemon_document_search', 'mnemon_runtime_memory',
  'toolctl',
])

const GROUPS = [
  { name: 'browser', desc: '浏览器自动化：开页导航、点击填表、截图、网络抓包、控制台', match: (t) => t.startsWith('mcp__chrome-devtools__'), samples: ['mcp__chrome-devtools__new_page', 'mcp__chrome-devtools__take_snapshot', 'mcp__chrome-devtools__evaluate_script'] },
  { name: 'desktop', desc: 'Windows 桌面应用 UI 自动化：窗口状态、点击输入、启动应用、截屏', match: (t) => t.startsWith('mcp__kimi-cu__'), samples: ['mcp__kimi-cu__get_app_state', 'mcp__kimi-cu__click', 'mcp__kimi-cu__launch_app'] },
  { name: 'office', desc: 'Univer 办公文档：.univer 文件的表格/文档/幻灯片创建、编辑、渲染、导入导出', match: (t) => t.startsWith('univer_'), samples: ['univer_new', 'univer_execute', 'univer_export'] },
  { name: 'mail', desc: '邮件：列信、读信、发送、回复、搜索、整理文件夹、草稿', match: (t) => t.startsWith('email_'), samples: ['email_list', 'email_read', 'email_send'] },
  { name: 'remote', desc: 'SSH 远程主机：执行命令、上传下载、端口隧道、集群批量', match: (t) => t.startsWith('ssh_'), samples: ['ssh_list', 'ssh_exec', 'ssh_tunnel'] },
  { name: 'team', desc: '智能体团队：派子代理、收发消息、等代理、共享任务板', match: (t) => t.startsWith('team_') || ['spawn_teammate', 'send_message', 'wait_agent', 'interrupt_agent', 'list_agents'].includes(t), samples: ['spawn_teammate', 'send_message', 'team_task_list'] },
  { name: 'mem-admin', desc: '记忆管理（读记忆不用激活）：写记忆、建空间、建档案、遗忘、关联', match: (t) => t.startsWith('mnemon_') && !CORE.has(t), samples: ['mnemon_remember', 'mnemon_forget', 'mnemon_document_create'] },
  { name: 'mcp-admin', desc: 'MCP 连接器管理：连/断服务器、健康检查、配置连接、工具治理、按会话激活', match: (t) => t.startsWith('mcp_connector_'), samples: ['mcp_connector_status', 'mcp_connector_configure', 'mcp_connector_session_tools'] },
  { name: 'search-ext', desc: '进阶检索：平台内搜索、学术文献、多源并发、网页正文批量读、视频、天气、context7 文档', match: (t) => /^(advanced_search|multi_search|research|platform_search|domain_search|video_search|free_search_test|cache_search|read_url|read_url_batch|read_url_links|read_url_site|weather)$/.test(t) || t.startsWith('mcp__context7__'), samples: ['multi_search', 'research', 'read_url_batch', 'domain_search'] },
  { name: 'ops-admin', desc: '宿主运维：插件安装管理、沙箱、备份、多代理 workflow、交付卡片、侧边栏、看图识图、画板', match: (t) => ['plugin_manager', 'backup_dsh', 'codebuddy_ask', 'modlens_read_image', 'workbuddy_draw_image', 'sidebar_open', 'present', 'exit_plan_mode', 'diff_approval_annotate', 'ops_discover_tools', 'cordis_inspect_list', 'cordis_inspect_query', 'workflow'].includes(t) || t.startsWith('dsh_ops_sandbox_'), samples: ['plugin_manager', 'backup_dsh', 'present'] },
  { name: 'sched', desc: '定时提醒：创建/列出/修改/删除会话内提醒', match: (t) => t.startsWith('schedule_'), samples: ['schedule_create', 'schedule_list'] },
  { name: 'goal', desc: '长目标：跨轮自动续跑的目标创建与查看', match: (t) => /^(create_goal|update_goal|get_goal)$/.test(t), samples: ['create_goal'] },
  { name: 'extras', desc: '其他插件工具（新装插件未归入已知家族时落这里）：用 tools_search 按关键词找，tools_call 代理调用', match: () => false, samples: [] },
]

function buildGroups(schemaNames) {
  const groups = GROUPS.map((g) => ({ name: g.name, desc: g.desc, samples: g.samples, tools: [] }))
  const byName = new Map(groups.map((g) => [g.name, g]))
  const toolToGroup = new Map()
  const unmatched = []
  for (const name of schemaNames) {
    if (CORE.has(name)) continue
    const g = GROUPS.find((rule) => rule.match(name))
    if (g) {
      byName.get(g.name).tools.push(name)
      toolToGroup.set(name, g.name)
    } else {
      unmatched.push(name)
    }
  }
  // 未匹配的新插件工具收进 extras 组默认隐藏，不污染常驻核心集
  if (unmatched.length > 0) {
    const extra = byName.get('extras')
    for (const name of unmatched) {
      extra.tools.push(name)
      toolToGroup.set(name, 'extras')
    }
  }
  return { groups, byName, toolToGroup, unmatched }
}

function buildCatalog(byName) {
  const lines = [
    '## 工具分组（按需激活）',
    '',
    '大部分工具默认隐藏以节省上下文。规则：',
    '1. 要用的工具不在或调用报 "Unknown tool" 时，先调用 toolctl {"action":"activate","group":"<组名>"}，当轮生效。',
    '2. toolctl {"action":"list"} 查看各组隐藏/激活状态。',
    '3. 别用同族可见工具替代你要调的工具——先激活，再原样调用。',
    '4. 组在连续 ' + IDLE_CALLS + ' 次工具调用未被使用后自动收回，可再 activate。',
    '5. 已知的 skill→组 对应：univer/office 类 skill → office；archify 出图 → 不额外需要；邮件类任务 → mail；远程主机 → remote；MCP 连接器配置 → mcp-admin。',
    '',
    '| 组名 | 什么时候用 | 代表工具 |',
    '|---|---|---|',
  ]
  for (const g of GROUPS) {
    const row = byName.get(g.name)
    const n = row ? row.tools.length : 0
    if (g.name === 'extras' && n === 0) continue
    const tag = n === 0 ? '（本环境未加载）' : ''
    const sampleText = g.samples.length > 0 ? g.samples.slice(0, 3).join(', ') : `tools_search 检索（${n} 个）`
    lines.push(`| ${g.name}${tag} | ${g.desc} | ${sampleText} |`)
  }
  lines.push('', '未列入上表的工具始终可用。')
  return lines.join('\n')
}

const agents = new Map() // agentId -> state
const stats = new Map() // toolName -> count（跨会话聚合，持久化 JSON）
let statsDirty = 0
let statsWriting = false

async function flushStats(log) {
  if (statsWriting) return
  statsWriting = true
  try {
    await writeFile(STATS_PATH, JSON.stringify(Object.fromEntries(stats), null, 1), 'utf8')
  } catch (e) {
    log(`stats flush failed: ${e?.message ?? e}`)
  } finally {
    statsWriting = false
  }
}

function bumpStat(name) {
  stats.set(name, (stats.get(name) ?? 0) + 1)
  if (++statsDirty >= 20) {
    statsDirty = 0
    queueMicrotask(() => flushStats(() => {}))
  }
}

function trimLog(st) {
  if (st.applyLog.length > 10) st.applyLog.splice(0, st.applyLog.length - 10)
}

function denyList(st, byName) {
  const out = []
  for (const g of st.hidden) {
    const row = byName.get(g)
    if (row) out.push(...row.tools)
  }
  return out
}

let isApplying = false

function applyMask(st, byName, log, label) {
  if (isApplying) { dbg(`applyMask SKIP(${label}) isApplying=true`); return }
  isApplying = true
  try {
    if (st.disposer) {
      try { st.disposer() } catch (e) { log(`dispose failed: ${e.message}`) }
      st.disposer = null
    }
    const deny = denyList(st, byName)
    try {
      if (deny.length > 0) st.disposer = st.agentCtx.tools.restrict({ deny })
      st.applyLog.push({ label, denyCount: deny.length, ok: true })
      dbg(`applyMask(${label}) ok deny=${deny.length} tools=${deny.slice(0, 3).join('|')}`)
    } catch (e) {
      st.applyLog.push({ label, denyCount: deny.length, ok: false, error: String(e?.message ?? e) })
      log(`restrict failed (${label}): ${e?.message ?? e}`)
      dbg(`applyMask(${label}) FAIL ${e?.message ?? e}`)
    }
    trimLog(st)
  } finally {
    isApplying = false
  }
}

export const name = 'dsh-loadout'
export const inject = ['tools']

export function apply(ctx, config) {
  const userCfg = loadConfig()
  const idleCalls = Number(config?.idleCalls) > 0
    ? Number(config.idleCalls)
    : (Number(userCfg.idleCalls) > 0 ? Number(userCfg.idleCalls) : IDLE_CALLS)
  const log = (msg) => ctx.logger.info(`[dsh-loadout] ${msg}`)

  // 1. 枚举全局注册表并归组
  let byName = new Map()
  let toolToGroup = new Map()
  let lastToolNames = ''
  const reGroup = (label) => {
    let names = []
    try {
      names = ctx.tools.schemas().map((s) => s.name).sort()
    } catch (e) {
      log(`schemas() failed (${label}): ${e?.message ?? e}`)
      return false
    }
    const key = names.join(',')
    if (key === lastToolNames) return false
    lastToolNames = key
    const built = buildGroups(names)
    byName = built.byName
    toolToGroup = built.toolToGroup
    if (built.unmatched.length > 0) log(`unmatched tools (stay visible): ${built.unmatched.join(', ')}`)
    log(`reGroup(${label}): ${names.length} tools, ${built.toolToGroup.size} grouped`)
    return true
  }
  reGroup('startup')
  dbg(`startup: groups=${byName.size} toolToGroup=${toolToGroup.size} names=${lastToolNames.split(',').length}`)
  if (byName.size === 0) {
    log('no groups built, plugin inactive')
    return
  }

  // 2. 目录常驻系统提示
  try {
    ctx.inject(['systemPrompt'], (inner) => {
      try {
        inner.systemPrompt.section({
          name: 'tool-groups',
          order: inner.systemPrompt.getSectionOrder('MCP_SERVERS'),
          interpolate: false,
          text: () => buildCatalog(byName),
        })
        log('catalog section registered')
      } catch (e) {
        log(`catalog section failed: ${e?.message ?? e}`)
      }
    })
  } catch (e) {
    log(`systemPrompt inject failed: ${e?.message ?? e}`)
  }

  // 3. 新 agent 默认隐藏全部非空组（fail-open）
  ctx.on('agent/created', function (payload) {
    try {
      const agentCtx = payload?.agent?.ctx ?? this?.ctx ?? null
      const id = payload?.agent?.id ?? 'unknown'
      dbg(`agent/created id=${id} hasCtx=${Boolean(agentCtx)} groups=${byName.size} source=${payload?.source ?? '?'}`)
      if (!agentCtx) { log(`agent/created ${id}: no ctx, skip`); return }
      // 默认隐藏的组：配置文件 hiddenGroups 指定则用它（数组，组名列表），否则全部非空组
      const configured = Array.isArray(userCfg.hiddenGroups) ? new Set(userCfg.hiddenGroups) : null
      const st = {
        hidden: new Set([...byName.keys()].filter((n) => {
          if (byName.get(n).tools.length === 0) return false
          return configured ? configured.has(n) : true
        })),
        disposer: null, agentCtx, tick: 0, lastUsed: {}, applyLog: [],
      }
      agents.set(id, st)
      applyMask(st, byName, log, 'created')
      try {
        agentCtx.effect(() => () => {
          const s = agents.get(id)
          if (s?.disposer) { try { s.disposer() } catch {} }
          agents.delete(id)
        })
      } catch {}
      log(`agent/created ${id}: ${st.hidden.size} groups hidden`)
    } catch (e) {
      log(`agent/created handler crashed (fail-open, no restriction): ${e?.message ?? e}`)
    }
  })

  // 4. 工具调用：统计 + 组内命中刷新 + 空闲收回
  try {
    ctx.on('tools/result', (exec) => {
      try {
        if (exec?.name) bumpStat(exec.name)
        const id = exec?.agent?.id
        const st = agents.get(id)
        if (!st) return
        st.tick++
        const g = toolToGroup.get(exec?.name)
        if (g && !st.hidden.has(g)) st.lastUsed[g] = st.tick
        for (const gName of Object.keys(st.lastUsed)) {
          if (st.hidden.has(gName)) { delete st.lastUsed[gName]; continue }
          if (st.tick - st.lastUsed[gName] > idleCalls) {
            st.hidden.add(gName)
            delete st.lastUsed[gName]
            applyMask(st, byName, log, `idle-reclaim:${gName}`)
            log(`agent ${id}: group ${gName} reclaimed after ${idleCalls} idle calls`)
          }
        }
      } catch {}
    })
  } catch (e) {
    log(`tools/result listener failed: ${e?.message ?? e}`)
  }

  // 5. 注册表变动（热装插件、MCP 重连）时重归组，并对存活的 agent 重算 mask
  try {
    ctx.on('tools/change', () => {
      if (isApplying) return
      try {
        const changed = reGroup('tools/change')
        if (!changed) return
        for (const st of agents.values()) {
          applyMask(st, byName, log, 'reGroup')
        }
      } catch (e) {
        log(`tools/change handler failed: ${e?.message ?? e}`)
      }
    })
  } catch (e) {
    log(`tools/change listener failed: ${e?.message ?? e}`)
  }

  // 6. 插件卸载/HMR 时清理全部 mask（fail-open）
  try {
    ctx.effect(() => () => {
      for (const st of agents.values()) {
        if (st.disposer) { try { st.disposer() } catch {} }
      }
      agents.clear()
      queueMicrotask(() => flushStats(log))
      log('plugin disposed: all masks lifted')
    })
  } catch (e) {
    log(`dispose effect failed: ${e?.message ?? e}`)
  }

  // 7. 元工具
  ctx.tools.register({
    name: 'toolctl',
    description: '按需激活/隐藏工具组。action=list 看状态；action=activate group=<组名> 激活一组（当轮生效，' + idleCalls + ' 次调用未用后自动收回）；action=deactivate group=<组名> 重新隐藏；action=stats 看工具调用频率排序（用于决定哪些工具该常驻）。遇到 "Unknown tool" 时先用它激活对应组，不要拿同族工具替代。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'activate', 'deactivate', 'stats', 'review'] },
        group: { type: 'string', description: '组名：browser/desktop/office/mail/remote/team/mem-admin/mcp-admin/search-ext/ops-admin/sched/goal' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    execute: async (args, exec) => {
      try {
        if (args.action === 'stats') {
          const top = [...stats.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30)
          if (top.length === 0) return 'no stats yet'
          return 'top tools by calls:\n' + top.map(([n, c]) => `${c}\t${n}`).join('\n')
        }
        if (args.action === 'review') {
          // 按调用数据给分组建议：常驻里零调用的降级、隐藏组里高频的升级
          const allNames = []
          for (const st2 of byName.values()) allNames.push(...st2.tools)
          const coreZero = [...CORE].filter((n) => !stats.get(n))
          const extraHot = []
          for (const [gName, row] of byName) {
            if (gName === 'extras') continue
            for (const n of row.tools) {
              const c = stats.get(n) ?? 0
              if (c >= 5) extraHot.push(`${n} (${gName}, ${c} calls)`)
            }
          }
          const extrasNames = byName.get('extras')?.tools ?? []
          const neverCalled = allNames.filter((n) => !stats.get(n))
          const lines = [
            `stats: ${stats.size} tools tracked | groups: ${byName.size} | core: ${CORE.size}`,
            '',
            `core never called (${coreZero.length}): ${coreZero.slice(0, 12).join(', ') || '(none)'}`,
            `-> suggestion: consider moving to a group`,
            '',
            `hidden-group tools with >=5 calls (${extraHot.length}):`,
            ...extraHot.slice(0, 10).map((s) => `  ${s}`),
            '',
            `never called at all (${neverCalled.length})`,
            '',
            extrasNames.length > 0 ? `extras group (${extrasNames.length}): ${extrasNames.slice(0, 10).join(', ')}` : 'extras group: empty',
            '',
            'Apply changes by editing the plugin GROUPS/CORE lists.',
          ]
          return lines.join('\n')
        }
        const st = agents.get(exec?.agent?.id)
        if (!st) return 'no state for this agent (agent/created missed)'
        if (args.action === 'list') {
          const hidden = [...st.hidden]
          const active = [...byName.keys()].filter((n) => !st.hidden.has(n) && byName.get(n).tools.length > 0)
          const last = st.applyLog[st.applyLog.length - 1]
          const lastText = last ? (last.ok ? `ok deny=${last.denyCount}` : `FAIL ${last.error}`) : 'n/a'
          return `groups: ${[...byName.keys()].join(', ')} | hidden: ${hidden.join(', ') || '(none)'} | active: ${active.join(', ') || '(none)'} | lastApply: ${lastText}`
        }
        const g = args.group
        if (!byName.has(g) || byName.get(g).tools.length === 0) return `unknown or empty group: ${String(g)}`
        if (args.action === 'activate') {
          if (!st.hidden.has(g)) return `${g} already active`
          st.hidden.delete(g)
          st.lastUsed[g] = st.tick
        } else {
          if (st.hidden.has(g)) return `${g} already hidden`
          st.hidden.add(g)
          delete st.lastUsed[g]
        }
        applyMask(st, byName, log, `${args.action}:${g}`)
        return `${args.action} ${g} done | hidden: ${[...st.hidden].join(', ') || '(none)'}`
      } catch (e) {
        return `toolctl error (fail-open, nothing restricted): ${e?.message ?? e}`
      }
    },
  })

  // 8. 长尾档：搜索 + 代理调用（做法 B）。
  // tools_search 在隐藏工具的名字/描述/参数里按关键词匹配，返回完整 schema 文本。
  // 敏感工具与未分类工具照常可搜（让模型看见存在），但返回里写明该怎么调用。
  ctx.tools.register({
    name: 'tools_search',
    description: 'Search hidden tools by keyword and return their full JSON schemas. Use it when the tool you need is not in your tool list and toolctl activate cannot help (long-tail tools). Matches tool names, descriptions, parameter names and parameter descriptions.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'keyword or short natural-language phrase' },
        limit: { type: 'number', description: 'max results, 1-10, default 5' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
      execute: async (args) => {
      try {
        const q = String(args.query ?? '').toLowerCase().trim()
        if (!q) return 'tools_search: query required'
        const limit = Math.min(10, Math.max(1, Number(args.limit) || 5))
        // 查询词展开：原词 + 中文同义词 + 子词（"email_list" 搜 "email" 也命中）
        const rawTerms = q.split(/[\s,，、]+/).filter(Boolean)
        const terms = new Set()
        for (const t of rawTerms) {
          terms.add(t)
          if (t.length > 2) {
            for (const piece of t.split(/[_\-./]/)) if (piece.length > 1) terms.add(piece)
          }
          const syn = ZH_SYNONYMS[t]
          if (syn) for (const s of syn) terms.add(s)
          // 中文整词拆字兜底：查询里含中文时，也把每个双字片段加进去
          if (/[\u4e00-\u9fa5]/.test(t)) {
            for (let i = 0; i + 2 <= t.length; i++) {
              const bi = t.slice(i, i + 2)
              if (ZH_SYNONYMS[bi]) for (const s of ZH_SYNONYMS[bi]) terms.add(s)
            }
          }
        }
        const scores = new Map()
        for (const schema of ctx.tools.schemas()) {
          const name = schema.name
          if (CORE.has(name)) continue
          const nameL = name.toLowerCase()
          const descL = String(schema.description ?? '').toLowerCase()
          const paramL = JSON.stringify(schema.parameters ?? {}).toLowerCase()
          let score = 0
          let hits = 0
          for (const t of terms) {
            if (nameL.includes(t)) { score += 6; hits++ }
            else if (descL.includes(t)) { score += 3; hits++ }
            else if (paramL.includes(t)) { score += 1; hits++ }
          }
          if (hits > 0) scores.set(name, { score, hits, schema })
        }
        const ranked = [...scores.values()].sort((a, b) => b.score - a.score || a.schema.name.localeCompare(b.schema.name))
        const top = ranked.slice(0, limit)
        if (top.length === 0) {
          return `no tools matched "${q}". Try a broader keyword (e.g. "email", "ssh", "browser", "office"), or check the group catalog in the system prompt.`
        }
        return [
          `matched ${top.length} of ${ranked.length} for "${q}"`,
          '',
          ...top.map((t) => {
            const g = toolToGroup.get(t.schema.name)
            const how = g
              ? `先 toolctl {"action":"activate","group":"${g}"}，再直接调用；或 tools_call {"name":"${t.schema.name}","args":{...}}`
              : `tools_call {"name":"${t.schema.name}","args":{...}}`
            return [
              `### ${t.schema.name}${g ? ` [group: ${g}]` : ''}`,
              String(t.schema.description ?? '').slice(0, 600),
              '```json',
              JSON.stringify(t.schema.parameters ?? {}, null, 1).slice(0, 2000),
              '```',
              `调用方式: ${how}`,
            ].join('\n')
          }),
          '',
          'Use: tools_call {"name":"<name>","args":{...}} (extras group only; mid-frequency groups need toolctl activate first)',
        ].join('\n')
      } catch (e) {
        return `tools_search failed: ${e?.message ?? e}`
      }
    },
  })

  // 9. 代理调用：插件侧按名字调用被 restrict 隐藏的工具。
  // 关键：execute 时不传 agent，走全局视图，绕过 per-agent 的 restrict。
  ctx.tools.register({
    name: 'tools_call',
    description: 'Call a hidden tool by name through the plugin (proxy), returns the tool\'s rendered result. Use it after tools_search when the tool is not visible in your tool list and toolctl activate cannot help (long-tail tools). args is the tool\'s own argument object.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'exact tool name from tools_search' },
        args: { type: 'object', description: 'the tool\'s own arguments', additionalProperties: true },
      },
      required: ['name'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    execute: async (args, exec) => {
      try {
        const name = String(args.name ?? '')
        if (!name) return 'tools_call: name required'
        if (SENSITIVE.has(name)) {
          return `tools_call: 拒绝 "${name}" —— 这是外发/执行/破坏类工具，请先用 toolctl 激活它的组，然后直接调用。`
        }
        // 不带 agent → 全局视图，不受调用方 agent 的 restrict 影响。
        const result = await ctx.tools.execute({
          callId: `proxy-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
          name,
          arguments: args.args ?? {},
          signal: exec.signal,
        })
        if (result.isError) return `tools_call error (${name}): ${result.error?.message ?? 'unknown'}`
        // 优先用工具自己的 render，得到与直调一致的文本；退化到 JSON
        try {
          const blocks = def.output?.render?.(args.args ?? {}, result.value)
          if (Array.isArray(blocks) && blocks.length > 0) {
            const text = blocks.map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join('\n')
            if (text) return text
          }
        } catch {}
        return JSON.stringify(result.value)
      } catch (e) {
        return `tools_call failed: ${e?.message ?? e}`
      }
    },
  })

  // 8. 面板数据桥：只读快照 + 写配置。面板（client.js）通过这两个端点读写。
  try {
    ctx.inject(['webServer'], (sctx) => {
      sctx.effect(() => {
        const routes = [
          {
            kind: 'exact',
            path: '/api/dsh-loadout/state',
            handler: async (req, res) => {
              const cfg = loadConfig()
              const groups = [...byName.entries()].map(([name, row]) => ({
                name, desc: row.desc, count: row.tools.length,
                tools: row.tools.slice(0, 40),
                calls: row.tools.reduce((s, t) => s + (stats.get(t) ?? 0), 0),
                hidden: Array.isArray(cfg.hiddenGroups) ? cfg.hiddenGroups.includes(name) : true,
              }))
              const body = JSON.stringify({
                groups,
                idleCalls: Number(cfg.idleCalls) || IDLE_CALLS,
                core: [...CORE],
                stats: Object.fromEntries(stats),
                agents: [...agents.keys()].length,
              })
              res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
              res.end(body)
            },
          },
          {
            kind: 'exact',
            path: '/api/dsh-loadout/config',
            handler: async (req, res) => {
              if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
              const chunks = []
              for await (const c of req) chunks.push(c)
              try {
                const next = JSON.parse(Buffer.concat(chunks).toString('utf8'))
                const merged = { ...loadConfig(), ...(next && typeof next === 'object' ? next : {}) }
                if (Array.isArray(merged.hiddenGroups)) {
                  merged.hiddenGroups = merged.hiddenGroups.filter((g) => byName.has(g))
                }
                if (!(Number(merged.idleCalls) > 0)) merged.idleCalls = IDLE_CALLS
                await writeFileAsync(CONFIG_PATH, JSON.stringify(merged, null, 1), 'utf8')
                dbg(`config saved: hidden=${(merged.hiddenGroups ?? []).join(',') || 'all'} idle=${merged.idleCalls}`)
                res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
                res.end(JSON.stringify({ ok: true, config: merged }))
              } catch (e) {
                res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
                res.end(JSON.stringify({ ok: false, error: String(e?.message ?? e) }))
              }
            },
          },
        ]
        const disposers = routes.map((route) => sctx.webServer.register(route))
        return () => { for (const d of disposers) { try { d() } catch {} } }
      }, 'toolctl: panel bridge')
    })
  } catch (e) {
    log(`panel bridge failed: ${e?.message ?? e}`)
  }

  log('toolctl + tools_call registered')
}
