# dsh-loadout

按需加载工具组的 DSH 插件。**常驻只留十来个，其余按组默认隐藏，需要时一句话激活。**

> 设计与取舍记录：[docs/design.md](docs/design.md)（为什么这么设计、哪些和原设计不一样、还没做完什么）。本文只讲怎么用。

## 解决什么问题

DSH 装到一定规模后，单次会话有 200 个左右的工具，每个工具的完整 JSON schema 每轮都进上下文。实测一个重度配置的会话里，工具 schema 单独就占 73.3K token，是所有文本内容加起来的一半以上。后果有两个：token 白烧，选工具也容易选错。

插件分三档：

- **常驻**：文件读写、bash、搜索、skill、记忆读取这些几乎每轮都用的
- **按需组**：浏览器、办公、邮件、SSH、B 站、团队协作等，默认隐藏，`toolctl activate` 一句话放出来
- **长尾**：没被任何规则认领的工具，**保持可见**，用 `tools_search` 找、`tools_call` 代理调用

## 边界原则（重要）

**只藏"有人认领"的工具。** 隐藏必须由显式规则声明，没被规则命中的一律可见。

这条不是风格问题，是踩过坑：早先的实现有个"extras 兜底组"，把没匹配上的工具统统一藏了之。结果插件自己的控制面（`toolctl` / `tools_search` / `tools_call`）注册时也没匹配上任何规则，被自己藏进了 extras——**221 个工具全藏死，而能解除隐藏的三个按钮自己也被藏了，没有任何解套路径。**

打补丁（给这三个名字开豁免）只是让这个坑晚点再出现：下一个新插件、下一个迟到的 MCP 工具都会掉进同一个兜底组。所以方向反了——从"未知即隐藏"改成"未知即可见"，隐藏由规则认领。

同理，`NEVER_HIDE` 那几条（控制面 + ACP 压缩协议）是第二道锁，不是唯一防线。

## 三个工具

| 工具 | 作用 |
|---|---|
| `toolctl` | `list` 看状态、`activate`/`deactivate` 开关组、`stats` 看调用频率、`review` 看分档建议 |
| `tools_search` | 按关键词搜工具，返回完整 schema。支持中文（内置中英同义词桥接） |
| `tools_call` | 按名字代理调用工具。外发、远程执行、删除类一律拒绝 |

## 安装

```bash
dsh plugin add dsh-loadout
```

或在插件管理器里装。

## 配置

配置文件 `~/.dsh/toolctl-config.json`，**面板改的就是它**，保存后立即重新分组，不必重启：

```json
{
  "groups": [
    { "name": "email", "desc": "邮件：列信、读信、发送…", "prefixes": ["email_"] },
    { "name": "ops",   "desc": "宿主运维", "names": ["present", "workflow"] },
    { "name": "goal",  "desc": "长目标", "patterns": ["^(create|update|get)_goal$"] }
  ],
  "neverHide": ["toolctl", "tools_search", "tools_call"],
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

MCP 工具（`mcp__<server>__<tool>`）始终按 server 名自动成组，不需要写规则；`mcpGroups: false` 可关掉这条。

## 面板

插件管理器 → 本插件详情页 → 配置。

四个页签：

- **分组**：每组一行，点开看全部工具名（不截断）。「默认隐藏/默认放行」是新建会话的初始状态
- **规则**：可视化编辑分组规则，前缀/全名/正则三栏，保存即生效。规则非法（没名字、没有任何匹配方式）会被服务端拒绝，不会写坏配置
- **会话**：每个活跃 agent 的真实开关——哪些组被它隐藏着、租约还剩多久、deny 了多少个工具。下面列出**未归组、始终可见**的工具，提醒补规则
- **调用频率**：Top 20，用来判断哪些该升级成常驻

## 工作机制

- 启动时从 `ctx.tools.schemas()` 枚举全局注册表，按规则归组；没认领的记进 `unmatched`
- 新 agent 创建时（`agent/created`）用 `ctx.tools.restrict({ deny })` 隐藏整个组。`restrict` 是呈现、查找、执行三方面同时隐藏，dispose 即恢复，下一次请求生效
- 注册表变动（热装插件、MCP 重连）时监听 `tools/change` 重新归组
- 空闲收回：一组激活后连续 N 次工具调用没碰到组内工具，自动收回
- **全程 fail-open**：任何异常路径都先解除全部隐藏，宁可全量可见，不停在半隐藏状态
- 组表的 token 预算：目录只列**有工具的组**，空组不进系统提示

## 已知限制

- `restrict` 只作用于 agent 作用域里能看到的全局工具。**agent 自己作用域注册的工具够不到**（团队工具 `send_message` / `spawn_teammate` 等），所以它们保持可见——靠可见性控制权限这条路对它们不成立
- `restrict` 会同步派发 `tools/change`，监听该事件时必须在回调里防重入，否则会递归卡死 Host。本插件用 `isApplying` 锁处理
- 空闲收回按工具调用次数计，不是按对话轮数
- 配置改动即时生效（重分组），但**已建 agent 的隐藏状态不会因为改 `hiddenGroups` 而重算**——那只影响新会话
- **子代理一律不隐藏**：它作用域里没有 `toolctl`，隐藏了就没人能解套。代价是子代理的上下文仍然是全量的（每次派子代理都吃一份完整 schema）
- 报错自愈只在 `UNKNOWN_TOOL` 上生效，且只对**已归组且当前隐藏**的工具改写；未归组的工具本来就能调，不需要引导

## 测试

```bash
node test-grouping.mjs   # 分组/匹配/配置的纯逻辑，18 条
node _smoke.mjs          # 假 ctx 跑 apply()：注册/掩码/租约/自愈/面板/子代理/参数校验，34 条
node _client_check.mjs   # 客户端那一半能否加载并注册面板
node _sim.mjs            # 拿本机真实工具表对拍：哪些被藏、有没有误藏控制面
```

## 验收计数

`toolctl {"action":"stats"}` 会报这几个数，对应设计清单「只看日志就能回答」那几条：

- `visible schemas ≈ N tokens` —— 每个 agent 上一轮实际看到多少 schema（字符数 / 4 估算，只看趋势）
- 自愈触发 N 次 / 搜索命中 N、未命中 N / 代理调用 N、代理拒绝 N
- 每个工具被调用的次数排行

## License

MIT
