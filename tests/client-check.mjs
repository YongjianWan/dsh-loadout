// 客户端那一半的加载验证：用假的 __ModuleLoader__ / react 跑一遍 factory，
// 确认它导出了 inject + apply，并且真的往 plugins.row.config 槽位注册了面板。
import assert from 'node:assert'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
let loaded = null
globalThis.window = {
  __ModuleLoader__: {
    load(def) { loaded = def },
  },
}
const h = (type, props, ...kids) => ({ type, props, kids })
globalThis.React = { createElement: h, useState: () => [null, () => {}], useEffect: () => {}, useCallback: (f) => f, useMemo: (f) => f() }

new Function(src)()
assert.ok(loaded, '没有调用 __ModuleLoader__.load')
assert.equal(loaded.id, 'dsh-loadout')

const registered = []
const injected = []
const ctx = {
  slots: {
    inject(name, fn) { injected.push(name); fn() },
    register(a, b) { registered.push({ a, b }); return () => {} },
  },
}
const mod = loaded.factory((id) => {
  if (id === 'react') return globalThis.React
  throw new Error('unexpected require ' + id)
})
assert.deepEqual(mod.inject, ['slots'])
mod.apply(ctx)
assert.deepEqual(injected, ['plugins.row.config'])
assert.equal(registered.length, 1)
assert.equal(registered[0].a.name, 'plugins.row.config')
assert.equal(typeof registered[0].b, 'function')
console.log('client half OK: 面板注册到 plugins.row.config，id=' + loaded.id)
