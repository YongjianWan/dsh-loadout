// Client half: 在 插件详情页（plugins.row.config）渲染工具分组面板。
// 通过 host 桥 /api/dsh-loadout/state 读快照，POST /api/dsh-loadout/config 写配置。
window.__ModuleLoader__.load({
  id: 'dsh-loadout',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback } = React

    async function fetchState() {
      const res = await fetch('/api/dsh-loadout/state', { headers: { accept: 'application/json' } })
      if (!res.ok) throw new Error('state ' + res.status)
      return res.json()
    }

    async function saveConfig(patch) {
      const res = await fetch('/api/dsh-loadout/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      })
      if (!res.ok) throw new Error('config ' + res.status)
      return res.json()
    }

    const CSS = `
      .tctl-wrap{font-size:13px;line-height:1.6;color:#2b2722;background:#faf7f2;border:1px solid #e8e1d6;border-radius:12px;padding:18px;font-family:-apple-system,"PingFang SC","Segoe UI",system-ui,sans-serif}
      .tctl-hint{color:#8a8070;margin:0 0 16px;font-size:12.5px}
      .tctl-row{display:flex;align-items:center;gap:12px;padding:11px 14px;border-radius:9px;border:1px solid #ebe4d9;background:#fffdf9;transition:background .15s,border-color .15s}
      .tctl-row:hover{background:#fff;border-color:#ded4c4}
      .tctl-row+.tctl-row{margin-top:7px}
      .tctl-dot{width:7px;height:7px;border-radius:50%;flex:none}
      .tctl-dot[data-hidden="true"]{background:#b8a98f}
      .tctl-dot[data-hidden="false"]{background:#7fae7a}
      .tctl-name{font-weight:600;min-width:88px;color:#3a342c;letter-spacing:.2px}
      .tctl-desc{flex:1;color:#9a9082;font-size:12px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .tctl-count{font-size:11.5px;color:#a89c8c;min-width:96px;text-align:right;font-variant-numeric:tabular-nums}
      .tctl-btn{border:1px solid #ddd3c4;background:#fffdf9;color:#5c5346;border-radius:7px;padding:4px 12px;font-size:12px;cursor:pointer;transition:all .15s;white-space:nowrap}
      .tctl-btn:hover{background:#f6f1e8;border-color:#cfc2ae;color:#3a342c}
      .tctl-btn[data-on="true"]{background:#c9a96a;color:#fff;border-color:#c9a96a;box-shadow:0 1px 3px rgba(201,169,106,.3)}
      .tctl-btn[data-on="true"]:hover{background:#bd9b58;border-color:#bd9b58}
      .tctl-toolbar{display:flex;gap:10px;align-items:center;margin:18px 0;flex-wrap:wrap;padding-top:14px;border-top:1px solid #ebe4d9}
      .tctl-label{font-size:12.5px;color:#8a8070}
      .tctl-num{width:70px;padding:5px 9px;border-radius:7px;border:1px solid #ddd3c4;background:#fff;color:#3a342c;font-size:12.5px}
      .tctl-num:focus{outline:none;border-color:#c9a96a;box-shadow:0 0 0 2px rgba(201,169,106,.15)}
      .tctl-msg{margin-top:12px;font-size:12.5px;padding:8px 12px;border-radius:7px;background:#f4efe4;color:#6b6154}
      .tctl-err{color:#a8543f;background:#faf0eb}
      .tctl-ok{color:#5d7f57;background:#f2f5ee}
      .tctl-sec{margin-top:20px;font-weight:600;color:#3a342c;font-size:13px;padding-top:14px;border-top:1px solid #ebe4d9}
      .tctl-stats{display:grid;grid-template-columns:1fr auto;gap:1px 16px;font-size:12px;margin-top:10px;max-height:240px;overflow:auto;color:#6b6154}
      .tctl-stat-row{display:contents}
      .tctl-bar{height:3px;border-radius:2px;background:#c9a96a;opacity:.55}
    `

    function Panel() {
      const [state, setState] = useState(null)
      const [err, setErr] = useState('')
      const [msg, setMsg] = useState('')
      const [busy, setBusy] = useState(false)
      const [idle, setIdle] = useState('')
      const [hidden, setHidden] = useState(null)

      const load = useCallback(async () => {
        try {
          const s = await fetchState()
          setState(s)
          setIdle(String(s.idleCalls ?? 30))
          setHidden(new Set(s.groups.filter((g) => g.hidden).map((g) => g.name)))
          setErr('')
        } catch (e) {
          setErr(String(e.message || e))
        }
      }, [])

      useEffect(() => { load() }, [load])

      const toggle = (name) => {
        const next = new Set(hidden)
        if (next.has(name)) next.delete(name); else next.add(name)
        setHidden(next)
      }

      const save = async () => {
        setBusy(true); setMsg('')
        try {
          const groups = state?.groups ?? []
          const hiddenGroups = [...hidden].filter((n) => groups.some((g) => g.name === n))
          await saveConfig({ hiddenGroups, idleCalls: Number(idle) || 30 })
          setMsg('已保存。新会话生效；当前会话的已建 agent 保持原状。')
          await load()
        } catch (e) {
          setMsg('保存失败：' + String(e.message || e))
        } finally { setBusy(false) }
      }

      const resetAll = () => {
        const all = new Set((state?.groups ?? []).map((g) => g.name))
        setHidden(all)
      }

      if (err) return h('div', { className: 'tctl-wrap' },
        h('p', { className: 'tctl-hint tctl-err' }, '读取失败：' + err),
        h('button', { className: 'tctl-btn', onClick: load }, '重试'))

      if (!state) return h('div', { className: 'tctl-wrap' }, '加载中…')

      const groups = state.groups ?? []
      const statsArr = Object.entries(state.stats ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 20)

      return h('div', { className: 'tctl-wrap' },
        h('style', null, CSS),
        h('p', { className: 'tctl-hint' }, `当前 ${groups.length} 个组、核心 ${state.core?.length ?? 0} 个常驻工具、活跃 agent ${state.agents ?? 0} 个。`),
        groups.map((g) => h('div', { key: g.name, className: 'tctl-row' },
          h('span', { className: 'tctl-dot', 'data-hidden': String(hidden?.has(g.name) ?? false) }),
          h('span', { className: 'tctl-name' }, g.name),
          h('span', { className: 'tctl-desc', title: g.desc }, g.desc),
          h('span', { className: 'tctl-count' }, `${g.count} 个 · ${g.calls} 次`),
          h('button', {
            className: 'tctl-btn',
            'data-on': String(hidden?.has(g.name) ?? false),
            onClick: () => toggle(g.name),
          }, hidden?.has(g.name) ? '默认隐藏' : '默认放行')
        )),
        h('div', { className: 'tctl-toolbar' },
          h('span', { className: 'tctl-label' }, '空闲收回阈值（次工具调用）'),
          h('input', {
            className: 'tctl-num', type: 'number', min: 5, max: 500,
            value: idle, onChange: (e) => setIdle(e.target.value),
          }),
          h('button', { className: 'tctl-btn', onClick: resetAll }, '全部默认隐藏'),
          h('button', {
            className: 'tctl-btn', 'data-on': 'true', disabled: busy, onClick: save,
          }, busy ? '保存中…' : '保存')
        ),
        msg ? h('p', { className: 'tctl-msg ' + (msg.startsWith('保存失败') ? 'tctl-err' : 'tctl-ok') }, msg) : null,
        h('div', { className: 'tctl-sec' }, '调用频率 Top 20'),
        h('div', { className: 'tctl-stats' },
          statsArr.length === 0
            ? h('span', { className: 'tctl-hint' }, '还没有数据，用一段时间后回来看看。')
            : statsArr.map(([n, c]) => h('div', { key: n, className: 'tctl-stat-row' },
                h('span', null, n),
                h('span', { style: { textAlign: 'right', fontVariantNumeric: 'tabular-nums' } }, String(c)))))
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
