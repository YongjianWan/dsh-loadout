# dsh-loadout 产品说明（PRD）

> 本文描述**产品当前应有的行为**，是改代码时的判据。历史决策、实验过程、踩坑记录见
> [DECISIONS.md](DECISIONS.md)，未修的技术债见 [TECH_DEBT.md](TECH_DEBT.md)。
> 本文随行为变化更新；**不要把"哪天改了什么"写进来**，git log 有。

## 一、要解决的问题

DSH 装到一定规模后，单次会话有两百来个工具，每个工具的完整 JSON schema 每轮都进上下文。
实测一个重度配置的会话里，工具 schema 单独就占 73.3K token（2026-10-27 历史数，含更早的配置），
是所有文本内容加起来的一半以上。后果两条：token 白烧，模型也更容易选错工具。

一句话定位：**按需装配工具**。常驻留一个小核心，其余按组默认隐藏、需要时一句话放出来，
长尾工具不进列表、搜索后代理调用。

## 二、宿主能力与硬约束

DSH 侧确认可用、本文件依赖的机制：

| 能力 | 用途 |
|---|---|
| `ctx.tools.restrict({deny})` | 按 agent 隐藏工具：schema、查找、执行三方面同时隐藏；dispose 即恢复；下一次请求生效 |
| `ctx.tools.register()` | 注册插件自己的工具 |
| `agent/created` 事件 | 新会话设置默认隐藏 |
| `systemPrompt.section()` | 注入工具目录 |
| `ctx.tools.execute()` 不传 agent | 走全局视图，调用被 restrict 隐藏的工具（代理与门面都靠它） |
| `turn/end` 事件 | 会话级事件，用于切断外联的精确恢复（**未实测**，见 TECH_DEBT） |

两条硬约束，改代码时必须守住：

- **restrict 只能管全局注册表里的工具。** agent 自己作用域注册的工具够不到，永远可见。
  两个实例：团队协作那批（`send_message`/`spawn_teammate`/`team_task_*`），
  以及本机实测的 `present`/`exit_plan_mode`/`workflow`/`ops_discover_tools`/`send_wechat`
  ——它们出现在 `BUILTIN_GROUPS` 的 ops 组声明里，但不在 `ctx.tools.schemas()` 里，
  规则命中不了，也不该指望靠归组管住它们。靠可见性管这些工具的权限这条路不成立。
- **restrict 会同步派发 `tools/change`。** 监听该事件时若在回调里再 restrict，会同步无限递归卡死 Host。
  实现里用模块级 `isApplying` 锁挡住。
- **子代理作用域里 `loadout`/`tools_search`/`tools_call` 是可用的**（2026-10-27 探针实测）。
  这点与早期认知相反，`hideInSubagents` 的可行性前提因此成立，但默认仍关闭（见 3.11）。

## 三、行为规范

### 3.1 工具分档

| 档位 | 典型工具 | 行为 |
|---|---|---|
| 常驻 | 文件读写、bash、搜索、`loadout`/`tools_search`/`tools_call`/`browser` | 一直在工具列表里 |
| 按需组 | chrome-devtools、univer、email、ssh 等 | 默认隐藏，`loadout activate` 放出整组 |
| 观察区（trial） | 启动后才出现的未认领工具 | 隐藏，调用满 N 次自动转正 |
| 长尾 | 没被任何规则认领的工具 | 保持可见；`tools_search` 找、`tools_call` 代理调 |

**边界原则：只藏"有人认领"的工具。** 没被规则命中的一律可见（fail-open）。这条不能反——
反了就会自锁（规则库永远追不上注册表，漏掉的那个被藏了就没人能调 `loadout` 解开）。

唯一例外是观察区：启动快照（含 35 秒宽限窗）之后新出现的未认领工具进隐藏的 `trial` 组。
控制面（`loadout`/`tools_search`/`tools_call`/`browser`）与 ACP 协议工具走 NEVER_HIDE 先行排除，
永远进不了观察区。

### 3.2 元工具

| 工具 | 职责 |
|---|---|
| `loadout` | `action: list / activate / deactivate / mode / release / stats / review` |
| `tools_search` | 按关键词搜工具，返回完整 schema，默认 5 个。支持中文（内置中英同义词桥接） |
| `tools_call` | 按名字代理调用工具，参数放 `args` |
| `browser` | 浏览器门面，12 个动作 |

`activate` 支持 `ttl_seconds` 与 `max_calls`：到期或次数用尽自动收回。
`gatedGroups` 里的组（默认 ssh/email/kimi-cu）激活必须带 `confirm:true`——模型须先向用户说明用途。

### 3.3 分组规则

规则是数据不是代码：内置 `BUILTIN_GROUPS`，配置文件 `groups` 优先，面板可改。
三种匹配方式按顺序：全名 → 前缀 → 正则。组表保持扁平，不做嵌套和依赖。
MCP 工具按 `mcp__<server>__` 前缀自动成组，新接 server 不用改规则。

本机现状（2026-10-27 实测，会随插件安装变化）：17 组，含 chrome-devtools 32、kimi-cu 13、
univer 14、mnemon 17、mcp-connector 25、tieba 35、bili 20、search-ext 13、email 11、
sandbox 10、ssh 6、ops 6、acp 3、mcp-resource 3、context7 2。

### 3.4 目录注入

用 `systemPrompt.section()` 注入，`catalogMode: full | compact` 可选（full 默认）。

full 模式按组列出**全量工具名**（名字可见、schema 仍藏），首行必须写明约束：
这些工具不在工具列表里，直接调报 Unknown tool；连续用同组走 activate 整组，只偶尔用走
`tools_search` + `tools_call`。约束必须写在脸上——模型看到清单的默认反应就是直接调。

体积对照（本机 252 个工具、17 组实测）：full 6122 字符 ≈ 1531 token，
compact 2482 字符 ≈ 621 token，差额约 910 token/轮。compact 只是 A/B 对照档，不是省 token 的默认值。

### 3.5 激活、收回、租约

- 激活：重算 deny，dispose 旧 restrict，apply 新的，同一轮内生效。
- 空闲收回：一组连续 N 次工具调用没碰到组内工具就收回，N 默认 30。
- 租约：`ttl_seconds`/`max_calls` 到期自动收回。
- 只在这些时机重算（全量重算会撞提示词缓存），不每轮算。

### 3.6 观察区（trial）

启动快照无条件进 baseline；另有 35 秒宽限窗吸收启动时序竞争。窗口结束后新出现的未认领工具
进隐藏的 `trial` 组，调用满 `trialPromoteAfter`（默认 3）次自动转正回可见。
转正名单持久化在 `~/.dsh/loadout-trial.json`，跨重启不丢。`trial: false` 可关。

`tools/change` 后新出现的组对已有会话补默认隐藏（否则对已开着的会话等于默认放行）。

### 3.7 模式切换

`loadout {"action":"mode","mode":"<名>"}`。内置四档：

| 模式 | 激活 | 隐藏 |
|---|---|---|
| coding 写代码 | ssh, context7, chrome-devtools | — |
| writing 写材料 | univer, search-ext | — |
| ops 运维 | ops, ssh, sandbox, mcp-connector | — |
| review 只读审阅 | — | ssh, email, kimi-cu, bili, tieba, ops, mcp-connector, sandbox, univer, schedule |

语义是一次性开关操作：只动清单里的组，不动清单外的当前状态。**模式不是锁**——
review 只隐藏当时可见的外发组，之后 activate 仍可开。防注入靠切断外联那条。
`config.modes` 同名覆盖、新名新增。

### 3.8 读外网切断外联（默认关）

`cut: true` 时生效。触发面：`cutTriggers` 组（默认 chrome-devtools/search-ext）加
`cutTriggerTools` 裸工具名（默认 web_fetch/web_search）。命中后把 `cutGroups`
（默认 email/ssh/kimi-cu/bili/tieba/ops/mcp-connector/sandbox）强制并入 deny——
**不动 st.hidden**，切的是可见性不是组开关，恢复后用户状态原样。

恢复两条路：宿主 `turn/end` 事件（当轮精确）、`cutLasts` 次调用后兜底（默认 30）。
人工解除走 `release`，每次记日志。切断期间 `tools_call` 代理拒绝，UNKNOWN_TOOL 自愈改写成切断说明。

### 3.9 门面

`browser` 常驻，把 chrome-devtools 的 32 个工具压成 12 个动作
（navigate/click/type/press/screenshot/snapshot/eval/tabs/switch/close/wait/scroll）。
内部翻译成真工具名走 `ctx.tools.execute` 全局视图。组激活后门面仍可用，附提示有完整入口。
门面在 NEVER_HIDE 里。

### 3.10 故障策略

全程 fail-open：任何异常路径先解除全部隐藏，宁可全量可见，不停在半隐藏状态。
`applyMask` 里 restrict 抛错只记日志不重试。

**deny 名单去重**：`applyMask` 先算 deny 清单（纯函数），若与上一次真正生效的清单完全相同
（`st.maskApplied === true && st.lastDenyKey === key`），直接返回并累加 `st.skips`——
不 dispose、不 restrict、不重算 token 估算、不写日志行。首次（`maskApplied` 为 false）必须真跑。
理由：启动与热装会对每个 agent 各跑一遍，本机实测 852 行 applyMask 里绝大多数是 deny 没变的重复。

**死 agent 清理**：`tools/change` 重分组前调 `pruneAgents()`，拿宿主 `agents.list()` 的真实 id 集合，
把插件表里不在其中的条目连 disposer 一起删。判活**只认宿主注册表**：
`agents` 服务不可用、`list()` 抛错、`list()` 返回空数组（视为未就绪）三种情况一律不删——
删错一个活 agent，它身上的 restrict 就没人撤。启动阶段的 `retry@30000` 之后也清一次。

**日志**：`loadout-debug.log` 单文件上限 1 MB，写入前检查，超过则轮转成 `.1`（只留一份备份）。

### 3.11 子代理

子代理默认不隐藏。判断方式：`ctx.agents.list()` 有、`roots()` 没有 → 子代理；
判不出来按顶层处理（藏）。`hideInSubagents: true` 可强制开。

**技术前提已更正**：2026-10-27 用探针子代理实测，子代理作用域里 `loadout` / `tools_search` /
`tools_call` **都能看到、也能调用**（子代理里 `loadout list` 正常返回全部组状态）。
因此"藏了没人能解套"不成立，默认关闭是产品选择——子代理被藏后每次都得先激活再干活，
路径变长且它拿不到任务上下文所以激活什么只能猜。要开就显式设 `hideInSubagents: true`。

### 3.12 面板

插件详情页四个页签：分组、规则、会话、调用频率。

- 规则页含高级区：豁免名单、代理黑名单、自愈文案、目录附言、观察区、gated 组、切断外联、模式表、MCP 开关、排行窗口、子代理、目录版本
- 会话页：每个 agent 的真实开关，点组名可直接激活/收回（用户本人操作，不过 gated 闸，记日志），
  显示当前模式与切断状态，可解除切断
- 面板三个 HTTP 端点（state/config/session）自带三道闸：自定义头 `x-dsh-loadout: 1`、
  Host 必须本机回环、Origin 与 Host 一致

## 四、当前能力边界（做不到的）

- 长尾档在顶层会话实际是空集：被藏工具都有规则认领→都已归组→`tools_call` 对已归组工具恒拒绝。
  三档实际落地两档。`tools_search` 仍是有用的兜底入口。
- 质量收益无自有评测证据（"工具超过 30-50 个准确率下降"是厂商文档论断）。
- 安全模型建立在"模型会读系统提示"上：目录、自愈、门面提示全靠模型照做，插件层只能变窄不能堵死。

## 五、暂不做

| 条目 | 理由 |
|---|---|
| 按用户消息关键词/embedding 自动预测激活 | 预测错了没人察觉；激活决定权留给模型和用户 |
| 高频细粒度切换 | 每次切换可能多一次缓存未命中，省下的 schema token 被吃回 |
| 组嵌套、组依赖图、自动改分组 | 复杂度上涨快，排查难；改动走人工确认 |
| skill 驱动激活 | skill 读进来才知道要激活什么，那时已经晚了；且那句话会污染所有 skill 正文 |
| 评测时换模拟工具 | 2026-10-27 撤销：用指令约束即可，不为过度验证牺牲快准 |
| 结果侧按需披露 | dsh-context 已有 prune 能力，功能面重叠（见 TECH_DEBT 记录） |
| office（univer）门面 | 参数是表格区域/公式/样式矩阵，压成几个动作必然失真 |
