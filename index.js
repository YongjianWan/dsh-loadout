// dsh-loadout: 按需工具分组（DSH 版渐进披露）。
// 边界：只有被显式规则认领的工具才归组、才隐藏；没被认领的一律可见（fail-open）。
// MCP 工具按 mcp__<server>__ 自动成组；其余靠配置里的规则（前缀/全名/正则）。
// 控制面（loadout / tools_search / tools_call）永不隐藏，否则没人能解套。
// 全程 fail-open：任何错误只记日志，不限制工具。

import { writeFile } from 'node:fs/promises'
import { appendFileSync, readFileSync, existsSync, renameSync, writeFileSync } from 'node:fs'
import { writeFile as writeFileAsync } from 'node:fs/promises'

const IDLE_CALLS = 30 // 组激活后连续多少次工具调用未碰组内工具就收回
const DSH_HOME = process.env.DSH_HOME ?? `${process.env.USERPROFILE}/.dsh`
const STATS_PATH = `${DSH_HOME}/loadout-stats.json`
const CONFIG_PATH = `${DSH_HOME}/loadout-config.json`
const DEBUG_LOG = `${DSH_HOME}/loadout-debug.log`
// 观察区转正名单（持久化：转正结果跨重启不丢，否则每次重启都从头试）
const TRIAL_PATH = `${DSH_HOME}/loadout-trial.json`

// 2026-10-28 控制面工具改名 toolctl → loadout：旧文件还在、新文件没有时迁移一次，历史统计和配置不丢。
for (const [legacy, current] of [
  [`${DSH_HOME}/toolctl-stats.json`, STATS_PATH],
  [`${DSH_HOME}/toolctl-config.json`, CONFIG_PATH],
  [`${DSH_HOME}/toolctl-debug.log`, DEBUG_LOG],
]) {
  try {
    if (existsSync(legacy) && !existsSync(current)) renameSync(legacy, current)
  } catch {}
}

// 配置三层，面板可改、源码给默认值：
//   groups            —— 分组规则（纯数据，可序列化）
//   neverHide         —— 永不隐藏的工具名（在 groups 之上再兜一层，追加）
//   neverHideReplace  —— 替换 NEVER_HIDE 基础名单（控制面三件套除外，钉死）
//   hiddenGroups      —— 新建会话默认隐藏哪些组；null = 全部隐藏
//   idleCalls         —— 空闲收回阈值
//   mcpGroups         —— false 关掉 MCP 自动分组
//   hideInSubagents   —— true 时子代理也按同样规则藏（默认 false：子代理没有 loadout，藏了是死路，开它风险自负）
//   sensitive         —— 给数组则整体替换 tools_call 的外发/执行类黑名单
//   sensitiveExtra    —— 往默认黑名单追加
//   healText          —— UNKNOWN_TOOL 自愈引导文案模板，{tool} {group} 占位；null 用内置文案
//   catalogNote       —— 目录末尾追加的自定义行（string，null 不加）
//   reviewWindowDays  —— review/stats 排行的近 N 天窗口，默认 30
//   trial             —— 新插件观察区：启动窗口后新出现的未认领工具进隐藏的 trial 组（false 关掉，迟到的工具退回直接可见）
//   trialPromoteAfter —— trial 组工具被调用多少次自动转正回可见，默认 3
//   gatedGroups       —— 可见性当权限：这些组 activate 时要用户确认（模型带 confirm:true 重试）；null = 内置默认 ssh/email/kimi-cu，[] = 不Gate任何组
//   cut               —— 读外网切断外联：浏览器/网页读取一调用，当轮自动藏掉发邮件、ssh、IM 等外发组（默认关，按需开）
//   cutLasts          —— 切断持续多少个工具调用（兜底：宿主发 turn/end 会当轮提前恢复）
//   cutGroups         —— 切断时隐藏哪些组；null = 内置默认，[] = 不切
//   cutTriggers       —— 哪些组的工具算"读了外网"；null = 内置默认 chrome-devtools/search-ext
//   cutTriggerTools   —— 哪些裸工具名算"读了外网"；null = 内置默认 web_fetch/web_search
//   modes             —— 模式切换表：{ 名字: { label, activate: [], hide: [] } }，同名覆盖内置、新名新增；null = 只用内置四档
const DEFAULT_CONFIG = {
  groups: null, neverHide: null, neverHideReplace: null, hiddenGroups: null,
  idleCalls: IDLE_CALLS, mcpGroups: null, hideInSubagents: false,
  sensitive: null, sensitiveExtra: null, healText: null, catalogNote: null,
  reviewWindowDays: 30, catalogMode: 'full',
  trial: true, trialPromoteAfter: 3, gatedGroups: null,
  cut: false, cutLasts: 30, cutGroups: null, cutTriggers: null, cutTriggerTools: null,
  modes: null,
}

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

// 真正危险的工具：外发、远程执行、删除、花钱。tools_call 拒绝这几类。
// 2026-10-27 起可配置：config.sensitive 给数组则整体替换，config.sensitiveExtra 追加。
// 注意：定义必须在 NEVER_HIDE 之后（test-grouping/_sim 从 NEVER_HIDE 切片取纯逻辑，
// effectiveSensitive 依赖它，得留在切片窗口里）。
// 边界原则：只藏"有人认领"的工具。没被任何规则命中的一律可见（fail-open），
// 不存在兜底隐藏组——新装插件的工具第一次露面就是可见的，再由 loadout review 提示补规则。
//
// 为什么删掉原来的 extras 兜底组：它按"没匹配上"来藏，而工具注册表里天然包含
// 本插件自己的控制面（loadout / tools_search / tools_call）。元工具一注册就触发
// tools/change → 重归组 → 被自己归进 extras → 下一次 deny 把它们也藏掉，
// 于是没有任何按钮能把 221 个工具放出来。打补丁（加 3 行豁免）只是让这个坑晚点再出现：
// 任何新插件、任何迟到的 MCP 工具都会掉进同一个兜底组。根因是"未知即隐藏"这个方向反了，
// 所以改成"未知即可见"——隐藏必须由显式规则认领。
const NEVER_HIDE = new Set([
  'loadout', 'tools_search', 'tools_call',        // 本插件控制面：藏了就再也放不出来
  'absorb', 'compress', 'decompress',              // ACP 压缩/吸收协议，宿主会随时点名
])

// 控制面三件套：任何配置都动不了它们（neverHideReplace 也不行）。理由和 HTTP 三道闸一样：
// 配置化可以，自锁留门不行——这三个被藏了就没有任何按钮能放出来。
const CONTROL_PLANE = ['loadout', 'tools_search', 'tools_call']

// 2026-10-27 全配置化：生效名单 = 控制面（钉死）+ 基础名单（默认 NEVER_HIDE，config.neverHideReplace 可换）+ config.neverHide 追加
function effectiveNeverHide(config = {}) {
  const base = Array.isArray(config.neverHideReplace) ? config.neverHideReplace.map(String) : [...NEVER_HIDE]
  return new Set([...CONTROL_PLANE, ...base, ...(Array.isArray(config.neverHide) ? config.neverHide.map(String) : [])])
}

// 可见性当权限：这些组的 activate 要用户确认（config.gatedGroups 给数组则整体替换，null 用默认）。
// 外发/执行/桌面操作类，模型一句"激活"不该等于授权；确认走 confirm:true，配合租约按次授权。
const DEFAULT_GATED = ['ssh', 'email', 'kimi-cu']
function effectiveGated(config = {}) {
  return new Set(Array.isArray(config.gatedGroups) ? config.gatedGroups.map(String) : DEFAULT_GATED)
}

// 读外网切断外联：读到不可信内容后，当轮把外发/执行组从可见性里拿掉。
// 提示注入要三件套（读得到私有数据、读到不可信内容、手里有外发工具），这条砍第三个。
// 触发面：浏览器组、进阶检索组（网页正文批量读），以及裸工具 web_fetch/web_search。
const DEFAULT_CUT_GROUPS = ['email', 'ssh', 'kimi-cu', 'bili', 'tieba', 'ops', 'mcp-connector', 'sandbox']
const DEFAULT_CUT_TRIGGER_GROUPS = ['chrome-devtools', 'search-ext']
const DEFAULT_CUT_TRIGGER_TOOLS = ['web_fetch', 'web_search']
function effectiveCutGroups(config = {}) {
  return new Set(Array.isArray(config.cutGroups) ? config.cutGroups.map(String) : DEFAULT_CUT_GROUPS)
}
function effectiveCutTriggerGroups(config = {}) {
  return new Set(Array.isArray(config.cutTriggers) ? config.cutTriggers.map(String) : DEFAULT_CUT_TRIGGER_GROUPS)
}
function effectiveCutTriggerTools(config = {}) {
  return new Set(Array.isArray(config.cutTriggerTools) ? config.cutTriggerTools.map(String) : DEFAULT_CUT_TRIGGER_TOOLS)
}

// 模式切换：一个开关切整套组。内置四档；config.modes 按同名覆盖、新名新增。
// 语义是一次性开关操作：只动 activate/hide 列出的组，其他组保持当前状态（不做全量重置）。
const BUILTIN_MODES = {
  coding: { label: '写代码', activate: ['ssh', 'context7', 'chrome-devtools'], hide: [] },
  writing: { label: '写材料', activate: ['univer', 'search-ext'], hide: [] },
  ops: { label: '运维', activate: ['ops', 'ssh', 'sandbox', 'mcp-connector'], hide: [] },
  review: { label: '只读审阅', activate: [], hide: ['ssh', 'email', 'kimi-cu', 'bili', 'tieba', 'ops', 'mcp-connector', 'sandbox', 'univer', 'schedule'] },
}
function effectiveModes(config = {}) {
  const custom = (config.modes && typeof config.modes === 'object' && !Array.isArray(config.modes)) ? config.modes : {}
  const out = { ...BUILTIN_MODES }
  for (const [k, m] of Object.entries(custom)) {
    if (!m || typeof m !== 'object') continue
    out[String(k)] = {
      label: String(m.label ?? k),
      activate: Array.isArray(m.activate) ? m.activate.map(String) : [],
      hide: Array.isArray(m.hide) ? m.hide.map(String) : [],
    }
  }
  return out
}

// 同理：config.sensitive 给数组整体替换，否则 SENSITIVE + config.sensitiveExtra 追加
function effectiveSensitive(config = {}) {
  if (Array.isArray(config.sensitive)) return new Set(config.sensitive.map(String))
  return new Set([...SENSITIVE, ...(Array.isArray(config.sensitiveExtra) ? config.sensitiveExtra.map(String) : [])])
}

const SENSITIVE = new Set([
  'email_send', 'email_reply', 'email_draft', 'email_mark',
  'ssh_exec', 'ssh_cluster', 'ssh_upload', 'ssh_download',
  'workbuddy_draw_image',
  'present', 'plugin_manager', 'backup_dsh',
  'mnemon_remember', 'mnemon_forget', 'mnemon_document_create', 'mnemon_document_manage',
])

// 分组规则：纯数据，可序列化——面板和 loadout-config.json 都能覆盖。
// 不藏的东西（写在这里当文档）：meta 工具、宿主每轮都点名的协议工具、
// agent 作用域里注册的团队工具（send_message / spawn_teammate 等，restrict 本来也够不到）、
// 以及任何没被下面规则认领的工具。
const BUILTIN_GROUPS = [
  {
    name: 'univer',
    desc: 'Univer 办公文档：.univer 文件的表格/文档/幻灯片创建、编辑、渲染、导入导出',
    prefixes: ['univer_'],
  },
  {
    name: 'email',
    desc: '邮件：列信、读信、发送、回复、搜索、整理文件夹、草稿',
    prefixes: ['email_'],
  },
  {
    name: 'ssh',
    desc: 'SSH 远程主机：执行命令、上传下载、端口隧道、集群批量',
    prefixes: ['ssh_'],
  },
  {
    name: 'mnemon',
    desc: '记忆管理：写记忆、建空间、建档案、遗忘、关联（读记忆不用激活）',
    prefixes: ['mnemon_'],
  },
  {
    name: 'mcp-connector',
    desc: 'MCP 连接器管理：连/断服务器、健康检查、配置连接、工具治理、按会话激活',
    prefixes: ['mcp_connector_'],
  },
  {
    name: 'sandbox',
    desc: 'DSH 桌面沙箱：启停、装插件、扫描、修配置',
    prefixes: ['dsh_ops_sandbox_'],
  },
  {
    name: 'ops',
    desc: '宿主运维：插件安装管理、备份、看图识图、交付卡片、侧边栏',
    names: [
      'plugin_manager', 'backup_dsh', 'codebuddy_ask', 'modlens_read_image',
      'workbuddy_draw_image', 'sidebar_open', 'present', 'exit_plan_mode',
      'diff_approval_annotate', 'ops_discover_tools', 'cordis_inspect_list',
      'cordis_inspect_query', 'workflow',
    ],
  },
  {
    name: 'search-ext',
    desc: '进阶检索：平台内搜索、学术文献、多源并发、网页正文批量读、视频、天气',
    names: [
      'advanced_search', 'multi_search', 'research', 'platform_search', 'video_search',
      'free_search_test', 'cache_search', 'read_url', 'read_url_batch', 'read_url_links',
      'read_url_site', 'weather', 'domain_search',
    ],
  },
  {
    name: 'bili',
    desc: 'B 站互动：搜索、投币、评论、私信、收藏、字幕、动态',
    prefixes: ['bili_'],
  },
  {
    name: 'tieba',
    desc: '贴吧：滚动、吧规样式、日记读写、演化控制',
    prefixes: ['tieba_'],
  },
  {
    name: 'acp',
    desc: 'ACP 上下文压缩：缓存查询、读原图、状态',
    prefixes: ['acp_'],
  },
  {
    name: 'schedule',
    desc: '定时提醒：创建/列出/修改/删除会话内提醒',
    prefixes: ['schedule_'],
  },
  {
    name: 'goal',
    desc: '长目标：跨轮自动续跑的目标创建与查看',
    names: ['create_goal', 'update_goal', 'get_goal'],
  },
  {
    name: 'mcp-resource',
    desc: 'MCP 资源读取：列资源/模板、按 uri 读单个资源',
    prefixes: ['list_mcp_resource', 'read_mcp_resource'],
  },
]

// 把一条规则归一成可比较的形式（面板/SQLite 里存的是字符串，不是函数）
function parseRule(rule) {
  const prefixes = Array.isArray(rule?.prefixes) ? rule.prefixes.map(String) : []
  const names = Array.isArray(rule?.names) ? new Set(rule.names.map(String)) : null
  const patterns = Array.isArray(rule?.patterns)
    ? rule.patterns.map((p) => {
        try { return new RegExp(String(p)) } catch { return null }
      }).filter(Boolean)
    : []
  return { prefixes, names, patterns }
}

function matchGroup(rules, toolName) {
  for (const rule of rules) {
    const { prefixes, names, patterns } = parseRule(rule)
    if (names?.has(toolName)) return rule.name
    for (const p of prefixes) if (toolName.startsWith(p)) return rule.name
    for (const re of patterns) if (re.test(toolName)) return rule.name
  }
  return null
}

function buildGroups(schemaNames, config = {}, trialSet = null) {
  // 规则来源：配置文件优先（面板可改），否则内置。MCP 自动分组始终保留。
  const rules = Array.isArray(config.groups) && config.groups.length > 0
    ? config.groups
    : BUILTIN_GROUPS
  const mcpEnabled = config.mcpGroups !== false

  const mcpGroups = new Map() // serverName -> { name, desc, tools: [] }
  const ruleGroups = new Map() // groupName -> { name, desc, tools: [], rule }
  for (const g of rules) {
    if (!g?.name) continue
    ruleGroups.set(g.name, { name: g.name, desc: String(g.desc ?? ''), tools: [], rule: g })
  }

  const toolToGroup = new Map()
  const unmatched = []
  const neverHide = effectiveNeverHide(config)

  // 新插件观察区：启动窗口之后才出现的未认领工具进隐藏的 trial 组，用过 N 次自动转正。
  // 控制面在上面的 neverHide 检查里已排除，永远到不了这里；规则/MCP 认领的也到不了（先匹配）。
  const promoteAfter = Number(config.trialPromoteAfter) > 0 ? Number(config.trialPromoteAfter) : 3
  const trial = trialSet && config.trial !== false
    ? { name: 'trial', desc: `新插件观察区：启动后才出现的未认领工具，默认隐藏，用过 ${promoteAfter} 次自动转正`, tools: [] }
    : null

  for (const name of schemaNames) {
    // 控制面与协议工具永不归组（藏了就没人能放出来）
    if (neverHide.has(name)) continue
    // 规则 1：MCP 工具按 server 分组建组
    if (mcpEnabled) {
      const mcpMatch = name.match(/^mcp__([^_]+(?:_[^_]+)*)__/)
      if (mcpMatch) {
        const serverName = mcpMatch[1]
        if (!mcpGroups.has(serverName)) {
          mcpGroups.set(serverName, { name: serverName, desc: `MCP server: ${serverName}`, tools: [] })
        }
        mcpGroups.get(serverName).tools.push(name)
        toolToGroup.set(name, serverName)
        continue
      }
    }
    // 规则 2：显式规则认领（前缀/全名/正则）
    const gName = matchGroup(rules, name)
    if (gName && ruleGroups.has(gName)) {
      ruleGroups.get(gName).tools.push(name)
      toolToGroup.set(name, gName)
      continue
    }
    // 没规则认领：启动窗口后才出现的新工具进 trial 观察组（默认隐藏，用过 N 次转正）；
    // 一直在的未认领工具保持可见——fail-open 方向不变，观察区只收"迟到者"。
    if (trial && trialSet.has(name)) {
      trial.tools.push(name)
      toolToGroup.set(name, 'trial')
    } else {
      unmatched.push(name)
    }
  }

  // 空组也保留：面板要能看到"这条规则在本机没匹配到任何工具"
  const groups = [...mcpGroups.values(), ...ruleGroups.values(), ...(trial && trial.tools.length > 0 ? [trial] : [])]
  const byName = new Map(groups.map((g) => [g.name, g]))

  return { groups, byName, toolToGroup, unmatched, trial: trial ? new Set(trial.tools) : new Set() }
}

// 2026-10-27 改版：从"每组三个代表名"改成"全量名字可见"（消边界，不是打补丁）。
// 洞的根子是"模型不知道它不知道什么"——名字全摆出来，存在的感知不缺了，
// 剩下的只是"没 schema 不能直接调"，这条必须在首行写明约束（Aiden 指正：
// 没有 harness 层约束，模型看到清单的默认反应就是直接调，自愈触发反而会上升）。
// opts.mode: 'full'（默认，全量名单）| 'compact'（旧版三个代表名，留作 A/B 对照）。
function buildCatalog(byName, opts = {}) {
  const idle = Number(opts.idleCalls) > 0 ? Number(opts.idleCalls) : IDLE_CALLS
  const full = opts.mode !== 'compact'
  const lines = [
    '## 工具分组（按需激活）',
    '',
    '下列工具**不在你的工具列表里**，直接调用会报 "Unknown tool"。要用时二选一：',
    '1. 连续用同组的多个工具：先 loadout {"action":"activate","group":"<组名>"} 激活整组（当轮生效），然后原样用工具名调用。',
    '2. 只偶尔用一两个：先 tools_search 查它的完整 schema，再 tools_call 按名字执行（参数放 args）。',
    '3. loadout {"action":"list"} 查看各组隐藏/激活状态和当前会话的真实开关。',
    '4. 别用同族可见工具替代你要调的工具——先激活或搜索，再调用。',
    '5. 组在连续 ' + idle + ' 次工具调用未被使用后自动收回，可再 activate。',
    '6. 未列入下表的工具始终可见，不需要激活。',
    '7. 已知的 skill→组 对应：univer/office 类 skill → univer；邮件类任务 → email；远程主机 → ssh；MCP 连接器配置 → mcp-connector；浏览器自动化 → chrome-devtools；Windows 桌面操作 → kimi-cu。',
    '',
    '| 组名 | 什么时候用 | 工具数 |',
    '|---|---|---|',
  ]
  for (const [name, row] of byName) {
    if (row.tools.length === 0) continue
    lines.push(`| ${name} | ${row.desc} | ${row.tools.length} |`)
  }
  if (full) {
    // 全量名单：名字全可见，模型永远知道有什么；schema 仍藏着，走 activate 或 tools_search
    lines.push('', '### 全量工具名（按组）', '')
    for (const [name, row] of byName) {
      if (row.tools.length === 0) continue
      lines.push(`**${name}**：${row.tools.join(', ')}`, '')
    }
  } else {
    // compact：旧版 A/B 对照，每组只给三个代表名
    lines.push('', '### 代表工具（compact 对照模式）', '')
    for (const [name, row] of byName) {
      if (row.tools.length === 0) continue
      const sample = row.tools.slice(0, 3).join(', ')
      const more = row.tools.length > 3 ? ` 等 ${row.tools.length} 个` : ''
      lines.push(`- **${name}**：${sample}${more}`)
    }
  }
  lines.push('', '未列入上表的工具始终可用。')
  if (Number(opts.unmatchedCount) > 0) {
    lines.push(`另有 ${opts.unmatchedCount} 个工具未归组，默认可见。`)
  }
  // 配置目录末尾追加自定义行（catalogNote），面板可改
  if (typeof opts.extra === 'string' && opts.extra.trim()) {
    lines.push('', ...opts.extra.split('\n'))
  }
  return lines.join('\n')
}

const agents = new Map() // agentId -> state
// toolName -> { total, days: { 'YYYY-MM-DD': n } }。带日期的桶是 2026-10-27 加的：
// review 的阈值不再拍脑袋（原来的 >=5 / >=3 是拍的，已废），改为按近 30 天窗口算，
// 月份尺度的分析也能从 days 直接聚合。旧格式（纯数字）加载时自动转换。
const stats = new Map()
{
  try {
    if (existsSync(STATS_PATH)) {
      const raw = JSON.parse(readFileSync(STATS_PATH, 'utf8'))
      for (const [k, v] of Object.entries(raw ?? {})) {
        stats.set(k, typeof v === 'number' ? { total: v, days: {} } : v)
      }
    }
  } catch (e) { /* 加载失败就当新装，不阻塞启动 */ }
}
function statTotal(name) { return stats.get(name)?.total ?? 0 }
function reviewWindow() {
  const n = Number(loadConfig().reviewWindowDays)
  return n > 0 ? Math.min(Math.round(n), 365) : 30
}
function statWindow(name, days) {
  const e = stats.get(name)
  if (!e) return 0
  const cutoff = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10)
  let s = 0
  for (const [d, c] of Object.entries(e.days ?? {})) if (d >= cutoff) s += c
  return s
}
let statsDirty = 0
let statsWriting = false

// 验收用的计数：自愈触发次数、搜索命中/未命中、代理调用次数。
// 设计清单要求"只看日志就能回答"，这几项就是那几个答案。
const metrics = { heal: 0, searchHit: 0, searchMiss: 0, proxyCall: 0, proxyRejected: 0 }

function bumpHeal() { metrics.heal++ }

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
  const day = new Date().toISOString().slice(0, 10)
  let e = stats.get(name)
  if (!e) { e = { total: 0, days: {} }; stats.set(name, e) }
  e.total++
  e.days[day] = (e.days[day] ?? 0) + 1
  if (++statsDirty >= 20) {
    statsDirty = 0
    queueMicrotask(() => flushStats(() => {}))
  }
}

function trimLog(st) {
  if (st.applyLog.length > 10) st.applyLog.splice(0, st.applyLog.length - 10)
}

// 检查租约：时限到期或次数用尽 → 收回该组。返回是否发生了收回。
function enforceLeases(st, byName, log, agentId) {
  if (!st.leases) return false
  let changed = false
  for (const [gName, lease] of Object.entries(st.leases)) {
    if (st.hidden.has(gName)) { delete st.leases[gName]; continue }
    if (!lease.until && !lease.maxCalls) { delete st.leases[gName]; continue }
    let expired = false
    if (lease.until && Date.now() > lease.until) expired = true
    if (lease.maxCalls && lease.used >= lease.maxCalls) expired = true
    if (expired) {
      st.hidden.add(gName)
      delete st.lastUsed[gName]
      delete st.leases[gName]
      applyMask(st, byName, log, `lease-expire:${gName}`)
      log(`agent ${agentId}: group ${gName} reclaimed (lease expired)`)
      changed = true
    }
  }
  return changed
}

function denyList(st, byName) {
  const out = []
  for (const g of st.hidden) {
    const row = byName.get(g)
    if (row) out.push(...row.tools)
  }
  // 读外网切断外联：cut 生效期间，外发组无论是否激活都进 deny。
  // 不动 st.hidden——切的是"可见性"不是"用户意图"，到期或 turn/end 自动还原。
  if (st.cut && st.tick < st.cut.untilTick) {
    for (const g of st.cut.groups) {
      const row = byName.get(g)
      if (row) out.push(...row.tools)
    }
  }
  return out
}

// 报错自愈用的引导文案：被隐藏的工具直接调用时返回 UNKNOWN_TOOL，
// 这里把错误改写成"下一步做什么"，模型不必自己猜。
function healHint(toolName, toolToGroup, st, config = {}) {
  const g = toolToGroup.get(toolName)
  if (!g || !st?.hidden.has(g)) return null
  // 自定义文案模板：{tool} {group} 两个占位符
  if (typeof config.healText === 'string' && config.healText.trim()) {
    return config.healText.split('{tool}').join(toolName).split('{group}').join(g)
  }
  const gatedNote = effectiveGated(config).has(g)
    ? `注意：${g} 是外发/执行类，激活需要你确认——先向用户说明用途，得到同意后带 "confirm":true 重试。`
    : ''
  return `工具 "${toolName}" 属于组 ${g}，当前被隐藏，不能直接调。两条路：① 连续用同组多个：loadout {"action":"activate","group":"${g}"}（当轮生效）后原样重试；② 只用一次：tools_search 查它的 schema，再 tools_call 执行。不要换个工具绕过去。${gatedNote}`
}

// 子代理（有 owner 的 agent）不给隐藏：它拿不到 loadout，藏了就是死路。
// 设计清单原本写「子代理按任务激活对应组」，实际做不到——创建时拿不到任务，
// 而子代理一旦被藏就没人能解套（loadout 在子代理作用域里不可用），
// 所以走最保守的一条：子代理全量可见，任务做完就没了。
function isChildAgent(ctx, id) {
  try {
    const svc = ctx.get('agents')
    if (!svc || typeof svc.list !== 'function' || typeof svc.roots !== 'function') return false
    const live = svc.list()
    const roots = svc.roots()
    if (!Array.isArray(live) || !Array.isArray(roots)) return false
    // 必须先确认这个 id 已在注册表里，否则 roots()/list() 的时序竞争会误判
    if (!live.some((a) => a?.id === id)) return false
    return !roots.some((a) => a?.id === id)
  } catch {
    return false
  }
}

// 代理调用的参数校验：只查两件靠 schema 能确定的事——必填项缺了、多传了不认的字段。
// 返回 null 表示没问题，返回字符串表示错误原因。
function checkArgs(schema, args) {
  if (schema.type && schema.type !== 'object') return null
  const val = args === undefined || args === null ? {} : args
  if (typeof val !== 'object' || Array.isArray(val)) return `args 必须是对象，收到 ${Array.isArray(val) ? 'array' : typeof val}`
  const req = Array.isArray(schema.required) ? schema.required : []
  const missing = req.filter((k) => val[k] === undefined)
  if (missing.length > 0) return `缺少必填参数：${missing.join(', ')}`
  if (schema.additionalProperties === false && schema.properties) {
    const known = new Set(Object.keys(schema.properties))
    const extra = Object.keys(val).filter((k) => !known.has(k) && val[k] !== undefined)
    if (extra.length > 0) return `有 schema 不认的参数：${extra.join(', ')}`
  }
  return null
}

// 粗略 token 估算：schema 的 JSON 字符数 / 4。只用来观察趋势，不是精确计费。
function approxTokens(schemas) {
  try {
    return Math.round(JSON.stringify(schemas).length / 4)
  } catch {
    return 0
  }
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
      // token 观测：把"这一轮模型实际看到多少 schema"记下来，验收时才有数可看。
      let visibleTokens = 0
      try {
        const all = st.agentCtx.tools.schemas()
        const hidden = new Set(deny)
        visibleTokens = approxTokens(all.filter((s) => !hidden.has(s.name)))
      } catch {}
      st.lastVisibleTokens = visibleTokens
      dbg(`applyMask(${label}) ok deny=${deny.length} visibleTokens≈${visibleTokens} tools=${deny.slice(0, 3).join('|')}`)
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
  let unmatched = []
  let lastKey = ''
  // 上一次归组时的组名集合：tools/change 后新出现的组要对已有会话补"默认隐藏"，
  // 否则 trial 组、新 MCP server 组对已开着的会话等于默认放行（新建会话不受影响）。
  let prevGroupKeys = new Set()

  // 新插件观察区状态。baseline = 启动窗口（35 秒）内出现过的工具集合——窗口期内的迟到者
  // 算 baseline（覆盖启动时序竞争：3s/10s/30s 重试才注册的工具不该进观察区）；
  // 窗口结束后新出现的未认领工具进隐藏的 trial 组；promoted = 已转正名单，持久化跨重启不丢。
  const baseline = new Set()
  let seededBaseline = false
  // baselineWindowMs 仅供测试注入（smoke 里把窗口压到 1ms 才能模拟"迟到工具"）；
  // 正常运行没有配置项，走 35 秒默认。
  const baselineUntil = Date.now() + (Number(config?.baselineWindowMs) > 0 ? Number(config.baselineWindowMs) : 35000)
  let promoted = new Set()
  try {
    if (existsSync(TRIAL_PATH)) promoted = new Set(JSON.parse(readFileSync(TRIAL_PATH, 'utf8'))?.promoted ?? [])
  } catch { promoted = new Set() }
  const saveTrial = () => {
    try { writeFileSync(TRIAL_PATH, JSON.stringify({ promoted: [...promoted].sort() }, null, 1), 'utf8') } catch {}
  }

  const reGroup = (label) => {
    let names = []
    try {
      names = ctx.tools.schemas().map((s) => s.name).sort()
    } catch (e) {
      log(`schemas() failed (${label}): ${e?.message ?? e}`)
      return false
    }
    const beforeKeys = new Set(byName.keys())
    // 配置变了也要重算，不只是工具表变了才重算
    const cfgNow = loadConfig()
    // 观察区候选：baseline 之外、未转正的工具。
    // 首次归组的快照无条件进 baseline（启动快照永远可信）；窗口期内的迟到者并入 baseline。
    if (!seededBaseline) { for (const n of names) baseline.add(n); seededBaseline = true }
    else if (Date.now() < baselineUntil) for (const n of names) baseline.add(n)
    const trialCand = new Set()
    if (cfgNow.trial !== false) {
      for (const n of names) {
        if (!baseline.has(n) && !promoted.has(n)) trialCand.add(n)
      }
    }
    const key = names.join(',') + '|' + JSON.stringify({ g: cfgNow.groups, n: cfgNow.neverHide, nr: cfgNow.neverHideReplace, m: cfgNow.mcpGroups, t: cfgNow.trial, tp: cfgNow.trialPromoteAfter, bs: baseline.size, p: [...promoted].sort() })
    if (key === lastKey) return false
    lastKey = key
    const built = buildGroups(names, cfgNow, trialCand)
    prevGroupKeys = beforeKeys
    byName = built.byName
    toolToGroup = built.toolToGroup
    unmatched = built.unmatched
    log(`reGroup(${label}): ${names.length} tools, ${built.toolToGroup.size} grouped/${unmatched.length} visible, ${byName.size} groups`)
    return true
  }
  reGroup('startup')
  dbg(`startup: groups=${byName.size} toolToGroup=${toolToGroup.size} unmatched=${unmatched.length}`)
  if (byName.size === 0) {
    // 启动时工具表可能还没注册完（时序竞争），不能整体退出——
    // 监听器照常挂，等 tools/change 或下面的重试把它救活。
    log('no groups built at startup (tool registry not ready?), staying alive and retrying')
  }

  // 1b. 兜底重试：启动后工具注册若没发 tools/change，延迟重归组并对存活 agent 重算 mask
  try {
    const RETRY_DELAYS = [3000, 10000, 30000]
    for (const delay of RETRY_DELAYS) {
      const t = setTimeout(() => {
        try {
          const changed = reGroup(`retry@${delay}`)
          // 补默认掩码只针对"创建时组表还是空的"那些 agent。
          // 不能拿 hidden.size === 0 当条件——用户把组全激活后 hidden 恰好也是空集，
          // 那样会被误判成"没初始化过"，把刚打开的工具又全藏回去。
          let seeded = 0
          for (const st of agents.values()) {
            if (!st.groupedAtCreation && byName.size > 0) {
              const cfgNow = loadConfig()
              const configured = Array.isArray(cfgNow.hiddenGroups) ? new Set(cfgNow.hiddenGroups) : null
              st.hidden = new Set([...byName.keys()].filter((n) => {
                if (byName.get(n).tools.length === 0) return false
                return configured ? configured.has(n) : true
              }))
              st.groupedAtCreation = true
              seeded++
            }
          }
          if (changed || seeded > 0) {
            for (const st of agents.values()) applyMask(st, byName, log, `retry@${delay}`)
            log(`retry@${delay}: groups=${byName.size}, ${seeded} agent(s) seeded, masks reapplied to ${agents.size}`)
          }
        } catch (e) {
          log(`retry@${delay} failed: ${e?.message ?? e}`)
        }
      }, delay)
      if (t?.unref) t.unref()
    }
  } catch (e) {
    log(`retry timer setup failed: ${e?.message ?? e}`)
  }

  // 2. 目录常驻系统提示
  try {
    ctx.inject(['systemPrompt'], (inner) => {
      try {
        inner.systemPrompt.section({
          name: 'tool-groups',
          order: inner.systemPrompt.getSectionOrder('MCP_SERVERS'),
          interpolate: false,
          text: () => buildCatalog(byName, { idleCalls, unmatchedCount: unmatched.length, extra: loadConfig().catalogNote, mode: loadConfig().catalogMode }),
        })
        log('catalog section registered')
      } catch (e) {
        log(`catalog section failed: ${e?.message ?? e}`)
      }
    })
  } catch (e) {
    log(`systemPrompt inject failed: ${e?.message ?? e}`)
  }

  // 3. agent 建掩码。两条入口：
  //    a) agent/created（正常路径）
  //    b) adoptExistingAgents（插件热重载/晚装时，已存在的 agent 不会再发 created）
  //    少了 b，热重载后 agents 表是空的，看着"插件加载了"其实什么都没管。
  function seedAgent(agent, source) {
    const agentCtx = agent?.ctx ?? null
    const id = agent?.id ?? 'unknown'
    if (!agentCtx) { log(`seed(${source}) ${id}: no ctx, skip`); return }
    // 子代理默认不藏：它没有 loadout 可用，藏了就是死路（设计清单的"按任务激活"做不到）。
    // config.hideInSubagents=true 可强制子代理也藏——这是显式开闸，风险自负。
    const child = isChildAgent(ctx, id)
    const cfgNow = loadConfig()
    const configured = (child && cfgNow.hideInSubagents !== true) ? new Set() : (Array.isArray(cfgNow.hiddenGroups) ? new Set(cfgNow.hiddenGroups) : null)
    const st = {
      hidden: new Set([...byName.keys()].filter((n) => {
        if (byName.get(n).tools.length === 0) return false
        return configured ? configured.has(n) : true
      })),
      // 只有"创建时组表已就绪"的 agent 才可信；零组时期建的 agent 要补一次默认掩码。
      groupedAtCreation: byName.size > 0,
      child,
      disposer: null, agentCtx, tick: 0, lastUsed: {}, applyLog: [], leases: {},
      cut: null, mode: null,
    }
    agents.set(id, st)
    applyMask(st, byName, log, source)
    try {
      agentCtx.effect(() => () => {
        const s = agents.get(id)
        if (s?.disposer) { try { s.disposer() } catch {} }
        agents.delete(id)
      })
    } catch {}
    log(`agent ${id} (${source}): ${st.hidden.size} groups hidden${child ? ' [child, nothing hidden]' : ''}`)
  }

  // 已存在的 agent 也要接管：热重载后它们不重发 agent/created
  function adoptExistingAgents(label) {
    let live = []
    try {
      const svc = ctx.get('agents')
      live = typeof svc?.list === 'function' ? svc.list() : []
    } catch (e) {
      dbg(`adopt(${label}): agents service unavailable (${e?.message ?? e})`)
      return 0
    }
    let n = 0
    for (const a of live) {
      const id = a?.id
      if (!id || agents.has(id)) continue
      try { seedAgent(a, `adopt:${label}`); n++ } catch (e) {
        log(`adopt(${label}) ${id} failed: ${e?.message ?? e}`)
      }
    }
    if (n > 0) log(`adopt(${label}): took over ${n} existing agent(s)`)
    return n
  }

  ctx.on('agent/created', function (payload) {
    try {
      dbg(`agent/created id=${payload?.agent?.id ?? '?'} groups=${byName.size} source=${payload?.source ?? '?'}`)
      seedAgent(payload?.agent, 'created')
    } catch (e) {
      log(`agent/created handler crashed (fail-open, no restriction): ${e?.message ?? e}`)
    }
  })

  // 立刻接管当前已在跑的 agent（本进程启动时已有会话、或插件被热重载时）
  adoptExistingAgents('startup')
  const adoptTimer = setTimeout(() => {
    try { adoptExistingAgents('late@2s') } catch {}
  }, 2000)
  if (adoptTimer?.unref) adoptTimer.unref()

  // 4. 工具调用：统计 + 组内命中刷新 + 空闲收回
  try {
    ctx.on('tools/result', (exec) => {
      try {
        if (exec?.name) bumpStat(exec.name)
        // 观察区转正：trial 组工具调用够次数 → 转正回可见，全局生效并持久化
        if (exec?.name && toolToGroup.get(exec.name) === 'trial') {
          const cfgT = loadConfig()
          const needT = Number(cfgT.trialPromoteAfter) > 0 ? Number(cfgT.trialPromoteAfter) : 3
          if (statTotal(exec.name) >= needT) {
            promoted.add(exec.name)
            saveTrial()
            log(`trial: ${exec.name} promoted after ${statTotal(exec.name)} calls`)
            const changed = reGroup('trial-promote')
            if (changed) for (const st of agents.values()) applyMask(st, byName, log, 'trial-promote')
          }
        }
        const id = exec?.agent?.id
        const st = agents.get(id)
        if (!st) return
        st.tick++
        const g = toolToGroup.get(exec?.name)
        if (g && !st.hidden.has(g)) {
          st.lastUsed[g] = st.tick
          if (st.leases?.[g]) st.leases[g].used++
        }
        // 读外网切断外联：触发工具命中 → 当轮切断外发组；到期（或宿主 turn/end）恢复。
        // 不动 st.hidden，切的是可见性，到期自动还原用户的组开关状态。
        const cfgC = loadConfig()
        if (cfgC.cut !== false && exec?.name) {
          const triggered = (g && effectiveCutTriggerGroups(cfgC).has(g)) || effectiveCutTriggerTools(cfgC).has(exec.name)
          if (triggered && !st.cut) {
            const groups = [...effectiveCutGroups(cfgC)].filter((x) => byName.get(x)?.tools.length > 0)
            if (groups.length > 0) {
              const lasts = Number(cfgC.cutLasts) > 0 ? Number(cfgC.cutLasts) : 30
              st.cut = { untilTick: st.tick + lasts, groups }
              applyMask(st, byName, log, `cut:${exec.name}`)
              log(`agent ${id}: outbound cut after ${exec.name} (until tick ${st.cut.untilTick})`)
            }
          }
        }
        if (st.cut && st.tick >= st.cut.untilTick) {
          st.cut = null
          applyMask(st, byName, log, 'cut-expire')
          log(`agent ${id}: outbound restored (cut expired)`)
        }
        enforceLeases(st, byName, log, id)
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

  // 4b. 切断的精确收尾：宿主发 turn/end 就当轮恢复（不解析载荷，一刀切清全部 agent 的 cut——
  // 各会话同属机主，提前解除另一会话的切断只是保守度略降，不是授权扩大）。
  // 宿主不发此事件（旧版或形状不符）就靠 cutLasts 次调用后自动恢复兜底。
  try {
    ctx.on('turn/end', () => {
      try {
        let n = 0
        for (const st of agents.values()) {
          if (!st.cut) continue
          st.cut = null
          applyMask(st, byName, log, 'cut-turn-end')
          n++
        }
        if (n > 0) log(`turn/end: outbound restored for ${n} agent(s)`)
      } catch {}
    })
  } catch {}

  // 5. 报错自愈：模型直接调用被隐藏的工具会拿到 UNKNOWN_TOOL，
  // 这里把它改写成"先激活某组"，省掉模型瞎猜和绕路。
  try {
    ctx.on('tools/post-execute', async (exec, result, next) => {
      const passed = await next()
      try {
        if (!passed?.isError) return passed
        if (passed.error?.info?.code !== 'UNKNOWN_TOOL') return passed
        const st = agents.get(exec?.agent?.id)
        const hint = healHint(exec?.name, toolToGroup, st, loadConfig())
        if (!hint) {
          // 组没在 hidden 里却报 UNKNOWN_TOOL —— 多半是 cut 期间的外发组：给切断说明，别让它瞎绕
          const gg = toolToGroup.get(exec?.name)
          if (gg && st?.cut?.groups.includes(gg)) {
            bumpHeal()
            return { kind: 'block', feedback: [{ type: 'text', text: `工具 "${exec.name}" 所在组 ${gg} 外联已临时切断（本会话读过网页，防提示注入）。确需使用请向用户确认，然后用 loadout {"action":"release"} 解除。` }] }
          }
          return passed
        }
        bumpHeal()
        dbg(`heal: ${exec.name} -> group ${toolToGroup.get(exec.name)}`)
        return { kind: 'block', feedback: [{ type: 'text', text: hint }] }
      } catch {
        return passed
      }
    })
  } catch (e) {
    log(`tools/post-execute listener failed: ${e?.message ?? e}`)
  }

  // 6. 注册表变动（热装插件、MCP 重连）时重归组，并对存活的 agent 重算 mask
  try {
    ctx.on('tools/change', () => {
      if (isApplying) return
      try {
        const changed = reGroup('tools/change')
        if (!changed) return
        for (const st of agents.values()) {
          // 新出现的组（trial、新 MCP server）对已有会话补默认隐藏，和新建会话口径一致
          for (const [n, row] of byName) {
            if (row.tools.length > 0 && !prevGroupKeys.has(n)) st.hidden.add(n)
          }
          applyMask(st, byName, log, 'reGroup')
        }
        log(`tools/change: regrouped, masks reapplied to ${agents.size} agent(s)`)
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
    name: 'loadout',
    description: '按需激活/隐藏工具组。action=list 看状态；action=activate group=<组名> 激活一组（当轮生效，' + idleCalls + ' 次调用未用后自动收回）；action=deactivate 重新隐藏；action=mode [mode=<名>] 模式切换（写代码/写材料/运维/只读审阅，省略 mode 列出全部）；action=release 用户确认后解除读外网切断；action=stats 看频率；action=review 看分档建议。gated 组（外发/执行类，默认 ssh/email/kimi-cu）和含 gated 组的模式 activate 需用户确认：说明用途后带 confirm:true 重试。遇到 "Unknown tool" 先激活对应组，不要拿同族工具替代。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'activate', 'deactivate', 'mode', 'release', 'stats', 'review'] },
        group: { type: 'string', description: '组名，用 action=list 查当前可用的组' },
        mode: { type: 'string', description: 'action=mode 时的模式名（coding/writing/ops/review 或配置自定义的）；省略则列出全部模式' },
        ttl_seconds: { type: 'number', description: 'activate 时可选：多少秒后自动收回' },
        max_calls: { type: 'number', description: 'activate 时可选：组内工具最多用多少次后自动收回' },
        confirm: { type: 'boolean', description: 'activate gated 组 / 应用含 gated 组的模式时必须 true——表示已得到用户确认' },
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
          const W = reviewWindow() // 近 N 天窗口，config.reviewWindowDays 可改
          const top = [...stats.keys()]
            .map((n) => [n, statWindow(n, W), statTotal(n)])
            .sort((a, b) => b[1] - a[1] || b[2] - a[2])
            .slice(0, 30)
          const st0 = agents.get(exec?.agent?.id)
          // 目录注入文本实测长度（chars/4 估 token），此前账外
          const catalogText = buildCatalog(byName, { idleCalls, unmatchedCount: unmatched.length })
          const catalogChars = catalogText.length
          const lines = [
            `visible schemas ≈ ${st0?.lastVisibleTokens ?? '?'} tokens（本轮视角，估算）`,
            `目录注入文本实测 ${catalogChars} 字符 ≈ ${Math.round(catalogChars / 4)} tokens（chars/4 估算）`,
            `自愈触发 ${metrics.heal} 次 | 搜索命中 ${metrics.searchHit} / 未命中 ${metrics.searchMiss}`,
            `代理调用 ${metrics.proxyCall} 次 | 代理拒绝 ${metrics.proxyRejected} 次`,
            '',
          ]
          if (top.length === 0) lines.push('no per-tool stats yet')
          else lines.push(`top tools by calls（近 ${W} 天，括号内为累计）:`, ...top.map(([n, w, t]) => `${w}\t${n}${t !== w ? ` (累计 ${t})` : ''}`))
          return lines.join('\n')
        }
        if (args.action === 'review') {
          // 按调用数据给分档建议：已归组里高频的值得常驻、未归组里高频的值得补规则。
          // 2026-10-27 改：不再用拍脑袋的 >=5 / >=3，统一按近 30 天窗口排，窗口内有调用就上榜，
          // 阈值让数据自己说话；月份尺度的分析可以直接拿 days 桶聚合。
          const W = reviewWindow()
          const grouped = []
          for (const [gName, row] of byName) for (const n of row.tools) grouped.push({ n, gName, w: statWindow(n, W), total: statTotal(n) })
          const hotGrouped = grouped.filter((x) => x.w > 0).sort((a, b) => b.w - a.w || b.total - a.total)
          const hotUnmatched = unmatched
            .map((n) => ({ n, w: statWindow(n, W), total: statTotal(n) }))
            .filter((x) => x.w > 0)
            .sort((a, b) => b.w - a.w || b.total - a.total)
          const lines = [
            `tracked ${stats.size} tools | ${grouped.length} grouped | ${unmatched.length} ungrouped (visible) | ${byName.size} groups`,
            `窗口 = 近 ${W} 天（按日聚合的原始数据在 loadout-stats.json 的 days 里，月度分析自己拿）`,
            '',
            `归组、近 ${W} 天有调用的（${hotGrouped.length}）—— 高频的考虑升为常驻：`,
            ...hotGrouped.slice(0, 15).map((x) => `  ${x.n} (${x.gName}, ${x.w}/30d${x.total !== x.w ? `, 累计 ${x.total}` : ''})`),
            '',
            `未归组、近 ${W} 天有调用的（${hotUnmatched.length}）—— 考虑补一条分组规则：`,
            ...hotUnmatched.slice(0, 15).map((x) => `  ${x.n} (${x.w}/30d${x.total !== x.w ? `, 累计 ${x.total}` : ''})`),
            '',
            '改规则：编辑 loadout-config.json 的 groups（或插件内置 BUILTIN_GROUPS），三条匹配方式 prefix / name / pattern。',
          ]
          return lines.join('\n')
        }
        const st = agents.get(exec?.agent?.id)
        if (!st) return 'no state for this agent (agent/created missed)'
        if (args.action === 'list') {
          const rows = []
          for (const [n, row] of byName) {
            if (row.tools.length === 0) continue
            const lease = st.leases?.[n]
            rows.push(`${st.hidden.has(n) ? '[hidden]' : '[active]'} ${n} (${row.tools.length})${lease ? ' lease' : ''}`)
          }
          const last = st.applyLog[st.applyLog.length - 1]
          const lastText = last ? (last.ok ? `ok deny=${last.denyCount}` : `FAIL ${last.error}`) : 'n/a'
          return [
            `agent ${exec?.agent?.id}: ${st.hidden.size} groups hidden, ${unmatched.length} tools visible without a group`,
            ...rows,
            `deny=${denyList(st, byName).length} | lastApply: ${lastText}`,
          ].join('\n')
        }
        if (args.action === 'mode') {
          const cfgM = loadConfig()
          const modes = effectiveModes(cfgM)
          if (!args.mode) {
            const cur = st.mode ?? '(未设置)'
            return [
              `模式（当前：${cur}）：`,
              ...Object.entries(modes).map(([k, m]) => `  ${k} — ${m.label}：激活 [${(m.activate ?? []).join(', ') || '无'}]，隐藏 [${(m.hide ?? []).join(', ') || '无'}]`),
              '用法：loadout {"action":"mode","mode":"<名字>"}。只执行列出的组开关，不动其他组；',
              '要激活 gated 组（外发/执行类）的模式需用户确认，带 "confirm":true 重试。',
            ].join('\n')
          }
          const m = modes[args.mode]
          if (!m) return `unknown mode: ${String(args.mode)}（可用：${Object.keys(modes).join(', ')}）`
          const toActivate = m.activate ?? []
          const toHide = m.hide ?? []
          const gatedHits = toActivate.filter((x) => effectiveGated(cfgM).has(x))
          if (gatedHits.length > 0 && args.confirm !== true) {
            return `模式 ${args.mode} 要激活外发/执行类组 [${gatedHits.join(', ')}]，需要你确认。向用户说明用途，得到同意后带 "confirm":true 重试。`
          }
          const acted = []
          for (const gName of toHide) {
            if (!byName.has(gName) || byName.get(gName).tools.length === 0) continue
            if (!st.hidden.has(gName)) { st.hidden.add(gName); delete st.lastUsed[gName]; acted.push(`hide ${gName}`) }
          }
          for (const gName of toActivate) {
            if (!byName.has(gName) || byName.get(gName).tools.length === 0) continue
            if (st.hidden.has(gName)) { st.hidden.delete(gName); st.lastUsed[gName] = st.tick; acted.push(`activate ${gName}`) }
          }
          st.mode = String(args.mode)
          applyMask(st, byName, log, `mode:${st.mode}`)
          return `mode ${st.mode} done | ${acted.join(', ') || '无变化'}`
        }
        if (args.action === 'release') {
          if (!st.cut) return 'no active cut（当前没有外联切断）'
          st.cut = null
          applyMask(st, byName, log, 'cut-release')
          log(`agent ${exec?.agent?.id}: outbound released (user confirmed)`)
          return 'outbound released（外联已恢复，本次为人工确认解除）'
        }
        const g = args.group
        if (!byName.has(g) || byName.get(g).tools.length === 0) {
          return `unknown or empty group: ${String(g)}（可用：${[...byName].filter(([, r]) => r.tools.length > 0).map(([n]) => n).join(', ')}）`
        }
        if (args.action === 'activate') {
          if (!st.hidden.has(g)) return `${g} already active`
          // 可见性当权限：gated 组（外发/执行类）激活必须用户确认。
          // 第一次调用不带 confirm → 不激活，返回"去问用户"的引导；用户点头后模型带 confirm:true 重试。
          if (effectiveGated(loadConfig()).has(g) && args.confirm !== true) {
            return `组 ${g} 是外发/执行类，激活需要你（用户）确认。先向用户说明要用这组做什么，得到同意后重试：loadout {"action":"activate","group":"${g}","confirm":true}。建议同时带 ttl_seconds 或 max_calls，授权按次不外延。`
          }
          st.hidden.delete(g)
          st.lastUsed[g] = st.tick
          // 带时限/限次的激活：到期或次数用尽自动收回
          if (args.ttl_seconds || args.max_calls) {
            st.leases = st.leases ?? {}
            st.leases[g] = {
              until: args.ttl_seconds ? Date.now() + Number(args.ttl_seconds) * 1000 : 0,
              maxCalls: args.max_calls ? Number(args.max_calls) : 0,
              used: 0,
            }
          }
        } else {
          if (st.hidden.has(g)) return `${g} already hidden`
          st.hidden.add(g)
          delete st.lastUsed[g]
          if (st.leases) delete st.leases[g]
        }
        applyMask(st, byName, log, `${args.action}:${g}`)
        const lease = st.leases?.[g]
        const extra = lease
          ? ` | lease: ${lease.until ? `until ${new Date(lease.until).toISOString()}` : ''}${lease.maxCalls ? ` max ${lease.maxCalls} calls` : ''}`
          : ''
        return `${args.action} ${g} done | hidden: ${[...st.hidden].join(', ') || '(none)'}${extra}`
      } catch (e) {
        return `loadout error (fail-open, nothing restricted): ${e?.message ?? e}`
      }
    },
  })

  // 8. 长尾档：搜索 + 代理调用（做法 B）。
  // tools_search 在隐藏工具的名字/描述/参数里按关键词匹配，返回完整 schema 文本。
  // 敏感工具与未分类工具照常可搜（让模型看见存在），但返回里写明该怎么调用。
  ctx.tools.register({
    name: 'tools_search',
    description: 'Search hidden tools by keyword and return their full JSON schemas. Use it when the tool you need is not in your tool list and loadout activate cannot help (long-tail tools). Matches tool names, descriptions, parameter names and parameter descriptions.',
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
          metrics.searchMiss++
          dbg(`search miss: "${q}"`)
          return `no tools matched "${q}". Try a broader keyword (e.g. "email", "ssh", "browser", "office"), or check the group catalog in the system prompt.`
        }
        metrics.searchHit++
        dbg(`search hit: "${q}" -> ${top.length}/${ranked.length}`)
        return [
          `matched ${top.length} of ${ranked.length} for "${q}"`,
          '',
          ...top.map((t) => {
            const g = toolToGroup.get(t.schema.name)
            const how = g
              ? `先 loadout {"action":"activate","group":"${g}"}，再直接调用；或 tools_call {"name":"${t.schema.name}","args":{...}}`
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
          'Use: tools_call {"name":"<name>","args":{...}} (extras group only; mid-frequency groups need loadout activate first)',
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
    description: 'Call a hidden tool by name through the plugin (proxy), returns the tool\'s rendered result. Use it after tools_search when the tool is not visible in your tool list and loadout activate cannot help (long-tail tools). args is the tool\'s own argument object.',
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
        if (effectiveSensitive(loadConfig()).has(name)) {
          metrics.proxyRejected++
          return `tools_call: 拒绝 "${name}" —— 这是外发/执行/破坏类工具，请先用 loadout 激活它的组，然后直接调用。`
        }
        // 代理只对"未归组长尾"有意义；已归组的必须先显式激活，
        // 否则租约、空闲收回这些约束会被代理通道绕过去。
        const gName = toolToGroup.get(name)
        if (gName) {
          const stNow = agents.get(exec?.agent?.id)
          if (stNow && stNow.cut && stNow.cut.groups.includes(gName)) {
            metrics.proxyRejected++
            return `tools_call: 外联已临时切断（本会话读过网页，防提示注入），${gName} 组当轮不可用。确需使用请让用户确认后用 loadout {"action":"release"} 解除。`
          }
          if (stNow && stNow.hidden.has(gName)) {
            metrics.proxyRejected++
            return `tools_call: "${name}" 属于组 ${gName}，该组当前隐藏。先 loadout {"action":"activate","group":"${gName}"} 再调用。`
          }
        }
        metrics.proxyCall++
        dbg(`proxy call: ${name}`)
        // 参数校验：只做"能靠 schema 判定"的那几条——必填缺失、多传了 schema 不认的字段。
        // 不做类型/格式校验，那和直接调用时宿主自己的行为对齐，别在这里造第二套规则。
        const def0 = ctx.tools.get(name)
        const schema0 = def0?.parameters
        if (schema0 && typeof schema0 === 'object') {
          const bad = checkArgs(schema0, args.args)
          if (bad) {
            metrics.proxyRejected++
            return `tools_call: 参数不对 —— ${bad}\n\n正确 schema:\n\`\`\`json\n${JSON.stringify(schema0, null, 1).slice(0, 2000)}\n\`\`\`\n按 schema 重填 args 再调一次。`
          }
        }
        // 不带 agent → 全局视图，不受调用方 agent 的 restrict 影响。
        const result = await ctx.tools.execute({
          callId: `proxy-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
          name,
          arguments: args.args ?? {},
          signal: exec.signal,
        })
        if (result.isError) return `tools_call error (${name}): ${result.error?.message ?? 'unknown'}`
        // 代理调用是嵌套 execute，不带 agent，tools/result 归属不到调用方，
        // 所以租约计数和活跃度在这里直接补记，并立刻检查租约是否用尽。
        try {
          const st2 = agents.get(exec?.agent?.id)
          const gName2 = toolToGroup.get(name)
          if (st2 && gName2 && !st2.hidden.has(gName2)) {
            st2.lastUsed[gName2] = st2.tick
            if (st2.leases?.[gName2]) st2.leases[gName2].used++
            enforceLeases(st2, byName, log, exec?.agent?.id)
          }
        } catch {}
        // 优先用工具自己的 render，得到与直调一致的文本；退化到 JSON
        try {
          const def = ctx.tools.get(name) // 全局视图，拿得到被 agent 隐藏的定义
          const blocks = def?.output?.render?.(args.args ?? {}, result.value)
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
  // 安全闸：webServer.register 的路由不经过宿主 /api 那层浏览器鉴权（实测全站 401 唯独这两个 200），
  // 所以自己守。三道——
  //   1) 自定义头 x-dsh-loadout: 1：跨站页面和远程探测发不出这个头，挡 CSRF（notify-me 同款思路）；
  //   2) Host 必须是本机回环：挡 remote-web-ui 隧道/配对设备把请求中转进来的路径；
  //   3) Origin 与 Host 不一致直接拒：双保险。
  const gatePanel = (req, res, { write }) => {
    const deny = (code, why) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: `dsh-loadout: ${why}` }))
      return false
    }
    if (req.headers?.['x-dsh-loadout'] !== '1') return deny(401, 'missing panel header')
    const host = String(req.headers.host ?? '')
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host)) return deny(403, `refused host ${host}`)
    const origin = req.headers.origin
    if (origin) {
      try {
        if (new URL(origin).host !== host) return deny(403, 'origin mismatch')
      } catch { return deny(403, 'bad origin') }
    }
    if (write && req.method !== 'POST') { res.writeHead(405); res.end(); return false }
    return true
  }
  try {
    ctx.inject(['webServer'], (sctx) => {
      sctx.effect(() => {
        const routes = [
          {
            kind: 'exact',
            path: '/api/dsh-loadout/state',
            handler: async (req, res) => {
              if (!gatePanel(req, res, { write: false })) return
              const cfg = loadConfig()
              const cfgHidden = Array.isArray(cfg.hiddenGroups) ? new Set(cfg.hiddenGroups) : null
              // 有会话态就报会话态（真实开关），没有就报配置默认值，两者分开标注
              const live = [...agents.entries()].map(([id, st]) => ({
                id,
                hidden: [...st.hidden],
                active: [...byName.keys()].filter((n) => !st.hidden.has(n) && byName.get(n).tools.length > 0),
                leases: st.leases ?? {},
                deny: denyList(st, byName).length,
                child: Boolean(st.child),
                visibleTokens: st.lastVisibleTokens ?? 0,
                cut: st.cut ? { remaining: Math.max(0, st.cut.untilTick - st.tick), groups: st.cut.groups } : null,
                mode: st.mode ?? null,
              }))
              const groups = [...byName.entries()].map(([name, row]) => ({
                name, desc: row.desc, count: row.tools.length,
                tools: row.tools, // 全量，不再截 40
                calls: row.tools.reduce((s, t) => s + statTotal(t), 0),
                defaultHidden: cfgHidden ? cfgHidden.has(name) : true,
              }))
              const body = JSON.stringify({
                groups,
                unmatched, // 未归组、始终可见的工具
                neverHide: [...effectiveNeverHide(cfg)],
                neverHideReplace: Array.isArray(cfg.neverHideReplace) ? cfg.neverHideReplace : null,
                sensitive: Array.isArray(cfg.sensitive) ? cfg.sensitive : null,
                sensitiveExtra: Array.isArray(cfg.sensitiveExtra) ? cfg.sensitiveExtra : null,
                hideInSubagents: cfg.hideInSubagents === true,
                healText: typeof cfg.healText === 'string' ? cfg.healText : null,
                catalogNote: typeof cfg.catalogNote === 'string' ? cfg.catalogNote : null,
                reviewWindowDays: Number(cfg.reviewWindowDays) > 0 ? Number(cfg.reviewWindowDays) : 30,
                catalogMode: cfg.catalogMode === 'compact' ? 'compact' : 'full',
                trial: {
                  enabled: cfg.trial !== false,
                  promoteAfter: Number(cfg.trialPromoteAfter) > 0 ? Number(cfg.trialPromoteAfter) : 3,
                  promoted: [...promoted].sort(),
                  pending: [...(byName.get('trial')?.tools ?? [])],
                },
                gatedGroups: [...effectiveGated(cfg)],
                gatedGroupsRaw: Array.isArray(cfg.gatedGroups) ? cfg.gatedGroups : null,
                cut: cfg.cut === true,
                cutLasts: Number(cfg.cutLasts) > 0 ? Number(cfg.cutLasts) : 30,
                cutGroupsRaw: Array.isArray(cfg.cutGroups) ? cfg.cutGroups : null,
                cutTriggersRaw: Array.isArray(cfg.cutTriggers) ? cfg.cutTriggers : null,
                cutTriggerToolsRaw: Array.isArray(cfg.cutTriggerTools) ? cfg.cutTriggerTools : null,
                modesRaw: (cfg.modes && typeof cfg.modes === 'object') ? cfg.modes : null,
                modesEffective: effectiveModes(cfg),
                mcpGroups: cfg.mcpGroups !== false,
                rules: Array.isArray(cfg.groups) && cfg.groups.length > 0 ? cfg.groups : BUILTIN_GROUPS,
                rulesSource: Array.isArray(cfg.groups) && cfg.groups.length > 0 ? 'config' : 'builtin',
                idleCalls: Number(cfg.idleCalls) || IDLE_CALLS,
                stats: Object.fromEntries(stats),
                agents: live, // 每个活跃 agent 的真实状态
              })
              res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
              res.end(body)
            },
          },
          {
            kind: 'exact',
            path: '/api/dsh-loadout/mint-url',
            handler: async (req, res) => {
              // 评测执行器要 launch token：复用宿主 client-connection 服务铸一个带 token 的 URL。
              // 与 /config 同级的三道闸（loopback + 自定义头 + Origin 对齐），且写操作级。
              // 铸出来的是完整 owner 凭据，谁拿到谁就是机主——所以这笔每次调用都记日志。
              if (!gatePanel(req, res, { write: true })) return
              try {
                const svc = ctx.get('connection')
                const host = req.headers.host ?? '127.0.0.1'
                const base = `http://${host}/`
                // web-app 的用法是 inject(['connection']) 后取 .connection.authenticatedUrl；
                // 服务本身或 .connection 属性两种形态都试一下
                const conn = svc?.authenticatedUrl ? svc : svc?.connection
                const url = conn?.authenticatedUrl ? conn.authenticatedUrl(base) : null
                if (!url) { res.writeHead(503); res.end(JSON.stringify({ ok: false, error: 'client-connection unavailable' })); return }
                log(`mint-url: 评测执行器取了带 token 的 URL（loopback 闸内）`)
                res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
                res.end(JSON.stringify({ ok: true, url: String(url) }))
              } catch (e) {
                res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
                res.end(JSON.stringify({ ok: false, error: String(e?.message ?? e) }))
              }
            },
          },
          {
            kind: 'exact',
            path: '/api/dsh-loadout/config',
            handler: async (req, res) => {
              if (!gatePanel(req, res, { write: true })) return
              if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
              const chunks = []
              for await (const c of req) chunks.push(c)
              try {
                const next = JSON.parse(Buffer.concat(chunks).toString('utf8'))
                const merged = { ...loadConfig(), ...(next && typeof next === 'object' ? next : {}) }
                if (Array.isArray(merged.hiddenGroups)) {
                  merged.hiddenGroups = merged.hiddenGroups.filter((g) => byName.has(g))
                }
                if (Array.isArray(merged.groups)) {
                  // 规则校验：name 必填、至少一条匹配方式；非法规则直接拒绝，不留半条
                  const bad = []
                  merged.groups = merged.groups.filter((g) => {
                    if (!g || typeof g.name !== 'string' || !g.name.trim()) { bad.push('missing name'); return false }
                    const ok = Array.isArray(g.prefixes) || Array.isArray(g.names) || Array.isArray(g.patterns)
                    if (!ok) { bad.push(`${g.name}: no prefixes/names/patterns`); return false }
                    return true
                  })
                  if (bad.length > 0) {
                    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
                    res.end(JSON.stringify({ ok: false, error: `规则不合法：${bad.join('; ')}`, config: loadConfig() }))
                    return
                  }
                  merged.groups = merged.groups.map((g) => ({
                    name: g.name.trim(),
                    desc: String(g.desc ?? ''),
                    ...(Array.isArray(g.prefixes) ? { prefixes: g.prefixes.map(String) } : {}),
                    ...(Array.isArray(g.names) ? { names: g.names.map(String) } : {}),
                    ...(Array.isArray(g.patterns) ? { patterns: g.patterns.map(String) } : {}),
                  }))
                }
                if (Array.isArray(merged.neverHide)) merged.neverHide = merged.neverHide.map(String)
                if (Array.isArray(merged.neverHideReplace)) merged.neverHideReplace = merged.neverHideReplace.map(String)
                if (merged.neverHideReplace !== null && !Array.isArray(merged.neverHideReplace)) merged.neverHideReplace = null
                if (Array.isArray(merged.sensitive)) merged.sensitive = merged.sensitive.map(String)
                if (merged.sensitive !== null && !Array.isArray(merged.sensitive)) merged.sensitive = null
                if (Array.isArray(merged.sensitiveExtra)) merged.sensitiveExtra = merged.sensitiveExtra.map(String)
                merged.hideInSubagents = merged.hideInSubagents === true
                if (typeof merged.healText !== 'string' || !merged.healText.trim()) merged.healText = null
                if (typeof merged.catalogNote !== 'string' || !merged.catalogNote.trim()) merged.catalogNote = null
                if (!(Number(merged.reviewWindowDays) > 0)) merged.reviewWindowDays = 30
                merged.catalogMode = merged.catalogMode === 'compact' ? 'compact' : 'full'
                merged.trial = merged.trial !== false
                if (!(Number(merged.trialPromoteAfter) > 0)) merged.trialPromoteAfter = 3
                if (merged.gatedGroups !== null && !Array.isArray(merged.gatedGroups)) merged.gatedGroups = null
                if (Array.isArray(merged.gatedGroups)) merged.gatedGroups = merged.gatedGroups.map(String)
                merged.cut = merged.cut !== false
                if (!(Number(merged.cutLasts) > 0)) merged.cutLasts = 30
                for (const k of ['cutGroups', 'cutTriggers', 'cutTriggerTools']) {
                  if (merged[k] !== null && !Array.isArray(merged[k])) merged[k] = null
                  if (Array.isArray(merged[k])) merged[k] = merged[k].map(String)
                }
                if (merged.modes !== null && (typeof merged.modes !== 'object' || Array.isArray(merged.modes))) merged.modes = null
                if (merged.mcpGroups !== false) merged.mcpGroups = null
                if (!(Number(merged.idleCalls) > 0)) merged.idleCalls = IDLE_CALLS
                await writeFileAsync(CONFIG_PATH, JSON.stringify(merged, null, 1), 'utf8')
                // 配置改完立刻重归组并对存活 agent 重算（不必等重启）
                const changed = reGroup('config-save')
                if (changed) for (const st of agents.values()) applyMask(st, byName, log, 'config-save')
                dbg(`config saved: hidden=${(merged.hiddenGroups ?? []).join(',') || 'all'} idle=${merged.idleCalls} rules=${merged.groups?.length ?? 'builtin'} regrouped=${changed}`)
                res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
                res.end(JSON.stringify({ ok: true, config: merged, regrouped: changed }))
              } catch (e) {
                res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
                res.end(JSON.stringify({ ok: false, error: String(e?.message ?? e) }))
              }
            },
          },
          {
            kind: 'exact',
            path: '/api/dsh-loadout/session',
            handler: async (req, res) => {
              // 用户本人在面板上直接开关"当前会话"里的组——这是设计清单第三章第 4 条
              // "用户也能在面板上手动激活和收回"的落地。同一套三道闸；每次操作都记日志
              //（外发组的开关属于安全相关动作，日志里要有谁什么时候动了哪组）。
              if (!gatePanel(req, res, { write: true })) return
              try {
                const chunks = []
                for await (const c of req) chunks.push(c)
                const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
                const agentId = String(body?.agentId ?? '')
                const group = String(body?.group ?? '')
                const action = String(body?.action ?? '')
                const st = agents.get(agentId)
                if (!st) {
                  res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
                  res.end(JSON.stringify({ ok: false, error: `no such agent: ${agentId}` }))
                  return
                }
                if (action === 'release-cut') {
                  st.cut = null
                  applyMask(st, byName, log, 'panel-release-cut')
                  log(`panel: agent ${agentId} outbound released by user click`)
                } else {
                  if (action !== 'activate' && action !== 'deactivate') {
                    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
                    res.end(JSON.stringify({ ok: false, error: 'action 必须是 activate / deactivate / release-cut' }))
                    return
                  }
                  if (!byName.has(group) || byName.get(group).tools.length === 0) {
                    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
                    res.end(JSON.stringify({ ok: false, error: `unknown or empty group: ${group}` }))
                    return
                  }
                  if (action === 'activate') {
                    st.hidden.delete(group)
                    st.lastUsed[group] = st.tick
                  } else {
                    st.hidden.add(group)
                    delete st.lastUsed[group]
                    if (st.leases) delete st.leases[group]
                  }
                  applyMask(st, byName, log, `panel:${action}:${group}`)
                  log(`panel: agent ${agentId} ${action} ${group} by user click (hidden=${st.hidden.size})`)
                }
                res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
                res.end(JSON.stringify({
                  ok: true,
                  hidden: [...st.hidden],
                  cut: st.cut ? { remaining: Math.max(0, st.cut.untilTick - st.tick), groups: st.cut.groups } : null,
                }))
              } catch (e) {
                res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
                res.end(JSON.stringify({ ok: false, error: String(e?.message ?? e) }))
              }
            },
          },
        ]
        const disposers = routes.map((route) => sctx.webServer.register(route))
        return () => { for (const d of disposers) { try { d() } catch {} } }
      }, 'loadout: panel bridge')
    })
  } catch (e) {
    log(`panel bridge failed: ${e?.message ?? e}`)
  }

  log('loadout + tools_search + tools_call registered')
}
