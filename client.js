// Client half: 插件详情页（plugins.row.config）里的工具分组面板。
// 数据全部来自 host 侧 /api/dsh-loadout/state；保存走 POST /api/dsh-loadout/config。
// 设计取向：把"当前会话真实状态"和"配置文件默认值"分两栏显示，不混成一句话。
window.__ModuleLoader__.load({
  id: 'dsh-loadout',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useMemo } = React

    // 服务端有闸：必须带 x-dsh-loadout 头，Host 必须是本机（挡 CSRF 和隧道远程路径）
    const PANEL_HEADERS = { 'x-dsh-loadout': '1' }
    async function fetchState() {
      const res = await fetch('/api/dsh-loadout/state', { headers: { ...PANEL_HEADERS, accept: 'application/json' } })
      if (!res.ok) throw new Error('state ' + res.status)
      return res.json()
    }

    async function saveConfig(patch) {
      const res = await fetch('/api/dsh-loadout/config', {
        method: 'POST',
        headers: { ...PANEL_HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || 'config ' + res.status)
      return body
    }

    // 会话内开关：用户本人在面板上直接激活/收回某组、解除切断。
    // 这是用户动作，不走 gated 确认闸（闸挡的是模型代激活）。
    async function sessionAction(agentId, group, action) {
      const res = await fetch('/api/dsh-loadout/session', {
        method: 'POST',
        headers: { ...PANEL_HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({ agentId, group, action }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || 'session ' + res.status)
      return body
    }

    const CSS = `
      .tctl-wrap{font-size:13px;line-height:1.6;color:#2b2722;background:#faf7f2;border:1px solid #e8e1d6;border-radius:12px;padding:18px;font-family:-apple-system,"PingFang SC","Segoe UI",system-ui,sans-serif}
      .tctl-hint{color:#8a8070;margin:0 0 14px;font-size:12.5px}
      .tctl-sec{margin-top:22px;font-weight:600;color:#3a342c;font-size:13px;padding-top:14px;border-top:1px solid #ebe4d9;display:flex;align-items:center;gap:10px}
      .tctl-tag{font-weight:400;font-size:11px;color:#9a9082;background:#f2ece1;border-radius:5px;padding:1px 7px}
      .tctl-row{border:1px solid #ebe4d9;background:#fffdf9;border-radius:9px;padding:9px 13px}
      .tctl-row+.tctl-row{margin-top:6px}
      .tctl-head{display:flex;align-items:center;gap:10px;cursor:pointer}
      .tctl-dot{width:7px;height:7px;border-radius:50%;flex:none;background:#b8a98f}
      .tctl-dot[data-on="true"]{background:#7fae7a}
      .tctl-name{font-weight:600;min-width:104px;color:#3a342c}
      .tctl-desc{flex:1;color:#9a9082;font-size:12px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .tctl-count{font-size:11.5px;color:#a89c8c;font-variant-numeric:tabular-nums;white-space:nowrap}
      .tctl-caret{color:#b8a98f;font-size:11px;width:10px}
      .tctl-tools{margin-top:8px;padding:8px 10px;background:#f7f2e9;border-radius:7px;font-family:ui-monospace,"Cascadia Mono",Consolas,monospace;font-size:11.5px;color:#6b6154;line-height:1.75;word-break:break-all}
      .tctl-btn{border:1px solid #ddd3c4;background:#fffdf9;color:#5c5346;border-radius:7px;padding:4px 12px;font-size:12px;cursor:pointer;transition:all .15s;white-space:nowrap}
      .tctl-btn:hover{background:#f6f1e8;border-color:#cfc2ae;color:#3a342c}
      .tctl-btn[data-on="true"]{background:#c9a96a;color:#fff;border-color:#c9a96a;box-shadow:0 1px 3px rgba(201,169,106,.3)}
      .tctl-btn:disabled{opacity:.5;cursor:default}
      .tctl-toolbar{display:flex;gap:10px;align-items:center;margin:16px 0 0;flex-wrap:wrap}
      .tctl-label{font-size:12.5px;color:#8a8070}
      .tctl-num{width:74px;padding:5px 9px;border-radius:7px;border:1px solid #ddd3c4;background:#fff;color:#3a342c;font-size:12.5px}
      .tctl-num:focus{outline:none;border-color:#c9a96a;box-shadow:0 0 0 2px rgba(201,169,106,.15)}
      .tctl-msg{margin-top:12px;font-size:12.5px;padding:8px 12px;border-radius:7px;background:#f4efe4;color:#6b6154}
      .tctl-err{color:#a8543f;background:#faf0eb}
      .tctl-ok{color:#5d7f57;background:#f2f5ee}
      .tctl-agent{border:1px solid #ebe4d9;border-radius:9px;padding:9px 13px;background:#fffdf9;font-size:12px}
      .tctl-agent+.tctl-agent{margin-top:6px}
      .tctl-mono{font-family:ui-monospace,"Cascadia Mono",Consolas,monospace;font-size:11.5px;color:#6b6154}
      .tctl-un{max-height:180px;overflow:auto;padding:9px 12px;background:#f7f2e9;border-radius:8px;font-family:ui-monospace,Consolas,monospace;font-size:11.5px;color:#6b6154;line-height:1.8;word-break:break-all}
      .tctl-rule{border:1px solid #ebe4d9;border-radius:9px;padding:11px 13px;background:#fffdf9}
      .tctl-rule+.tctl-rule{margin-top:8px}
      .tctl-in,.tctl-ta{width:100%;box-sizing:border-box;border:1px solid #ddd3c4;border-radius:7px;padding:5px 9px;font-size:12px;color:#3a342c;background:#fff;font-family:inherit}
      .tctl-in:focus,.tctl-ta:focus{outline:none;border-color:#c9a96a;box-shadow:0 0 0 2px rgba(201,169,106,.15)}
      .tctl-ta{font-family:ui-monospace,Consolas,monospace;font-size:11.5px;resize:vertical;min-height:38px}
      .tctl-field{display:flex;gap:8px;align-items:flex-start;margin-top:6px}
      .tctl-field>span{width:74px;flex:none;font-size:11.5px;color:#9a9082;padding-top:5px}
      .tctl-stats{display:grid;grid-template-columns:1fr auto;gap:1px 16px;font-size:12px;margin-top:8px;max-height:220px;overflow:auto;color:#6b6154}
      .tctl-stat-row{display:contents}
      .tctl-empty{color:#a89c8c;font-size:12px;font-style:italic}
      .tctl-grid{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
      .tctl-op{color:#9a9082;font-size:11.5px;margin-top:4px}
    `

    // 规则编辑器：把一条规则拆成 prefix/name/pattern 三行，用逗号或换行分隔
    const splitList = (v) => String(v ?? '').split(/[\n,]/).map((s) => s.trim()).filter(Boolean)
    const joinList = (v) => (Array.isArray(v) ? v.join('\n') : '')

    function RuleEditor({ rule, onChange, onRemove }) {
      return h('div', { className: 'tctl-rule' },
        h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
          h('input', {
            className: 'tctl-in', style: { fontWeight: 600, maxWidth: '150px' }, value: rule.name ?? '',
            placeholder: '组名', onChange: (e) => onChange({ ...rule, name: e.target.value }),
          }),
          h('input', {
            className: 'tctl-in', value: rule.desc ?? '', placeholder: '一句话说明什么时候用这组',
            onChange: (e) => onChange({ ...rule, desc: e.target.value }),
          }),
          h('button', { className: 'tctl-btn', onClick: onRemove }, '删除')
        ),
        h('div', { className: 'tctl-field' },
          h('span', null, '前缀'),
          h('textarea', {
            className: 'tctl-ta', value: joinList(rule.prefixes), placeholder: 'univer_  （每行一个，逗号也行）',
            onChange: (e) => onChange({ ...rule, prefixes: splitList(e.target.value) }),
          })
        ),
        h('div', { className: 'tctl-field' },
          h('span', null, '全名'),
          h('textarea', {
            className: 'tctl-ta', value: joinList(rule.names), placeholder: 'present  （精确匹配，不是前缀）',
            onChange: (e) => onChange({ ...rule, names: splitList(e.target.value) }),
          })
        ),
        h('div', { className: 'tctl-field' },
          h('span', null, '正则'),
          h('textarea', {
            className: 'tctl-ta', value: joinList(rule.patterns), placeholder: '^(create|update)_goal$',
            onChange: (e) => onChange({ ...rule, patterns: splitList(e.target.value) }),
          })
        )
      )
    }

    function Panel() {
      const [state, setState] = useState(null)
      const [err, setErr] = useState('')
      const [msg, setMsg] = useState('')
      const [busy, setBusy] = useState(false)
      const [tab, setTab] = useState('groups')
      const [open, setOpen] = useState(null)
      const [idle, setIdle] = useState('')
      const [hiddenGroups, setHiddenGroups] = useState(null)
      const [rules, setRules] = useState(null)
      const [neverHide, setNeverHide] = useState('')
      // 2026-10-27 全配置化：高级项
      const [neverHideReplace, setNeverHideReplace] = useState('')
      const [sensitive, setSensitive] = useState('')
      const [sensitiveExtra, setSensitiveExtra] = useState('')
      const [healText, setHealText] = useState('')
      const [catalogNote, setCatalogNote] = useState('')
      const [reviewWindow, setReviewWindow] = useState('30')
      const [hideInSub, setHideInSub] = useState(false)
      const [catMode, setCatMode] = useState('full')
      // 2026-10-28 第二批：观察区 / 可见性当权限 / 切断外联 / 模式
      const [trialOn, setTrialOn] = useState(true)
      const [trialPromote, setTrialPromote] = useState('3')
      const [gated, setGated] = useState('')
      const [cutOn, setCutOn] = useState(false)
      const [cutLasts, setCutLasts] = useState('30')
      const [cutGroups, setCutGroups] = useState('')
      const [cutTriggers, setCutTriggers] = useState('')
      const [cutTriggerTools, setCutTriggerTools] = useState('')
      const [modesText, setModesText] = useState('')
      const [gatedEmpty, setGatedEmpty] = useState(false)
      const [mcpAuto, setMcpAuto] = useState(true)
      const [showAdv, setShowAdv] = useState(false)

      const load = useCallback(async () => {
        try {
          const s = await fetchState()
          setState(s)
          setIdle(String(s.idleCalls ?? 30))
          setHiddenGroups(new Set((s.groups ?? []).filter((g) => g.defaultHidden).map((g) => g.name)))
          setRules(JSON.parse(JSON.stringify(s.rules ?? [])))
          setNeverHide(splitList(joinList(s.neverHide)).join('\n'))
          setNeverHideReplace(splitList(joinList(s.neverHideReplace)).join('\n'))
          setSensitive(splitList(joinList(s.sensitive)).join('\n'))
          setSensitiveExtra(splitList(joinList(s.sensitiveExtra)).join('\n'))
          setHealText(s.healText ?? '')
          setCatalogNote(s.catalogNote ?? '')
          setReviewWindow(String(s.reviewWindowDays ?? 30))
          setHideInSub(s.hideInSubagents === true)
          setCatMode(s.catalogMode === 'compact' ? 'compact' : 'full')
          setTrialOn(s.trial?.enabled !== false)
          setTrialPromote(String(s.trial?.promoteAfter ?? 3))
          setGated(splitList(joinList(s.gatedGroupsRaw)).join('\n'))
          setCutOn(s.cut === true)
          setCutLasts(String(s.cutLasts ?? 30))
          setCutGroups(splitList(joinList(s.cutGroupsRaw)).join('\n'))
          setCutTriggers(splitList(joinList(s.cutTriggersRaw)).join('\n'))
          setCutTriggerTools(splitList(joinList(s.cutTriggerToolsRaw)).join('\n'))
          setModesText(s.modesRaw ? JSON.stringify(s.modesRaw, null, 1) : '')
          setGatedEmpty(Array.isArray(s.gatedGroupsRaw) && s.gatedGroupsRaw.length === 0)
          setMcpAuto(s.mcpGroups !== false)
          setErr('')
        } catch (e) {
          setErr(String(e.message || e))
        }
      }, [])

      useEffect(() => { load() }, [load])

      const agents = useMemo(() => (Array.isArray(state?.agents) ? state.agents : []), [state])
      const groups = useMemo(() => state?.groups ?? [], [state])
      // 哪个组当前被哪个 agent 隐藏着
      const liveHiddenBy = useMemo(() => {
        const m = new Map()
        for (const a of agents) for (const g of a.hidden ?? []) {
          if (!m.has(g)) m.set(g, [])
          m.get(g).push(a.id)
        }
        return m
      }, [agents])

      const toggleDefault = (name) => {
        const next = new Set(hiddenGroups)
        if (next.has(name)) next.delete(name); else next.add(name)
        setHiddenGroups(next)
      }

      const save = async () => {
        setBusy(true); setMsg('')
        try {
          const payload = {
            hiddenGroups: [...(hiddenGroups ?? [])].filter((n) => groups.some((g) => g.name === n)),
            idleCalls: Number(idle) || 30,
            groups: rules,
            neverHide: splitList(neverHide),
            // 这三个留空 = 用默认（null），空数组是有语义的不许混：neverHideReplace:[] 会把基础名单清空、sensitive:[] 会放开全部代理限制
            neverHideReplace: splitList(neverHideReplace).length ? splitList(neverHideReplace) : null,
            sensitive: splitList(sensitive).length ? splitList(sensitive) : null,
            sensitiveExtra: splitList(sensitiveExtra).length ? splitList(sensitiveExtra) : null,
            healText: healText.trim() || null,
            catalogNote: catalogNote.trim() || null,
            reviewWindowDays: Number(reviewWindow) || 30,
            hideInSubagents: hideInSub === true,
            catalogMode: catMode,
            // 2026-10-28 第二批
            trial: trialOn === true,
            trialPromoteAfter: Number(trialPromote) || 3,
            // 留空 = 内置默认名单（null）；勾了"置空"= 空数组 []
            gatedGroups: gatedEmpty ? [] : (splitList(gated).length ? splitList(gated) : null),
            cut: cutOn === true,
            cutLasts: Number(cutLasts) || 30,
            cutGroups: splitList(cutGroups).length ? splitList(cutGroups) : null,
            cutTriggers: splitList(cutTriggers).length ? splitList(cutTriggers) : null,
            cutTriggerTools: splitList(cutTriggerTools).length ? splitList(cutTriggerTools) : null,
            modes: modesText.trim() ? JSON.parse(modesText) : null,
            mcpGroups: mcpAuto ? null : false,
          }
          const r = await saveConfig(payload)
          setMsg(r.regrouped
            ? '已保存并重新分组：新会话按新规则；当前会话的组表也已重算。'
            : '已保存。规则未变化，无需重分组。')
          await load()
        } catch (e) {
          setMsg('保存失败：' + String(e.message || e))
        } finally { setBusy(false) }
      }

      const resetRules = () => {
        setRules(state?.rulesSource === 'config' ? [] : JSON.parse(JSON.stringify(state?.rules ?? [])))
        setMsg('已恢复成面板载入时的规则，点保存才写入。')
      }

      // 会话内手动开关（用户本人操作，服务端记日志）
      const doSession = async (agentId, group, action) => {
        setBusy(true); setMsg('')
        try {
          await sessionAction(agentId, group, action)
          const verb = action === 'activate' ? '激活' : action === 'deactivate' ? '收回' : '解除切断'
          setMsg(`已${verb}${group ? ' ' + group : ''}（用户手动操作，已记日志）`)
          await load()
        } catch (e) {
          setMsg('操作失败：' + String(e.message || e))
        } finally { setBusy(false) }
      }

      if (err) return h('div', { className: 'tctl-wrap' },
        h('p', { className: 'tctl-hint tctl-err' }, '读取失败：' + err),
        h('button', { className: 'tctl-btn', onClick: load }, '重试'))

      if (!state) return h('div', { className: 'tctl-wrap' }, '加载中…')

      const totalHidden = agents.reduce((s, a) => s + (a.deny ?? 0), 0)
      const statsArr = Object.entries(state.stats ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 20)

      const tabs = [
        ['groups', `分组（${groups.length}）`],
        ['rules', `规则（${(rules ?? []).length}）`],
        ['live', `会话（${agents.length}）`],
        ['stats', '调用频率'],
      ]

      return h('div', { className: 'tctl-wrap' },
        h('style', null, CSS),
        h('p', { className: 'tctl-hint' },
          `${groups.length} 个组、${groups.reduce((s, g) => s + g.count, 0)} 个工具已归组；` +
          `${(state.unmatched ?? []).length} 个未归组（始终可见）。` +
          `活跃 agent ${agents.length} 个，当前共隐藏 ${totalHidden} 个工具。`
        ),

        h('div', { className: 'tctl-toolbar', style: { marginTop: 0 } },
          ...tabs.map(([k, label]) => h('button', {
            key: k, className: 'tctl-btn', 'data-on': String(tab === k), onClick: () => setTab(k),
          }, label)),
          h('button', { className: 'tctl-btn', disabled: busy, onClick: load, style: { marginLeft: 'auto' } }, '刷新')
        ),

        tab === 'groups' && h('div', { style: { marginTop: '14px' } },
          groups.length === 0 ? h('p', { className: 'tctl-empty' }, '还没有任何组被规则认领。去「规则」页加一条。') :
          groups.map((g) => {
            const isOpen = open === g.name
            const liveBy = liveHiddenBy.get(g.name) ?? []
            return h('div', { key: g.name, className: 'tctl-row' },
              h('div', { className: 'tctl-head', onClick: () => setOpen(isOpen ? null : g.name) },
                h('span', { className: 'tctl-caret' }, isOpen ? '▾' : '▸'),
                h('span', { className: 'tctl-dot', 'data-on': String(!hiddenGroups?.has(g.name)) }),
                h('span', { className: 'tctl-name' }, g.name),
                h('span', { className: 'tctl-desc', title: g.desc }, g.desc || '（无说明）'),
                h('span', { className: 'tctl-count' }, `${g.count} 个 · ${g.calls} 次`),
                liveBy.length > 0 ? h('span', { className: 'tctl-tag', title: liveBy.join(', ') }, `会话中已隐藏`) : null,
                h('button', {
                  className: 'tctl-btn', 'data-on': String(hiddenGroups?.has(g.name)),
                  onClick: (e) => { e.stopPropagation(); toggleDefault(g.name) },
                }, hiddenGroups?.has(g.name) ? '默认隐藏' : '默认放行')
              ),
              isOpen ? h('div', { className: 'tctl-tools' }, (g.tools ?? []).join('  ') || '（空）') : null
            )
          }),
          h('p', { className: 'tctl-hint', style: { marginTop: '12px' } },
            '「默认隐藏/默认放行」是新建会话的初始状态；当前会话请在「会话」页看各自的真实开关。')
        ),

        tab === 'rules' && h('div', { style: { marginTop: '14px' } },
          h('p', { className: 'tctl-hint' },
            `当前规则来源：${state.rulesSource === 'config' ? 'loadout-config.json（面板可改）' : '插件内置默认值（保存后转为配置文件）'}。` +
            '一条规则按顺序匹配：先全名，再前缀，最后正则；都不命中就保持可见。'
          ),
          (rules ?? []).map((r, i) => h(RuleEditor, {
            key: i, rule: r,
            onChange: (next) => setRules(rules.map((x, j) => (j === i ? next : x))),
            onRemove: () => setRules(rules.filter((_, j) => j !== i)),
          })),
          h('div', { className: 'tctl-toolbar' },
            h('button', {
              className: 'tctl-btn',
              onClick: () => setRules([...(rules ?? []), { name: '', desc: '', prefixes: [], names: [], patterns: [] }]),
            }, '+ 加一条规则'),
            h('button', { className: 'tctl-btn', onClick: () => setRules([]) }, '清空全部规则'),
            h('button', { className: 'tctl-btn', onClick: resetRules }, '撤销未保存改动')
          ),
          h('div', { className: 'tctl-sec' }, '永不隐藏', h('span', { className: 'tctl-tag' }, '控制面')),
          h('p', { className: 'tctl-hint' },
            '这些工具名（每行一个）无论规则怎么写都不会被隐藏。loadout / tools_search / tools_call 必须在里面，否则没有任何工具能解除隐藏。'),
          h('textarea', {
            className: 'tctl-ta', style: { minHeight: '68px' }, value: neverHide,
            onChange: (e) => setNeverHide(e.target.value),
          }),
          h('div', { className: 'tctl-toolbar', style: { marginTop: '10px' } },
            h('button', { className: 'tctl-btn', 'data-on': String(showAdv), onClick: () => setShowAdv(!showAdv) },
              showAdv ? '收起高级配置' : '高级配置')),
          showAdv && h('div', null,
            h('div', { className: 'tctl-sec' }, '基础豁免替换', h('span', { className: 'tctl-tag' }, 'neverHideReplace')),
            h('p', { className: 'tctl-hint' },
              '留空 = 用插件内置基础名单。填了（每行一个）就整体替换它——上面那三个控制面工具除外，它们永远豁免。'),
            h('textarea', {
              className: 'tctl-ta', style: { minHeight: '52px' }, value: neverHideReplace,
              onChange: (e) => setNeverHideReplace(e.target.value),
            }),
            h('div', { className: 'tctl-sec' }, '代理黑名单：替换 / 追加'),
            h('p', { className: 'tctl-hint' },
              'tools_call 会拒绝这些工具走代理（外发、执行、破坏类）。第一框留空 = 用内置名单，填了则整体替换（危险：填错等于放开代理限制）；第二框恒为追加。'),
            h('textarea', {
              className: 'tctl-ta', style: { minHeight: '52px' }, value: sensitive,
              onChange: (e) => setSensitive(e.target.value),
            }),
            h('textarea', {
              className: 'tctl-ta', style: { minHeight: '40px' }, value: sensitiveExtra,
              placeholder: '追加（每行一个）', onChange: (e) => setSensitiveExtra(e.target.value),
            }),
            h('div', { className: 'tctl-sec' }, '自愈文案模板', h('span', { className: 'tctl-tag' }, 'healText')),
            h('p', { className: 'tctl-hint' }, '留空 = 内置引导。{tool} 和 {group} 是占位符，会被工具名和组名替换。'),
            h('textarea', {
              className: 'tctl-ta', style: { minHeight: '40px' }, value: healText,
              onChange: (e) => setHealText(e.target.value),
            }),
            h('div', { className: 'tctl-sec' }, '目录附言', h('span', { className: 'tctl-tag' }, 'catalogNote')),
            h('p', { className: 'tctl-hint' }, '追加在工具目录末尾的自定义行，留空不加。'),
            h('textarea', {
              className: 'tctl-ta', style: { minHeight: '40px' }, value: catalogNote,
              onChange: (e) => setCatalogNote(e.target.value),
            }),
            h('div', { className: 'tctl-sec' }, '观察区 / 可见性当权限', h('span', { className: 'tctl-tag' }, 'trial / gatedGroups')),
            h('p', { className: 'tctl-hint' },
              '观察区：启动后才新出现的未认领工具进隐藏的 trial 组，调用够次数自动转正。可见性当权限：列出的组激活时要用户确认（模型得带 confirm:true 重试）。gated 留空 = 内置默认 ssh/email/kimi-cu。'),
            h('div', { className: 'tctl-toolbar' },
              h('button', {
                className: 'tctl-btn', 'data-on': String(trialOn), onClick: () => setTrialOn(!trialOn),
              }, trialOn ? '观察区：开' : '观察区：关'),
              h('span', { className: 'tctl-label' }, '转正次数'),
              h('input', {
                className: 'tctl-num', type: 'number', min: 1, max: 99,
                value: trialPromote, onChange: (e) => setTrialPromote(e.target.value),
              }),
            ),
            h('p', { className: 'tctl-hint', style: { marginTop: '8px' } },
              `观察区现状：已转正 ${(state.trial?.promoted ?? []).length} 个，待观察 ${(state.trial?.pending ?? []).length} 个` +
              ((state.trial?.pending ?? []).length > 0 ? `（${(state.trial.pending).slice(0, 8).join(', ')}${state.trial.pending.length > 8 ? ' …' : ''}）` : '')),
            h('textarea', {
              className: 'tctl-ta', style: { minHeight: '40px' }, value: gated,
              placeholder: 'gated 组（每行一个，留空 = 默认 ssh/email/kimi-cu）', onChange: (e) => setGated(e.target.value),
            }),
            h('label', { className: 'tctl-hint', style: { display: 'flex', alignItems: 'center', gap: '6px' } },
              h('input', { type: 'checkbox', checked: gatedEmpty, onChange: (e) => setGatedEmpty(e.target.checked) }),
              '置空：不闸任何组（相当于 gatedGroups: []）'),
            h('div', { className: 'tctl-sec' }, '读外网切断外联', h('span', { className: 'tctl-tag' }, 'cut')),
            h('p', { className: 'tctl-hint' },
              '读到网页后当轮把外发组踢出可见范围（不动组开关，几十次调用后或宿主 turn/end 自动恢复）。默认关。下面三框留空 = 用内置名单。'),
            h('div', { className: 'tctl-toolbar' },
              h('button', {
                className: 'tctl-btn', 'data-on': String(cutOn), onClick: () => setCutOn(!cutOn),
              }, cutOn ? '切断外联：开' : '切断外联：关'),
              h('span', { className: 'tctl-label' }, '持续调用数'),
              h('input', {
                className: 'tctl-num', type: 'number', min: 1, max: 999,
                value: cutLasts, onChange: (e) => setCutLasts(e.target.value),
              }),
            ),
            h('textarea', {
              className: 'tctl-ta', style: { minHeight: '48px' }, value: cutGroups,
              placeholder: '切断哪些组（每行一个，留空 = 默认）', onChange: (e) => setCutGroups(e.target.value),
            }),
            h('textarea', {
              className: 'tctl-ta', style: { minHeight: '36px' }, value: cutTriggers,
              placeholder: '触发组（每行一个，留空 = chrome-devtools/search-ext）', onChange: (e) => setCutTriggers(e.target.value),
            }),
            h('textarea', {
              className: 'tctl-ta', style: { minHeight: '36px' }, value: cutTriggerTools,
              placeholder: '触发工具名（每行一个，留空 = web_fetch/web_search）', onChange: (e) => setCutTriggerTools(e.target.value),
            }),
            h('div', { className: 'tctl-sec' }, '模式切换表', h('span', { className: 'tctl-tag' }, 'modes')),
            h('p', { className: 'tctl-hint' },
              'JSON：{ "coding": { "label": "写代码", "activate": ["ssh"], "hide": [] } }。留空 = 只用内置四档；同名覆盖、新名新增。'),
            h('textarea', {
              className: 'tctl-ta', style: { minHeight: '96px' }, value: modesText,
              placeholder: '{"coding":{"activate":["ssh","context7"]}}', onChange: (e) => setModesText(e.target.value),
            }),
            h('p', { className: 'tctl-hint', style: { marginTop: '8px' } },
              '当前生效（含内置）：' + Object.entries(state.modesEffective ?? {}).map(([k, m]) =>
                `${k}=${(m.activate ?? []).join('/') || '无激活'}${(m.hide ?? []).length ? `·藏${(m.hide ?? []).join('/')}` : ''}`).join('　')),
            h('div', { className: 'tctl-sec' }, 'MCP 自动分组'),
            h('div', { className: 'tctl-toolbar' },
              h('button', {
                className: 'tctl-btn', 'data-on': String(mcpAuto), onClick: () => setMcpAuto(!mcpAuto),
              }, mcpAuto ? 'MCP 按 server 自动成组：开' : 'MCP 自动成组：关（全部进长尾可见）'),
            ),
            h('div', { className: 'tctl-sec' }, '排行窗口 / 子代理 / 目录版本'),
            h('p', { className: 'tctl-hint' },
              'review 和调用排行的统计窗口（天）。「子代理也隐藏」默认关——子代理没有 loadout，藏了无法自救，打开前想清楚。目录版本：full = 全量工具名进目录（模型永远知道有什么，推荐）；compact = 旧版每组三个代表名（留作 A/B 对照）。'),
            h('div', { className: 'tctl-toolbar' },
              h('span', { className: 'tctl-label' }, '排行窗口（天）'),
              h('input', {
                className: 'tctl-num', type: 'number', min: 1, max: 365,
                value: reviewWindow, onChange: (e) => setReviewWindow(e.target.value),
              }),
              h('button', {
                className: 'tctl-btn', 'data-on': String(hideInSub), onClick: () => setHideInSub(!hideInSub),
              }, hideInSub ? '子代理也隐藏：开' : '子代理也隐藏：关'),
              h('button', {
                className: 'tctl-btn', onClick: () => setCatMode(catMode === 'full' ? 'compact' : 'full'),
              }, '目录：' + (catMode === 'full' ? 'full（全名）' : 'compact（三个代表名）')),
            ),
          )
        ),

        tab === 'live' && h('div', { style: { marginTop: '14px' } },
          agents.length === 0 ? h('p', { className: 'tctl-empty' }, '当前没有活跃 agent。') :
          agents.map((a) => h('div', { key: a.id, className: 'tctl-agent' },
            h('div', { className: 'tctl-mono', style: { marginBottom: '4px' } }, a.id + (a.child ? '  [子代理]' : '')),
            h('div', null, `隐藏 ${(a.hidden ?? []).length} 组 · 放行 ${(a.active ?? []).length} 组 · deny ${a.deny ?? 0} 个工具` +
              (a.visibleTokens ? ` · 可见 schema ≈ ${a.visibleTokens} tokens` : '')),
            a.mode ? h('div', { style: { color: '#5d7f57' } }, `当前模式：${a.mode}`) : null,
            a.cut ? h('div', { style: { color: '#a8543f' } },
              `外联已切断：${(a.cut.groups ?? []).join(', ')}（约剩 ${a.cut.remaining} 次调用）`,
              h('button', {
                className: 'tctl-btn', disabled: busy, style: { marginLeft: '8px' },
                onClick: () => doSession(a.id, '', 'release-cut'),
              }, '解除切断')) : null,
            Object.keys(a.leases ?? {}).length > 0 ? h('div', { style: { color: '#9a9082' } },
              '租约：' + Object.entries(a.leases).map(([g, l]) =>
                `${g}${l.maxCalls ? `≤${l.maxCalls}次` : ''}${l.until ? ` 至 ${new Date(l.until).toLocaleTimeString()}` : ''}`).join('，')) : null,
            (a.hidden ?? []).length > 0 ? h('div', { style: { color: '#9a9082' } }, '已隐藏：' + a.hidden.join(', ')) : null,
            h('div', { className: 'tctl-op' }, '点击组名手动切换（用户操作，不走确认闸）：'),
            h('div', { className: 'tctl-grid' },
              groups.filter((g) => g.count > 0).map((g) => {
                const active = !(a.hidden ?? []).includes(g.name)
                return h('button', {
                  key: g.name, className: 'tctl-btn', 'data-on': String(active), disabled: busy,
                  onClick: () => doSession(a.id, g.name, active ? 'deactivate' : 'activate'),
                }, g.name)
              }))
          )),
          h('div', { className: 'tctl-sec' }, '未归组（始终可见）', h('span', { className: 'tctl-tag' }, `${(state.unmatched ?? []).length}`)),
          (state.unmatched ?? []).length === 0
            ? h('p', { className: 'tctl-empty' }, '所有工具都已被规则认领。')
            : h('div', { className: 'tctl-un' }, (state.unmatched ?? []).join('  ')),
          (state.unmatched ?? []).length > 0 ? h('p', { className: 'tctl-hint', style: { marginTop: '8px' } },
            '这些工具没被任何规则认领，所以一直可见——想隐藏它们，去「规则」页补一条前缀或正则。') : null
        ),

        tab === 'stats' && h('div', { style: { marginTop: '14px' } },
          statsArr.length === 0
            ? h('p', { className: 'tctl-empty' }, '还没有调用数据，用一段时间后再来看。')
            : h('div', { className: 'tctl-stats' },
                statsArr.map(([n, c]) => h('div', { key: n, className: 'tctl-stat-row' },
                  h('span', null, n),
                  h('span', { style: { textAlign: 'right', fontVariantNumeric: 'tabular-nums' } }, String(c)))))
        ),

        h('div', { className: 'tctl-toolbar', style: { borderTop: '1px solid #ebe4d9', paddingTop: '14px' } },
          h('span', { className: 'tctl-label' }, '空闲收回阈值（次工具调用）'),
          h('input', {
            className: 'tctl-num', type: 'number', min: 5, max: 500,
            value: idle, onChange: (e) => setIdle(e.target.value),
          }),
          h('button', { className: 'tctl-btn', disabled: busy, onClick: () => setHiddenGroups(new Set(groups.map((g) => g.name))) }, '全部默认隐藏'),
          h('button', { className: 'tctl-btn', disabled: busy, onClick: () => setHiddenGroups(new Set()) }, '全部默认放行'),
          h('button', { className: 'tctl-btn', 'data-on': 'true', disabled: busy, onClick: save }, busy ? '保存中…' : '保存')
        ),
        msg ? h('p', { className: 'tctl-msg ' + (msg.startsWith('保存失败') ? 'tctl-err' : 'tctl-ok') }, msg) : null
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
          name: 'plugins.row.config',
          key: 'dsh-loadout#dsh-loadout',
          id: 'dsh-loadout#dsh-loadout',
        }, Panel))
      },
    }
  },
})
