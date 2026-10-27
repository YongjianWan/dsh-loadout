# dsh-loadout 项目契约

DSH 插件：按需装配工具。常驻一个小核心，其余工具按组默认隐藏、需要时激活，
长尾走搜索加代理调用。改代码前读本文件；产品行为规范见 [docs/PRD.md](docs/PRD.md)。

## ① 会话启动红线

1. **别从历史文档推断现状。** 本文件与 PRD 是现状；DECISIONS.md 是历史记录，只回答"当初为什么"。
2. **基线验证命令**：`npm run test:unit`（`tests/test-grouping.mjs` + `tests/smoke.mjs` + `tests/client-check.mjs`）。
   2026-10-27 实测退出码 0，29 + 88 条通过。**没有存量失败**——红了就是你改的，没有可甩的锅。
3. **`tests/sim.mjs` 需要 DSH 在跑**（读 `127.0.0.1:55794` 的 state 接口）。不在跑就跳过它，或传端口参数。
4. **改 `index.js` 后必须确认模块能加载**：`node -e "import('./index.js')"`。它的语法错不会在单测里暴露，
   但会让整个插件在宿主里静默失效。
5. **测试会切片读 `index.js`。** `tests/test-grouping.mjs` 和 `tests/sim.mjs` 用
   `src.indexOf('const NEVER_HIDE')` 到 `src.indexOf('const agents = new Map()')` 之间的代码做纯逻辑测试。
   **这段窗口里的结构不能随意移动**——移动锚点会让测试静默切片错误（有断言兜底，但先看报错）。
   往这段里加纯函数是安全的；把 `agents` 声明挪走会炸。

## ② 路由 / 文档速查

| 想知道什么 | 看哪里 | 维护时机 |
|---|---|---|
| 产品现在应该是什么行为 | [docs/PRD.md](docs/PRD.md) | 行为变了就改，别记日期 |
| 当初为什么这么设计、试过什么 | [docs/DECISIONS.md](docs/DECISIONS.md) | 只在有新决策时追加 |
| 知道是问题但暂不修、为什么 | [docs/TECH_DEBT.md](docs/TECH_DEBT.md) | 修完一条删一条 |
| 怎么装、怎么配、面板长什么样 | [README.md](README.md) | 用户可见行为变了就改 |
| DSH 宿主能力与坑 | 本文件 §① 与 PRD §2 | 平台行为变了才改 |

## ③ 怎么跑

```bash
npm run test:unit    # 离线全量：分组逻辑 + 冒烟 + 面板加载（29 + 88 条，约 2 秒）
npm run sim          # 真机对拍：读本机运行中的工具表，验证分组没误藏（需 DSH 在跑）
node tests/smoke.mjs # 单独跑冒烟（最快反馈的回归网）
```

插件以 `link:` 方式装进 DSH（`~/.dsh/profiles/desktop/package.json` 里 `"dsh-loadout": "link:.../toolctl"`），
**改完要重启 DSH 才生效**。单元测试不需要重启。

## ④ 红线与约定

- **高扇入文件**：`index.js`（1784 行，插件全部服务端逻辑）。改它之前先跑一遍 `npm run test:unit` 确立基线，
  改完再跑一次对比。`client.js`（540 行）是面板，改动需要在重启后肉眼验证。
- **控制面不可藏**：`loadout` / `tools_search` / `tools_call` / `browser` 在 NEVER_HIDE 里，
  **任何配置都不能把它们归组或隐藏**（代码里 `effectiveNeverHide` 钉死）。想加新元工具必须同时加进这里，
  否则新工具会被自己的规则藏掉，重演 2026-10-26 那次"全藏死"。
- **禁止在 `ctx.on('tools/change')` 回调里同步调 `restrict`**：会无限递归卡死 Host。
  已有 `isApplying` 锁，别绕过它。
- **`ctx.tools.restrict` 只能管全局注册表**：agent 作用域注册的工具（`send_message` 等）管不到，别指望。
- **版本语义**：功能新增走 minor（1.2.0 → 1.3.0），修 bug 走 patch，破坏配置兼容才走 major。
  `package.json` 的 `version` 与 git tag 保持一致。
- **`docs/PRD.md` 与 `docs/DECISIONS.md` 分工是硬的**：PRD 不放"哪天改了什么"，
  DECISIONS 不放"现在该怎么做"。混了就是这次重构要解决的病。
- **提交粒度**：功能、测试、文档分开提交（见 `git log` 实际历史），不打包成一个。
