# dsh-loadout

按需加载工具组的 DSH 插件。**常驻核心只留十来个，其余一百多个工具按组默认隐藏，需要时一句话激活。**

## 解决什么问题

DSH 装到一定规模后，单次会话有 200 个左右的工具，每个工具的完整 JSON schema 每轮都进上下文。实测一个重度配置的会话里，工具 schema 单独就占 73.3K token，是所有文本内容加起来的一半以上。后果有两个：token 白烧，选工具也容易选错。

这个插件把工具分成三档：

- **常驻核心**：文件读写、bash、搜索、skill、记忆读取这些几乎每轮都用的
- **按需组**：浏览器、桌面自动化、Office、邮件、SSH、团队协作等，默认隐藏，`toolctl activate` 一句话放出来
- **长尾档**：新装插件、偶尔用一次的工具，连名字都不进上下文，模型用 `tools_search` 搜到再用 `tools_call` 调

## 三个工具

| 工具 | 作用 |
|---|---|
| `toolctl` | `list` 看状态、`activate`/`deactivate` 开关组、`stats` 看调用频率、`review` 看升降档建议 |
| `tools_search` | 按关键词搜隐藏工具，返回完整 schema。支持中文（内置中英同义词桥接） |
| `tools_call` | 按名字代理调用隐藏工具。外发、远程执行、删除类工具一律拒绝 |

## 安装

```bash
dsh plugin add dsh-loadout
```

或在插件管理器里装。

## 配置面板

插件管理器 → 本插件详情页 → 配置。可以开关每组的默认显隐、调空闲收回阈值、看调用频率排行。

配置写进 `~/.dsh/toolctl-config.json`，新会话生效。

## 工作机制

- 插件在启动时从 `ctx.tools.schemas()` 枚举全局注册表，按前缀规则自动归组（chrome-devtools、kimi-cu、univer、email、ssh、mnemon、mcp_connector 等）。没匹配上的落进 `extras`，同样默认隐藏。
- 新 agent 创建时（`agent/created`）用 `ctx.tools.restrict({ deny })` 隐藏整个组的工具。`restrict` 是呈现、查找、执行三方面同时隐藏，dispose 即恢复，下一次请求生效。
- 注册表有变动（热装插件、MCP 重连）时监听 `tools/change` 重新归组。
- 空闲收回：一组激活后连续 N 次工具调用没碰到组内工具，自动收回。
- **全程 fail-open**：任何异常路径都先解除全部隐藏，宁可全量可见，不停在半隐藏状态。

## 已知限制

- 隐藏对"默认隐藏什么"生效于**新会话**。插件安装前已存在的会话不受影响（这是有意的，避免半路把工具抽走）。
- `restrict` 会同步派发 `tools/change`，监听该事件时必须在回调里防重入，否则会递归。本插件用 `isApplying` 锁处理。
- 空闲收回按工具调用次数计，不是按对话轮数。
- 子代理的 `SessionStartSource` 目前区分不出 spawn/fork（实测都是 `startup`），所以没有按来源做差异化。

## License

MIT
