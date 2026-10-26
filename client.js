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
      .tctl-wrap{font-size:13px;line-height:1.5;color:var(--dsw-alias-text-primary,#1d1d1f)}
      .tctl-hint{color:var(--dsw-alias-text-secondary,#6e6e73);margin:0 0 12px}
      .tctl-row{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-light,rgba(0,0,0,.08))}
      .tctl-row+.tctl-row{margin-top:6px}
      .tctl-name{font-weight:600;min-width:84px}
      .tctl-desc{flex:1;color:var(--dsw-alias-text-secondary,#6e6e73);font-size:12px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .tctl-count{font-size:12px;color:var(--dsw-alias-text-secondary,#6e6e73);min-width:64px;text-align:right}
      .tctl-btn{border:1px solid var(--dsw-alias-border, rgba(0,0,0,.15));background:transparent;color:inherit;border-radius:6px;padding:3px 10px;font-size:12px;cursor:pointer}
      .tctl-btn:hover{background:var(--dsw-alias-fill-hover, rgba(0,0,0,.04))}
      .tctl-btn[data-on="true"]{background:var(--dsw-alias-brand-primary,#247bbf);color:#fff;border-color:transparent}
      .tctl-toolbar{display:flex;gap:8px;align-items:center;margin:14px 0;flex-wrap:wrap}
      .tctl-num{width:64px;padding:3px 6px;border-radius:6px;border:1px solid var(--dsw-alias-border, rgba(0,0,0,.15));background:transparent;color:inherit}
      .tctl-msg{margin-top:10px;font-size:12px}
      .tctl-err{color:#c0392b}
      .tctl-ok{color:#1e7d3a}
      .tctl-sec{margin-top:16px;font-weight:600}
      .tctl-stats{display:grid;grid-template-columns:1fr auto;gap:2px 12px;font-size:12px;margin-top:8px;max-height:220px;overflow:auto}
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
          h('span', { className: 'tctl-name' }, g.name),
          h('span', { className: 'tctl-desc', title: g.desc }, g.desc),
          h('span', { className: 'tctl-count' }, `${g.count} 个 · ${g.calls} 次调用`),
          h('button', {
            className: 'tctl-btn',
            'data-on': String(hidden?.has(g.name) ?? false),
            onClick: () => toggle(g.name),
          }, hidden?.has(g.name) ? '默认隐藏' : '默认放行')
        )),
        h('div', { className: 'tctl-toolbar' },
          h('span', null, '空闲收回阈值（次工具调用）'),
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
            : statsArr.map(([n, c]) => h(React.Fragment, { key: n },
                h('span', null, n), h('span', null, String(c)))))
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
