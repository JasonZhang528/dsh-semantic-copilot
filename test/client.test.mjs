/**
 * client.js 的行为测试：
 *  - 在 vm 沙箱里加载 bundle（校验 __ModuleLoader__ 注册契约）；
 *  - 用一个足够小的 React shim 真渲染按钮组件；
 *  - 通过假 fetch 驱动 idle → running → done / error / revert 全部状态迁移。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

// ---------------------------------------------------------------------------
// 迷你 React：只实现 client.js 用到的 4 个 hook 与 createElement。
// setState 同步触发重渲染并冲刷 effects，足以覆盖本组件的状态机。
// ---------------------------------------------------------------------------
function createMiniReact() {
  let current = null

  const depsChanged = (a, b) =>
    !a || !b || a.length !== b.length || a.some((value, index) => !Object.is(value, b[index]))

  function render(instance, props) {
    instance.props = props
    instance.cursor = 0
    instance.effectsQueue = []
    current = instance
    try {
      instance.tree = instance.Component(props)
    } finally {
      current = null
    }
    for (const effect of instance.effectsQueue.splice(0)) effect()
    return instance.tree
  }

  function mount(Component, props) {
    const instance = { Component, hooks: [], cursor: 0, effectsQueue: [], cleanups: [], tree: null, props }
    render(instance, props)
    return instance
  }

  function unmount(instance) {
    for (const slot of instance.hooks) {
      if (slot && typeof slot.cleanup === 'function') slot.cleanup()
    }
  }

  const React = {
    createElement(type, props, ...children) {
      return { type, props: { ...(props ?? {}), ...(children.length ? { children: children.length === 1 ? children[0] : children } : {}) } }
    },
    useState(initial) {
      const instance = current
      const index = instance.cursor++
      if (!instance.hooks[index]) {
        instance.hooks[index] = { value: typeof initial === 'function' ? initial() : initial }
      }
      const slot = instance.hooks[index]
      const setState = (next) => {
        const value = typeof next === 'function' ? next(slot.value) : next
        if (Object.is(value, slot.value)) return
        slot.value = value
        render(instance, instance.props)
      }
      return [slot.value, setState]
    },
    useEffect(fn, deps) {
      const instance = current
      const index = instance.cursor++
      const slot = instance.hooks[index]
      if (slot && !depsChanged(slot.deps, deps)) return
      instance.effectsQueue.push(() => {
        // 首次渲染时槽位尚不存在，闭包内必须动态读取，否则 cleanup 无处安放。
        const effectSlot = instance.hooks[index]
        if (effectSlot && typeof effectSlot.cleanup === 'function') effectSlot.cleanup()
        const result = fn()
        if (effectSlot) effectSlot.cleanup = typeof result === 'function' ? result : undefined
      })
      if (!slot) instance.hooks[index] = { deps, cleanup: undefined }
      else slot.deps = deps
    },
    useRef(initial) {
      const instance = current
      const index = instance.cursor++
      if (!instance.hooks[index]) instance.hooks[index] = { current: initial }
      return instance.hooks[index]
    },
    useCallback(fn, deps) {
      const instance = current
      const index = instance.cursor++
      const slot = instance.hooks[index]
      if (slot && !depsChanged(slot.deps, deps)) return slot.value
      if (!slot) instance.hooks[index] = { deps, value: fn }
      else {
        slot.deps = deps
        slot.value = fn
      }
      return fn
    },
  }

  return { React, mount, unmount, rerender: (instance, props) => render(instance, props ?? instance.props) }
}

// ---------------------------------------------------------------------------
// bundle 加载器
// ---------------------------------------------------------------------------
function loadClient(React, fetchImpl, consoleImpl, { timerScale = 1, documentImpl } = {}) {
  const here = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(join(here, '..', 'client.js'), 'utf8')
  let captured = null
  const context = {
    window: { __ModuleLoader__: { load(definition) { captured = definition } } },
    fetch: fetchImpl,
    AbortController,
    // timerScale<1 时把长定时器压缩，便于在测试里等真实的 watchdog 路径。
    setTimeout: (fn, ms, ...rest) => globalThis.setTimeout(fn, Math.max(0, ms * timerScale), ...rest),
    clearTimeout,
    DOMException,
    console: consoleImpl ?? { warn() {}, error() {}, log() {} },
  }
  // 仅在测试显式提供时注入 document：多数用例保持无 DOM 环境，验证样式注入的
  // typeof document 守卫；需要断言 ensureTipStyle 的用例再传入最小 stub。
  if (documentImpl !== undefined) context.document = documentImpl
  vm.createContext(context)
  vm.runInContext(source, context, { filename: 'client.js' })
  assert.ok(captured, 'bundle 应通过 __ModuleLoader__.load 注册')
  const module = captured.factory((id) => {
    if (id === 'react') return React
    throw new Error(`unexpected require: ${id}`)
  })
  return { definition: captured, module }
}

function makeSlotsCtx(localeImpl) {
  const captured = { injected: [], registered: [] }
  const ctx = {
    get: (name) => (name === 'locale' ? localeImpl : undefined),
    slots: {
      inject(name, register) {
        captured.injected.push(name)
        captured.registered.push(register())
      },
      register(meta, Component) {
        return { meta, Component }
      },
    },
  }
  return { ctx, captured }
}


// 递归 + 数组感知：气泡出现后外层 span 含 2 个子节点（数组），单链下钻会断。
function findButton(tree) {
  if (!tree) return null
  if (Array.isArray(tree)) {
    for (const child of tree) {
      const found = findButton(child)
      if (found) return found
    }
    return null
  }
  if (tree.type === 'button') return tree
  return findButton(tree.props && tree.props.children)
}

// 按类名查找气泡节点（含 dsh-semantic-copilot-tip）。
function findTip(tree) {
  if (!tree) return null
  if (Array.isArray(tree)) {
    for (const child of tree) {
      const found = findTip(child)
      if (found) return found
    }
    return null
  }
  const cls = tree.props && tree.props.className
  if (typeof cls === 'string' && cls.includes('dsh-semantic-copilot-tip')) return tree
  return findTip(tree.props && tree.props.children)
}

const flush = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

test('bundle 契约：id / inject / slot 注册', () => {
  const mini = createMiniReact()
  const { definition, module } = loadClient(mini.React, () => { throw new Error('no fetch') })
  assert.equal(definition.id, 'dsh-semantic-copilot')
  // vm 跨 realm 数组原型不同，展开后按值比较。
  assert.deepEqual([...module.inject], ['slots'])
  const { ctx, captured } = makeSlotsCtx(undefined)
  module.apply(ctx)
  assert.equal(captured.injected[0], 'conversation.input.right')
  assert.equal(captured.registered[0].meta.id, 'semantic-copilot')
  assert.equal(captured.registered[0].meta.name, 'conversation.input.right')
})

test('空草稿（idle）：不渲染按钮，组件返回 null', () => {
  const mini = createMiniReact()
  const { module } = loadClient(mini.React, () => { throw new Error('no fetch') })
  const { ctx, captured } = makeSlotsCtx(undefined)
  module.apply(ctx)
  const Component = captured.registered[0].Component
  const state = { draft: '' }
  const instance = mini.mount(Component, { useInput: (sel) => sel(state), inputActions: { setDraft() {} }, keyboard: null, sessionId: 's1' })
  // 空草稿且 !busy && !canRevert && phase!=='error'：返回 null，DOM 中不出现该按钮。
  assert.equal(instance.tree, null)
  assert.equal(findButton(instance.tree), null)
})

test('空草稿（纯空白）：同样返回 null，不渲染按钮', () => {
  const mini = createMiniReact()
  const { module } = loadClient(mini.React, () => { throw new Error('no fetch') })
  const { ctx, captured } = makeSlotsCtx(undefined)
  module.apply(ctx)
  const Component = captured.registered[0].Component
  const state = { draft: '   \n\t ' }
  const instance = mini.mount(Component, { useInput: (sel) => sel(state), inputActions: { setDraft() {} }, keyboard: null, sessionId: 's1' })
  assert.equal(instance.tree, null)
})

test('例外：busy（增强中）时草稿为空仍渲染按钮，可见增强中旋弧', async () => {
  const mini = createMiniReact()
  // fetch 保持到 abort：请求停留在 running 态；卸载 abort 时 reject，finally 会清掉
  // watchdog 定时器，避免 90s 定时器把测试进程挂住。
  const fetchImpl = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')))
    })
  const { module } = loadClient(mini.React, fetchImpl, undefined, { timerScale: 9000 })
  const { ctx, captured } = makeSlotsCtx(undefined)
  module.apply(ctx)
  const Component = captured.registered[0].Component
  const state = { draft: 'A' }
  const props = { useInput: (sel) => sel(state), inputActions: { setDraft() {} }, keyboard: null, sessionId: 's1' }
  const instance = mini.mount(Component, props)
  findButton(instance.tree).props.onClick()
  await flush()
  // 增强中把草稿清空：busy 例外生效，按钮仍渲染且处于 running（旋弧可见）。
  state.draft = ''
  mini.rerender(instance, props)
  const button = findButton(instance.tree)
  assert.ok(button, 'busy 时应仍渲染按钮')
  assert.equal(button.props['data-semantic-copilot'], 'running')
  assert.equal(button.props['aria-busy'], 'true')
  assert.equal(typeof button.props.children.type, 'function') // IconBusy 旋弧
  mini.unmount(instance)
  await flush()
})

test('例外：canRevert（可恢复）时按钮仍渲染，仍可点击恢复原文', async () => {
  const mini = createMiniReact()
  let resolveFetch
  const fetchImpl = () => new Promise((resolve) => { resolveFetch = () => resolve({ ok: true, json: async () => ({ success: true, text: 'B' }) }) })
  const { module } = loadClient(mini.React, fetchImpl)
  const { ctx, captured } = makeSlotsCtx(undefined)
  module.apply(ctx)
  const Component = captured.registered[0].Component
  const setDraftCalls = []
  const state = { draft: 'A' }
  const inputActions = { setDraft(text) { setDraftCalls.push(text); state.draft = text } }
  const props = { useInput: (sel) => sel(state), inputActions, keyboard: null, sessionId: 's1' }
  const instance = mini.mount(Component, props)
  findButton(instance.tree).props.onClick()
  await flush()
  resolveFetch()
  await flush()
  await flush()
  // canRevert 为 true 的状态（phase==='done' 且草稿仍是增强结果）必须渲染按钮，
  // 且点击可恢复原文，不会被「空草稿隐藏」分支吞掉。
  const button = findButton(instance.tree)
  assert.ok(button, 'canRevert 时应仍渲染按钮')
  assert.equal(button.props['data-semantic-copilot'], 'done')
  assert.equal(button.props['aria-label'], '恢复原文')
  button.props.onClick()
  await flush()
  assert.deepEqual(setDraftCalls, ['B', 'A'])
  assert.equal(findButton(instance.tree).props['data-semantic-copilot'], 'idle')
})

test('例外：phase==="error" 时草稿被清空仍渲染按钮，保留失败提示', async () => {
  const mini = createMiniReact()
  const fetchImpl = async () => ({ ok: false, status: 500, json: async () => ({ success: false, error: 'boom' }) })
  const { module } = loadClient(mini.React, fetchImpl)
  const { ctx, captured } = makeSlotsCtx(undefined)
  module.apply(ctx)
  const Component = captured.registered[0].Component
  const state = { draft: 'A' }
  const props = { useInput: (sel) => sel(state), inputActions: { setDraft() {} }, keyboard: null, sessionId: 's1' }
  const instance = mini.mount(Component, props)
  findButton(instance.tree).props.onClick()
  await flush()
  await flush()
  // 失败后清空草稿：error 例外生效，按钮仍渲染并保留 ⚠ 与失败 title。
  state.draft = ''
  mini.rerender(instance, props)
  const button = findButton(instance.tree)
  assert.ok(button, 'error 时应仍渲染按钮')
  assert.equal(button.props['data-semantic-copilot'], 'error')
  assert.equal(button.props['aria-label'], '增强失败')
  assert.equal(button.props['data-tip'], '增强失败：boom')
})

test('点击增强：请求成功后替换草稿并进入可恢复状态', async () => {
  const mini = createMiniReact()
  const calls = []
  let resolveFetch
  const fetchImpl = (_url, init) =>
    new Promise((resolve) => {
      resolveFetch = () =>
        resolve({ ok: true, json: async () => ({ success: true, text: '更清晰的提示词' }) })
      assert.equal(init.method, 'POST')
      assert.equal(init.url ?? _url, '/prompt-enhance')
      assert.deepEqual(JSON.parse(init.body), { text: '原始草稿', sessionId: 's1' })
      calls.push('requested')
    })

  const { module } = loadClient(mini.React, fetchImpl)
  const { ctx, captured } = makeSlotsCtx(undefined)
  module.apply(ctx)
  const Component = captured.registered[0].Component
  const setDraftCalls = []
  const state = { draft: '原始草稿' }
  const inputActions = { setDraft(text) { setDraftCalls.push(text); state.draft = text } }
  const instance = mini.mount(Component, { useInput: (sel) => sel(state), inputActions, keyboard: null, sessionId: 's1' })

  let button = findButton(instance.tree)
  assert.equal(button.props.disabled, false)
  assert.equal(button.props['data-tip'], '语义增强')

  button.props.onClick()
  await flush()
  button = findButton(instance.tree)
  assert.equal(button.props['data-semantic-copilot'], 'running')
  assert.equal(button.props.disabled, true)
  assert.equal(button.props['aria-busy'], 'true')

  resolveFetch()
  await flush()
  await flush()
  assert.deepEqual(setDraftCalls, ['更清晰的提示词'])
  button = findButton(instance.tree)
  assert.equal(button.props['data-semantic-copilot'], 'done')
  assert.equal(button.props['aria-label'], '恢复原文')
})

test('再次点击恢复原文', async () => {
  const mini = createMiniReact()
  let resolveFetch
  const fetchImpl = () => new Promise((resolve) => { resolveFetch = () => resolve({ ok: true, json: async () => ({ success: true, text: 'B' }) }) })
  const { module } = loadClient(mini.React, fetchImpl)
  const { ctx, captured } = makeSlotsCtx(undefined)
  module.apply(ctx)
  const Component = captured.registered[0].Component
  const setDraftCalls = []
  const state = { draft: 'A' }
  const inputActions = { setDraft(text) { setDraftCalls.push(text); state.draft = text } }
  const instance = mini.mount(Component, { useInput: (sel) => sel(state), inputActions, keyboard: null, sessionId: 's1' })

  findButton(instance.tree).props.onClick()
  await flush()
  resolveFetch()
  await flush()
  await flush()
  findButton(instance.tree).props.onClick()
  await flush()
  assert.deepEqual(setDraftCalls, ['B', 'A'])
  assert.equal(findButton(instance.tree).props['data-semantic-copilot'], 'idle')
})

test('请求失败：进入 error 态，title 携带原因', async () => {
  const mini = createMiniReact()
  const fetchImpl = async () => ({ ok: false, status: 500, json: async () => ({ success: false, error: 'LLM service is not available' }) })
  const { module } = loadClient(mini.React, fetchImpl)
  const { ctx, captured } = makeSlotsCtx(undefined)
  module.apply(ctx)
  const Component = captured.registered[0].Component
  const state = { draft: 'A' }
  const inputActions = { setDraft() {} }
  const instance = mini.mount(Component, { useInput: (sel) => sel(state), inputActions, keyboard: null, sessionId: 's1' })

  findButton(instance.tree).props.onClick()
  await flush()
  await flush()
  const button = findButton(instance.tree)
  assert.equal(button.props['data-semantic-copilot'], 'error')
  assert.equal(button.props['aria-label'], '增强失败')
  assert.equal(button.props['data-tip'], '增强失败：LLM service is not available')
  assert.equal(button.props.disabled, false)
})

test('切换会话重置状态', async () => {
  const mini = createMiniReact()
  let resolveFetch
  const fetchImpl = () => new Promise((resolve) => { resolveFetch = () => resolve({ ok: true, json: async () => ({ success: true, text: 'B' }) }) })
  const { module } = loadClient(mini.React, fetchImpl)
  const { ctx, captured } = makeSlotsCtx(undefined)
  module.apply(ctx)
  const Component = captured.registered[0].Component
  const state = { draft: 'A' }
  const inputActions = { setDraft(text) { state.draft = text } }
  const props = { useInput: (sel) => sel(state), inputActions, keyboard: null, sessionId: 's1' }
  const instance = mini.mount(Component, props)

  findButton(instance.tree).props.onClick()
  await flush()
  resolveFetch()
  await flush()
  await flush()
  assert.equal(findButton(instance.tree).props['data-semantic-copilot'], 'done')

  mini.rerender(instance, { ...props, sessionId: 's2' })
  assert.equal(findButton(instance.tree).props['data-semantic-copilot'], 'idle')
})

test('卸载时中止在途请求', async () => {
  const mini = createMiniReact()
  const signals = []
  const fetchImpl = (_url, init) => {
    signals.push(init.signal)
    // abort 时 reject，避免挂起；同时压缩 watchdog，别让 90s 定时器拖住进程。
    return new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')))
    })
  }
  // timerScale 放大等效禁用 watchdog（90s×9000），避免 10ms 内误触发 abort。
  const { module } = loadClient(mini.React, fetchImpl, undefined, { timerScale: 9000 })
  const { ctx, captured } = makeSlotsCtx(undefined)
  module.apply(ctx)
  const Component = captured.registered[0].Component
  const state = { draft: 'A' }
  const instance = mini.mount(Component, { useInput: (sel) => sel(state), inputActions: { setDraft() {} }, keyboard: null, sessionId: 's1' })
  findButton(instance.tree).props.onClick()
  await flush()
  await flush()
  assert.equal(signals.length, 1)
  assert.equal(signals[0].aborted, false)
  mini.unmount(instance)
  assert.equal(signals[0].aborted, true)
})

test('locale 服务可用时使用绑定文案', () => {
  const mini = createMiniReact()
  const registeredNamespaces = []
  const locale = {
    register: (ns, lang, table) => registeredNamespaces.push({ ns, lang, keys: Object.keys(table).length }),
    bind: (ns) => (key) => (ns === 'semantic-copilot' && key === 'enhance' ? 'Enhance' : key),
  }
  const { module } = loadClient(mini.React, () => { throw new Error('no fetch') })
  const { ctx, captured } = makeSlotsCtx(locale)
  module.apply(ctx)
  const Component = captured.registered[0].Component
  const state = { draft: 'A' }
  const instance = mini.mount(Component, { useInput: (sel) => sel(state), inputActions: { setDraft() {} }, keyboard: null, sessionId: 's1' })
  assert.ok(registeredNamespaces.some((item) => item.ns === 'semantic-copilot' && item.lang === 'zh'))
  assert.ok(registeredNamespaces.some((item) => item.ns === 'semantic-copilot' && item.lang === 'en'))
  assert.equal(findButton(instance.tree).props['aria-label'], 'Enhance')
})

test('locale.bind 返回键名时回退内置表', () => {
  const mini = createMiniReact()
  const locale = { register() {}, bind: () => (key) => key }
  const { module } = loadClient(mini.React, () => { throw new Error('no fetch') })
  const { ctx, captured } = makeSlotsCtx(locale)
  module.apply(ctx)
  const Component = captured.registered[0].Component
  const state = { draft: 'A' }
  const instance = mini.mount(Component, { useInput: (sel) => sel(state), inputActions: { setDraft() {} }, keyboard: null, sessionId: 's1' })
  assert.equal(findButton(instance.tree).props['aria-label'], '语义增强')
})

test('props.t 回显键名时也不泄漏键名（回归 tipEnhance）', () => {
  const mini = createMiniReact()
  const { module } = loadClient(mini.React, () => { throw new Error('no fetch') })
  const { ctx, captured } = makeSlotsCtx(undefined)
  module.apply(ctx)
  const Component = captured.registered[0].Component
  const state = { draft: 'A' }
  // 模拟宿主透传的 t：未知键原样回显（与真实 translate 的 `?? key` 一致）。
  const echoT = (key) => key
  const instance = mini.mount(Component, { useInput: (sel) => sel(state), inputActions: { setDraft() {} }, keyboard: null, sessionId: 's1', t: echoT })
  const btn = findButton(instance.tree)
  assert.equal(btn.props['data-tip'], '语义增强')
  assert.equal(btn.props['aria-label'], '语义增强')
})

test('草稿被手动编辑后回到空闲文案（不再显示恢复原文）', async () => {
  const mini = createMiniReact()
  let resolveFetch
  const fetchImpl = () => new Promise((resolve) => { resolveFetch = () => resolve({ ok: true, json: async () => ({ success: true, text: 'B' }) }) })
  const { module } = loadClient(mini.React, fetchImpl)
  const { ctx, captured } = makeSlotsCtx(undefined)
  module.apply(ctx)
  const Component = captured.registered[0].Component
  const state = { draft: 'A' }
  const inputActions = { setDraft(text) { state.draft = text } }
  const props = { useInput: (sel) => sel(state), inputActions, keyboard: null, sessionId: 's1' }
  const instance = mini.mount(Component, props)
  findButton(instance.tree).props.onClick()
  await flush()
  resolveFetch()
  await flush()
  await flush()
  assert.equal(findButton(instance.tree).props['data-semantic-copilot'], 'done')
  // 用户手动编辑草稿 → draft 不再等于 enhanced。
  state.draft = 'B 被用户改过'
  mini.rerender(instance, { ...props })
  assert.equal(findButton(instance.tree).props['data-semantic-copilot'], 'done')
  assert.equal(findButton(instance.tree).props['aria-label'], '语义增强')
})

test('回归：会话切换后响应不污染新会话草稿', async () => {
  const mini = createMiniReact()
  let resolveFetch
  const fetchImpl = () => new Promise((resolve) => { resolveFetch = () => resolve({ ok: true, json: async () => ({ success: true, text: 'A-ENHANCED' }) }) })
  const { module } = loadClient(mini.React, fetchImpl)
  const { ctx, captured } = makeSlotsCtx(undefined)
  module.apply(ctx)
  const Component = captured.registered[0].Component
  const setDraftCalls = []
  const state = { draft: 'B-draft' } // 已切到会话 B
  const inputActions = { setDraft(text) { setDraftCalls.push(text); state.draft = text } }
  const props = { useInput: (sel) => sel(state), inputActions, keyboard: null, sessionId: 's2' }
  const instance = mini.mount(Component, props)
  // 请求实际是在会话 A 发起的：先回到 A 的状态再点击。
  props.sessionId = 's1'
  state.draft = 'A-draft'
  mini.rerender(instance, props)
  findButton(instance.tree).props.onClick()
  await flush()
  // 响应未到时用户切回会话 B。
  props.sessionId = 's2'
  state.draft = 'B-draft'
  mini.rerender(instance, props)
  resolveFetch()
  await flush()
  await flush()
  // 响应被丢弃：B 的草稿未被覆盖，也不会进入 done 态。
  assert.deepEqual(setDraftCalls, [])
  assert.equal(findButton(instance.tree).props['data-semantic-copilot'], 'idle')
})

test('回归：还原路径 setDraft 抛错进入 error 态而不冒泡', async () => {
  const mini = createMiniReact()
  let resolveFetch
  const fetchImpl = () => new Promise((resolve) => { resolveFetch = () => resolve({ ok: true, json: async () => ({ success: true, text: 'B' }) }) })
  const { module } = loadClient(mini.React, fetchImpl)
  const { ctx, captured } = makeSlotsCtx(undefined)
  module.apply(ctx)
  const Component = captured.registered[0].Component
  const state = { draft: 'A' }
  let throwing = false
  const inputActions = {
    setDraft(text) {
      if (throwing) throw new Error('composer exploded on restore')
      state.draft = text
    },
  }
  const props = { useInput: (sel) => sel(state), inputActions, keyboard: null, sessionId: 's1' }
  const instance = mini.mount(Component, props)
  findButton(instance.tree).props.onClick()
  await flush()
  resolveFetch()
  await flush()
  await flush()
  assert.equal(findButton(instance.tree).props['data-semantic-copilot'], 'done')

  throwing = true
  // 不应抛出。
  findButton(instance.tree).props.onClick()
  await flush()
  const button = findButton(instance.tree)
  assert.equal(button.props['data-semantic-copilot'], 'error')
  assert.equal(button.props['data-tip'], '增强失败：composer exploded on restore')
  // 草稿未被破坏。
  assert.equal(state.draft, 'B')
})

test('回归：watchdog 超时（abort 且仍是当前请求）进入 error 态', async () => {
  const mini = createMiniReact()
  // 把 90s watchdog 压缩到 10ms，走真实定时器路径。
  const fetchImpl = (_url, init) =>
    new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')))
    })
  const { module } = loadClient(mini.React, fetchImpl, undefined, { timerScale: 1 / 9000 })
  const { ctx, captured } = makeSlotsCtx(undefined)
  module.apply(ctx)
  const Component = captured.registered[0].Component
  const state = { draft: 'A' }
  const props = { useInput: (sel) => sel(state), inputActions: { setDraft() {} }, keyboard: null, sessionId: 's1' }
  const instance = mini.mount(Component, props)
  findButton(instance.tree).props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 50))
  await flush()
  const button = findButton(instance.tree)
  assert.equal(button.props['data-semantic-copilot'], 'error')
  assert.equal(button.props['data-tip'], '增强失败：Request timed out')
})

test('回归：卸载触发的 abort 不产生异常', async () => {
  const mini = createMiniReact()
  const signals = []
  const fetchImpl = (_url, init) => {
    signals.push(init.signal)
    return new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')))
    })
  }
  // 压缩 watchdog，避免挂起的 90s 定时器拖住测试进程。
  const { module } = loadClient(mini.React, fetchImpl, undefined, { timerScale: 1 / 9000 })
  const { ctx, captured } = makeSlotsCtx(undefined)
  module.apply(ctx)
  const Component = captured.registered[0].Component
  const state = { draft: 'A' }
  const props = { useInput: (sel) => sel(state), inputActions: { setDraft() {} }, keyboard: null, sessionId: 's1' }
  const instance = mini.mount(Component, props)
  findButton(instance.tree).props.onClick()
  await flush()
  mini.unmount(instance)
  const snapshot = JSON.stringify(instance.hooks.map((slot) => slot && slot.value))
  await flush()
  await flush()
  // 卸载后不抛异常，且 catch 不再对已卸载组件写状态（controllerRef 已被清空）。
  assert.equal(JSON.stringify(instance.hooks.map((slot) => slot && slot.value)), snapshot)
})

test('回归：插件重载时 locale 注册被释放后重注册成功', () => {
  const mini = createMiniReact()
  // 模拟 locale 服务：重名注册抛错（dsh-client-locale 语义）。
  let registered = new Map()
  const disposers = []
  const locale = {
    register: (ns, lang, table) => {
      const key = ns + '/' + lang
      if (registered.has(key)) throw new Error('locale ' + key + ' already registered')
      registered.set(key, table)
      disposers.push(() => registered.delete(key))
      return () => registered.delete(key)
    },
    bind: () => (key) => key,
  }
  const effects = []
  const makeCtx = () => ({
    get: (name) => (name === 'locale' ? locale : undefined),
    slots: {
      inject(name, register) {},
      register: (meta, Component) => ({ meta, Component }),
    },
    effect: (fn) => {
      // cordis 语义：effect 返回的 disposer 在 fiber 卸载时执行。
      const dispose = fn()
      if (typeof dispose === 'function') effects.push(dispose)
    },
  })

  const { module } = loadClient(mini.React, () => { throw new Error('no fetch') })
  const ctx1 = makeCtx()
  module.apply(ctx1)
  assert.equal(registered.size, 2)

  // 模拟重载：先卸载（fiber 清理），再 apply。
  for (const dispose of effects.splice(0)) dispose()
  assert.equal(registered.size, 0, '卸载后注册应被释放')

  const ctx2 = makeCtx()
  assert.doesNotThrow(() => module.apply(ctx2), '重载后重注册不应抛 already registered')
  assert.equal(registered.size, 2)
})

test('回归：忽略 props.t，始终以闭包 translator 为准（语言切换实时生效）', () => {
  const mini = createMiniReact()
  const { module } = loadClient(mini.React, () => { throw new Error('no fetch') })
  const { ctx, captured } = makeSlotsCtx(undefined)
  module.apply(ctx)
  const Component = captured.registered[0].Component
  const state = { draft: 'A' }
  const props = {
    useInput: (sel) => sel(state),
    inputActions: { setDraft() {} },
    keyboard: null,
    sessionId: 's1',
    // 宿主即便透传 t，也必须被忽略：否则未知键会以 `?? key` 原样回显成键名。
    t: (key) => key,
  }
  const instance = mini.mount(Component, props)
  assert.equal(findButton(instance.tree).props['aria-label'], '语义增强')
})

test('回归：运行时切换语言，闭包 translator 立即生效', () => {
  const mini = createMiniReact()
  // 可变语言：bind 返回的函数每次调用都读取当前语言，模拟宿主 locale 的实时切换。
  let lang = 'zh'
  const locale = {
    register() {},
    bind: () => (key) => (lang === 'en' && key === 'enhance' ? 'Enhance' : key),
  }
  const { module } = loadClient(mini.React, () => { throw new Error('no fetch') })
  const { ctx, captured } = makeSlotsCtx(locale)
  module.apply(ctx)
  const Component = captured.registered[0].Component
  const state = { draft: 'A' }
  const props = { useInput: (sel) => sel(state), inputActions: { setDraft() {} }, keyboard: null, sessionId: 's1' }
  const instance = mini.mount(Component, props)
  assert.equal(findButton(instance.tree).props['aria-label'], '语义增强')
  lang = 'en'
  mini.rerender(instance, { ...props })
  assert.equal(findButton(instance.tree).props['aria-label'], 'Enhance')
})

test('回归：状态与图标映射（idle/busy/done/error）', async () => {
  const mini = createMiniReact()
  let resolveFetch
  const fetchImpl = () => new Promise((resolve) => { resolveFetch = () => resolve({ ok: true, json: async () => ({ success: true, text: 'B' }) }) })
  const { module } = loadClient(mini.React, fetchImpl)
  const { ctx, captured } = makeSlotsCtx(undefined)
  module.apply(ctx)
  const Component = captured.registered[0].Component
  const state = { draft: 'A' }
  const inputActions = { setDraft(text) { state.draft = text } }
  const props = { useInput: (sel) => sel(state), inputActions, keyboard: null, sessionId: 's1' }
  const instance = mini.mount(Component, props)

  const iconOf = (btn) => btn.props.children // 唯一子元素即图标 vnode
  const kindOf = (vnode) => vnode && vnode.type && (vnode.type.name || vnode.type.toString().slice(0, 30))

  // idle：Sparkle
  const idleIcon = iconOf(findButton(instance.tree))
  assert.equal(typeof idleIcon.type, 'function')
  // busy：Busy（旋转弧）
  findButton(instance.tree).props.onClick()
  await flush()
  const busyIcon = iconOf(findButton(instance.tree))
  assert.notEqual(busyIcon, idleIcon)
  // done：Revert
  resolveFetch()
  await flush()
  await flush()
  const revertIcon = iconOf(findButton(instance.tree))
  assert.notEqual(revertIcon, busyIcon)
  // done 后气泡文案切换为撤销动作说明
  assert.equal(findButton(instance.tree).props['data-tip'], '撤销语义增强')
})

test('回归：纯图标按钮无文字残留', async () => {
  const mini = createMiniReact()
  const { module } = loadClient(mini.React, () => { throw new Error('no fetch') })
  const { ctx, captured } = makeSlotsCtx(undefined)
  module.apply(ctx)
  const Component = captured.registered[0].Component
  const state = { draft: 'A' }
  const instance = mini.mount(Component, { useInput: (sel) => sel(state), inputActions: { setDraft() {} }, keyboard: null, sessionId: 's1' })
  const btn = findButton(instance.tree)
  // 唯一子元素是图标组件（内部渲染 svg），无文本 span。
  assert.equal(typeof btn.props.children.type, 'function')
  assert.equal(btn.props['aria-label'], '语义增强')
  // 原生 title 已移除（改用自绘气泡），改为 data-tip 承载文案，不再触发浏览器原生提示。
  assert.equal(btn.props.title, undefined)
  assert.equal(typeof btn.props['data-tip'], 'string')
  // 中心轴对齐：inline baseline 会下沉，必须显式 middle/center。
  assert.equal(btn.props.style.verticalAlign, 'middle')
  assert.equal(btn.props.style.alignSelf, 'center')
})



test('回归：增强中为彩色 loading（双环 + 品牌色转弧 + 旋转动画）', async () => {
  const mini = createMiniReact()
  const fetchImpl = () => new Promise(() => {})
  // watchdog 压缩到 10ms 防挂进程；断言在 watchdog 触发前完成。
  const { module } = loadClient(mini.React, fetchImpl, undefined, { timerScale: 1 / 9000 })
  const { ctx, captured } = makeSlotsCtx(undefined)
  module.apply(ctx)
  const Component = captured.registered[0].Component
  const state = { draft: 'A' }
  const props = { useInput: (sel) => sel(state), inputActions: { setDraft() {} }, keyboard: null, sessionId: 's1' }
  const instance = mini.mount(Component, props)
  findButton(instance.tree).props.onClick()
  await flush()
  const busyIcon = findButton(instance.tree).props.children
  assert.equal(typeof busyIcon.type, 'function') // IconBusy 组件
  // 直接调用组件函数拿 svg vnode（mini shim 不执行组件渲染）。
  const svgVnode = busyIcon.type()
  assert.equal(svgVnode.type, 'svg')
  const svgChildren = svgVnode.props.children
  assert.equal(Array.isArray(svgChildren), true)
  assert.equal(svgChildren.length, 2)
  const [ring, arc] = svgChildren
  assert.equal(ring.type, 'circle')
  assert.equal(ring.props.stroke, 'var(--dsw-alias-border-l1)')
  assert.equal(arc.type, 'path')
  assert.equal(arc.props.stroke, 'var(--dsw-alias-brand-primary)')
  assert.match(arc.props.style.animation, /dsh-semantic-copilot-spin/)
  assert.equal(findButton(instance.tree).props.style.opacity, 1)
  assert.equal(findButton(instance.tree).props['aria-label'], '正在增强草稿…')
  // 立即收尾：中止请求，避免挂起 timer 拖住进程。
  mini.unmount(instance)
  await flush()
})

test('回归：悬浮态圆角与底色对齐宿主 standardControls 控件', async () => {
  const mini = createMiniReact()
  const { module } = loadClient(mini.React, () => { throw new Error('no fetch') })
  const { ctx, captured } = makeSlotsCtx(undefined)
  module.apply(ctx)
  const Component = captured.registered[0].Component
  const state = { draft: 'A' }
  const instance = mini.mount(Component, {
    useInput: (sel) => sel(state),
    inputActions: { setDraft() {} },
    keyboard: null,
    sessionId: 's1',
  })

  // 静止态：圆角与相邻 select 统一（--dsw-radius-sm = 8px），底色透明、次级文字色。
  const idle = findButton(instance.tree)
  assert.equal(idle.props.style.borderRadius, 'var(--dsw-radius-sm)')
  assert.equal(idle.props.style.background, 'transparent')
  assert.equal(idle.props.style.color, 'var(--dsw-alias-label-secondary)')

  // 悬浮态：叠加底色 + 提亮到主标签色（宿主 standardControls 兄弟控件口径）。
  idle.props.onMouseEnter()
  await flush()
  const hovered = findButton(instance.tree)
  assert.equal(hovered.props.style.background, 'var(--dsw-alias-interactive-bg-hover)')
  assert.equal(hovered.props.style.color, 'var(--dsw-alias-label-primary)')

  // 移出后完全恢复静止态。
  hovered.props.onMouseLeave()
  await flush()
  const rested = findButton(instance.tree)
  assert.equal(rested.props.style.background, 'transparent')
  assert.equal(rested.props.style.color, 'var(--dsw-alias-label-secondary)')
})


// ---------------------------------------------------------------------------
// t12：语义增强按钮 tooltip（宿主原生气泡样式，随 canRevert 切换文案）
// ---------------------------------------------------------------------------

// 最小 document stub：只覆盖 ensureTipStyle/ensureSpinStyle 用到的接口，
// 记录注入到 head 的 <style> 节点，供样式契约断言。
function makeDocumentStub() {
  const headChildren = []
  const byId = new Map()
  const documentImpl = {
    documentElement: { lang: 'zh-CN' },
    head: {
      appendChild(node) {
        headChildren.push(node)
        if (node.id) byId.set(node.id, node)
        return node
      },
    },
    getElementById(id) {
      return byId.get(id) ?? null
    },
    createElement(tag) {
      return { tag, id: '', textContent: '' }
    },
  }
  return { documentImpl, headChildren, byId }
}

test('t12：tooltip 文案随 canRevert 在两态间切换（语义增强 / 撤销语义增强）', async () => {
  const mini = createMiniReact()
  const fetchImpl = () => Promise.resolve({ ok: true, json: async () => ({ success: true, text: 'B' }) })
  const { module } = loadClient(mini.React, fetchImpl)
  const { ctx, captured } = makeSlotsCtx(undefined)
  module.apply(ctx)
  const Component = captured.registered[0].Component
  const state = { draft: 'A' }
  // setDraft 必须真正写回草稿：canRevert 依赖 draft===enhanced，否则撤销态永远不成立。
  const inputActions = { setDraft(text) { state.draft = text } }
  const props = { useInput: (sel) => sel(state), inputActions, keyboard: null, sessionId: 's1' }
  const instance = mini.mount(Component, props)

  // 默认态：气泡文案为「语义增强」。
  assert.equal(findButton(instance.tree).props['data-tip'], '语义增强')

  // 触发增强 → 进入 done（canRevert=true）：同一 tooltip 切换为「撤销语义增强」。
  findButton(instance.tree).props.onClick()
  await flush()
  const btn = findButton(instance.tree)
  assert.equal(btn.props['data-semantic-copilot'], 'done')
  assert.equal(btn.props['data-tip'], '撤销语义增强')

  // 撤销后回到 idle：文案再次切回「语义增强」。
  btn.props.onClick()
  await flush()
  const back = findButton(instance.tree)
  assert.equal(back.props['data-semantic-copilot'], 'idle')
  assert.equal(back.props['data-tip'], '语义增强')
})

test('t12：ensureTipStyle 注入宿主原生 Tooltip 外观且无宿主哈希类/包引用', () => {
  const mini = createMiniReact()
  const { documentImpl, headChildren, byId } = makeDocumentStub()
  const { module } = loadClient(mini.React, () => { throw new Error('no fetch') }, undefined, { documentImpl })
  const { ctx } = makeSlotsCtx(undefined)

  // apply 时应注入气泡样式（幂等：重复 apply 不重复追加）。
  module.apply(ctx)
  module.apply(ctx)

  const style = byId.get('dsh-semantic-copilot-tip-style')
  assert.ok(style, '应注入 id 为 dsh-semantic-copilot-tip-style 的样式节点')
  assert.equal(headChildren.filter((n) => n.id === 'dsh-semantic-copilot-tip-style').length, 1)

  const css = style.textContent
  // 类名与宿主原生 Tooltip 令牌：底色 / 文字色 / 圆角 / 内边距。
  assert.match(css, /\.dsh-semantic-copilot-tip\{/)
  assert.match(css, /background:var\(--dsw-alias-tooltip-bg\)/)
  assert.match(css, /color:var\(--dsw-static-neutral-bluish-00\)/)
  assert.match(css, /border-radius:var\(--dsw-radius-sm\)/)
  assert.match(css, /padding:3px 7px/)
  // 降低动效偏好的降级。
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)\{\.dsh-semantic-copilot-tip\{animation:none\}\}/)
  // 不与宿主实现耦合：不得出现宿主哈希类名或直接引用宿主包。
  assert.doesNotMatch(css, /GRgSLq_/)
  assert.doesNotMatch(css, /@deepseek-ai\//)
})

test('t12：button 不再使用原生 title，aria-label 保留（无浏览器默认提示）', async () => {
  const mini = createMiniReact()
  const { module } = loadClient(mini.React, () => { throw new Error('no fetch') })
  const { ctx, captured } = makeSlotsCtx(undefined)
  module.apply(ctx)
  const Component = captured.registered[0].Component
  const state = { draft: 'A' }
  const props = { useInput: (sel) => sel(state), inputActions: { setDraft() {} }, keyboard: null, sessionId: 's1' }
  const instance = mini.mount(Component, props)

  const btn = findButton(instance.tree)
  assert.equal(btn.props.title, undefined, 'button 不应再设置原生 title')
  assert.equal(btn.props['aria-label'], '语义增强', 'aria-label 仍需保留可读文案')
  assert.equal(typeof btn.props['data-tip'], 'string', '计算后的气泡文案以 data-tip 暴露')
})

test('t12：气泡仅在 hover / focus 且非 disabled 时渲染，失焦/移出即隐藏', async () => {
  const mini = createMiniReact()
  const { module } = loadClient(mini.React, () => { throw new Error('no fetch') })
  const { ctx, captured } = makeSlotsCtx(undefined)
  module.apply(ctx)
  const Component = captured.registered[0].Component
  const state = { draft: 'A' }
  const props = { useInput: (sel) => sel(state), inputActions: { setDraft() {} }, keyboard: null, sessionId: 's1' }
  const instance = mini.mount(Component, props)

  // 初始（未交互）：无气泡。
  assert.equal(findTip(instance.tree), null)

  // 鼠标悬停：出现带 role=tooltip 与气泡类名的节点，文案为默认 tooltip。
  findButton(instance.tree).props.onMouseEnter()
  await flush()
  const hoverTip = findTip(instance.tree)
  assert.ok(hoverTip, 'hover 时应渲染气泡')
  assert.equal(hoverTip.props.role, 'tooltip')
  assert.match(hoverTip.props.className, /dsh-semantic-copilot-tip/)
  assert.equal(hoverTip.props.children, '语义增强')

  // 移出：气泡消失。
  findButton(instance.tree).props.onMouseLeave()
  await flush()
  assert.equal(findTip(instance.tree), null)

  // 键盘聚焦：同样展示气泡（纯键盘可访问性）。
  findButton(instance.tree).props.onFocus()
  await flush()
  assert.ok(findTip(instance.tree), 'focus 时应渲染气泡')
  findButton(instance.tree).props.onBlur()
  await flush()
  assert.equal(findTip(instance.tree), null)
})

