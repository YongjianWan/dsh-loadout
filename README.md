# dsh-loadout

按需加载工具组的 DSH 插件。**常驻只留十来个，其余按组默认隐藏，需要时一句话激活。**

> 2026-10-28：控制面主工具 `toolctl` 改名为 `loadout`，配置文件、统计文件同步改为 `loadout-*.json`（旧文件首次启动自动迁移，不丢配置和历史统计）。

> 产品行为规范：[docs/PRD.md](docs/PRD.md)。内部决策记录与技术债清单不入库（只留本地）。本文只讲怎么用。

## 解决什么问题

DSH 装到一定规模后，单次会话有 200 个左右的工具，每个工具的完整 JSON schema 每轮都进上下文。实测一个重度配置的会话里，工具 schema 单独就占 73.3K token，是所有文本内容加起来的一半以上。后果有两个：token 白烧，选工具也容易选错。

插件分三档：

- **常驻**：文件读写、bash、搜索、skill、记忆读取这些几乎每轮都用的
- **按需组**：浏览器、办公、邮件、SSH、B 站、团队协作等，默认隐藏，`loadout activate` 一句话放出来
- **观察区（trial）**：启动后才新出现的未认领工具，默认隐藏，调用满 3 次自动转正回可见
- **长尾**：没被任何规则认领的工具，**保持可见**，用 `tools_search` 找、`tools_call` 代理调用

还有两把横切开关：

- **模式切换**：`loadout {"action":"mode","mode":"coding"}` 一个开关切整套组。内置写代码 / 写材料 / 运维 / 只读审阅四档，`config.modes` 可改可增
- **读外网切断外联**：浏览器或网页读取一调用，当轮自动藏掉发邮件、ssh、发消息等外发组——防提示注入最实在的一刀，下一轮自动恢复，紧急可用 `loadout {"action":"release"}` 人工解除。**默认关闭**，需要时 `cut: true` 或面板打开

## 边界原则（重要）

**只藏"有人认领"的工具。** 隐藏必须由显式规则声明，没被规则命中的一律可见。

这条不是风格问题，是踩过坑：早先的实现有个"extras 兜底组"，把没匹配上的工具统统一藏了之。结果插件自己的控制面（`loadout` / `tools_search` / `tools_call`）注册时也没匹配上任何规则，被自己藏进了 extras——**221 个工具全藏死，而能解除隐藏的三个按钮自己也被藏了，没有任何解套路径。**

打补丁（给这三个名字开豁免）只是让这个坑晚点再出现：下一个新插件、下一个迟到的 MCP 工具都会掉进同一个兜底组。所以方向反了——从"未知即隐藏"改成"未知即可见"，隐藏由规则认领。

同理，`NEVER_HIDE` 那几条（控制面 + ACP 压缩协议）是第二道锁，不是唯一防线。

## 三个工具

| 工具 | 作用 |
|---|---|
| `loadout` | `list` 看状态、`activate`/`deactivate` 开关组、`mode`/`release` 模式与切断、`stats` 看调用频率、`review` 看分档建议 |
| `tools_search` | 按关键词搜工具，返回完整 schema。支持中文（内置中英同义词桥接） |
| `tools_call` | 按名字代理调用工具。外发、远程执行、删除类一律拒绝 |
| `browser` | 浏览器门面：navigate/click/type/press/screenshot/snapshot/eval/tabs/switch/close/wait/scroll 十二个动作，chrome-devtools 组没激活时的兜底入口 |

## 安装

```bash
dsh plugin add dsh-loadout
```

或在插件管理器里装。

## 配置

配置文件 `~/.dsh/loadout-config.json`，**面板改的就是它**，保存后立即重新分组，不必重启：

```json
{
  "groups": [
    { "name": "email", "desc": "邮件：列信、读信、发送…", "prefixes": ["email_"] },
    { "name": "ops",   "desc": "宿主运维", "names": ["present", "workflow"] },
    { "name": "goal",  "desc": "长目标", "patterns": ["^(create|update|get)_goal$"] }
  ],
  "neverHide": ["loadout", "tools_search", "tools_call"],
  "hiddenGroups": null,
  "idleCalls": 30
}
```

| 字段 | 含义 |
|---|---|
| `groups` | 分组规则，纯数据。`prefixes` 前缀、`names` 精确全名、`patterns` 正则，三种按顺序匹配。`null` 表示用插件内置规则 |
| `neverHide` | 永不隐藏的工具名（在内置 `NEVER_HIDE` 之上追加） |
| `hiddenGroups` | 新会话默认隐藏哪些组。`null` = 全部隐藏；写成数组后**不在数组里的组默认可见** |
| `idleCalls` | 一组激活后连续多少次工具调用没碰到组内工具就收回 |
| `trial` | 新插件观察区开关。`false` 关掉，迟到工具退回直接可见（默认 `true`） |
| `trialPromoteAfter` | 观察区工具调用多少次自动转正回可见（默认 3，转正名单持久化在 `~/.dsh/loadout-trial.json`） |
| `gatedGroups` | 可见性当权限：这些组 `activate` 要用户确认（模型需带 `confirm:true` 重试）。`null` = 内置默认 `ssh/email/kimi-cu`；`[]` = 不闸任何组 |
| `cut` | 读外网切断外联总开关（**默认 `false`**，按需开） |
| `cutLasts` | 切断持续多少个工具调用，兜底自动恢复（默认 30；宿主发 `turn/end` 会当轮提前恢复） |
| `cutGroups` | 切断时隐藏哪些组。`null` = 内置默认 `email/ssh/kimi-cu/bili/tieba/ops/mcp-connector/sandbox`；`[]` = 不切 |
| `cutTriggers` | 哪些组的工具算"读了外网"。`null` = 内置默认 `chrome-devtools/search-ext` |
| `cutTriggerTools` | 哪些裸工具名算"读了外网"。`null` = 内置默认 `web_fetch/web_search` |
| `modes` | 模式切换表：`{ 名字: { label, activate: [], hide: [] } }`，同名覆盖内置、新名新增；`null` = 只用内置四档 |

MCP 工具（`mcp__<server>__<tool>`）始终按 server 名自动成组，不需要写规则；`mcpGroups: false` 可关掉这条。

## 面板

插件管理器 → 本插件详情页 → 配置。

四个页签：

- **分组**：每组一行，点开看全部工具名（不截断）。「默认隐藏/默认放行」是新建会话的初始状态
- **规则**：可视化编辑分组规则，前缀/全名/正则三栏，保存即生效。规则非法（没名字、没有任何匹配方式）会被服务端拒绝，不会写坏配置。高级区含：基础豁免、代理黑名单、自愈文案、目录附言、观察区（开关+转正次数+转正/待观察数量）、gated 组（含"置空=不闸任何组"）、切断外联（开关+持续次数+三个清单）、模式表（JSON 编辑 + 当前生效预览）、MCP 自动分组开关、排行窗口、子代理、目录版本
- **会话**：每个活跃 agent 的真实开关——哪些组被它隐藏着、当前模式、租约还剩多久、外联是否被切断（带"解除切断"按钮）、deny 了多少个工具。**点组名即可手动激活/收回**（用户本人操作，不走确认闸，服务端记日志）。下面列出**未归组、始终可见**的工具，提醒补规则
- **调用频率**：Top 20，用来判断哪些该升级成常驻

## 工作机制

- 启动时从 `ctx.tools.schemas()` 枚举全局注册表，按规则归组；没认领的记进 `unmatched`
- 新 agent 创建时（`agent/created`）用 `ctx.tools.restrict({ deny })` 隐藏整个组。`restrict` 是呈现、查找、执行三方面同时隐藏，dispose 即恢复，下一次请求生效
- 注册表变动（热装插件、MCP 重连）时监听 `tools/change` 重新归组
- 空闲收回：一组激活后连续 N 次工具调用没碰到组内工具，自动收回
- **全程 fail-open**：任何异常路径都先解除全部隐藏，宁可全量可见，不停在半隐藏状态
- **观察区**：启动快照（含 35 秒宽限窗）之后才出现的未认领工具进隐藏的 trial 组——"未知即可见"只适用于启动时就存在的工具，迟到的按"新插件"对待；调用满 `trialPromoteAfter` 次自动转正，转正名单持久化。控制面三件套和协议工具永远不进观察区
- **可见性当权限**：`gatedGroups` 里的组（默认 ssh/email/kimi-cu）激活时要用户确认——模型第一次 `activate` 会拿到"去问用户"的引导，用户点头后带 `confirm:true` 重试才放行；含 gated 组的模式同理。面板直接改配置，是用户本人操作，不受此闸
- **模式切换**：`mode` 动作执行模式的 activate/hide 清单，是一次性开关操作，不动清单之外的组（上次模式开的组不会自动关）。只读审阅的隐藏清单是人工策展，新装高危插件组记得补进 review 模式
- **读外网切断外联**：`web_fetch`/`web_search` 或浏览器、检索组的工具一返回，当轮把 `cutGroups` 里的组强制 deny（哪怕已激活）——切的是可见性不是组开关，恢复后用户状态原样。恢复有两条路：宿主发 `turn/end`（精确当轮）或 `cutLasts` 次调用后自动兜底；确需外发时模型向用户确认后用 `release` 解除，每次解除记日志。cut 期间走 `tools_call` 代理会被拒，UNKNOWN_TOOL 自愈会说明原因
- **门面工具**：`browser` 常驻，把 chrome-devtools 的三十二个工具压成十二个动作（navigate/click/type/press/screenshot/snapshot/eval/tabs/switch/close/wait/scroll）。组没激活时用它兜底，组激活后仍可用（会附一句"有完整工具"的提示）。门面走 `ctx.tools.execute` 全局视图代理，和 tools_call 同一条路。门面在豁免名单里，永远不会被藏
- 组表的 token 预算：目录只列**有工具的组**，空组不进系统提示

## 已知限制

- `restrict` 只作用于 agent 作用域里能看到的全局工具。**agent 自己作用域注册的工具够不到**（团队工具 `send_message` / `spawn_teammate` 等），所以它们保持可见——靠可见性控制权限这条路对它们不成立
- `restrict` 会同步派发 `tools/change`，监听该事件时必须在回调里防重入，否则会递归卡死 Host。本插件用 `isApplying` 锁处理
- 空闲收回按工具调用次数计，不是按对话轮数
- 配置改动即时生效（重分组），但**已建 agent 的隐藏状态不会因为改 `hiddenGroups` 而重算**——那只影响新会话
- **子代理一律不隐藏**：它作用域里没有 `loadout`，隐藏了就没人能解套。代价是子代理的上下文仍然是全量的（每次派子代理都吃一份完整 schema）
- 报错自愈只在 `UNKNOWN_TOOL` 上生效，且只对**已归组且当前隐藏**的工具改写；未归组的工具本来就能调，不需要引导
- 两个面板端点（state/config）带自守卫：自定义头 `x-dsh-loadout: 1` + Host 必须本机回环 + Origin 一致。手机经 remote-web-ui 隧道打不开面板，这是代价不是 bug

## 效果实测（2026-10-27，本机）

同机同注册表（252 个工具）：顶层会话可见 schema ≈ 2410 token（deny 210），子代理全量可见 ≈ 40053 token —— 约 16.6 : 1。子代理不隐藏，所以它那份就是"不启用本插件"的基线对照，不用停插件也能测。

## 测试

```bash
node tests/test-grouping.mjs   # 分组/匹配/配置/模式/切断的纯逻辑，29 条
node tests/smoke.mjs           # 假 ctx 跑 apply()：注册/掩码/租约/自愈/面板/子代理/参数校验/端点守卫/观察区/模式/切断/会话接口/门面，81 条
node tests/client-check.mjs    # 客户端那一半能否加载并注册面板
node tests/sim.mjs             # 拿本机真实工具表对拍：哪些被藏、有没有误藏控制面
```

## 验收计数

`loadout {"action":"stats"}` 会报这几个数：

- `visible schemas ≈ N tokens` —— 每个 agent 上一轮实际看到多少 schema（字符数 / 4 估算，只看趋势）
- 自愈触发 N 次 / 搜索命中 N、未命中 N / 代理调用 N、代理拒绝 N
- 每个工具被调用的次数排行

## License

MIT
