import test from 'node:test'
import assert from 'node:assert/strict'

import { apply, name, inject } from '../index.js'

/**
 * 构造一个最小可用的假 ctx：
 *  - tools.register 收集注册项
 *  - get(name) 返回 llm / agentDefaultModel / connection / webServer
 *  - inject(names, fn) 立即以自身调用回调
 */
function makeCtx(options = {}) {
  const registered = { tools: [], routes: [] }
  const ctx = {
    // cordis 的 inject 回调里服务通过属性访问暴露。
    webServer: options.webServer,
    tools: {
      register(tool) {
        registered.tools.push(tool)
        return tool
      },
    },
    get(key) {
      if (key === 'llm') return options.llm
      if (key === 'agentDefaultModel') {
        return { currentSelection: () => options.selection }
      }
      // connection: null 模拟服务缺失；undefined 走默认放行守卫（测试挂具便利）。
      if (key === 'connection') return options.connection === null ? undefined : options.connection
      if (key === 'webServer') return options.webServer
      return undefined
    },
    inject(names, fn) {
      if (options.skipInject) return
      fn(ctx)
    },
  }
  return { ctx, registered }
}

/** 把若干文本片段包成合法的 async iterable 流。 */
function streamOf(...chunks) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

function textStream(text) {
  return streamOf({ type: 'text-delta', text }, { type: 'finish', reason: { kind: 'stop' } })
}

function captureTool(registered) {
  const tool = registered.tools.find((item) => item.name === 'enhance_prompt')
  assert.ok(tool, 'enhance_prompt 工具应已注册')
  return tool
}

test('导出 name / inject 契约', () => {
  assert.equal(name, 'dsh-semantic-copilot')
  assert.deepEqual(inject, ['tools'])
})

test('注册 enhance_prompt 工具且必填 text', () => {
  const { ctx, registered } = makeCtx({ selection: { provider: 'p', model: 'm' }, llm: { stream: () => textStream('x') } })
  apply(ctx, {})
  const tool = captureTool(registered)
  assert.deepEqual(tool.parameters.required, ['text'])
  assert.equal(tool.output.schema.required.join(','), 'success,text')
  assert.equal(typeof tool.execute, 'function')
})

test('空输入直接返回 empty_input，不调用模型', async () => {
  let called = 0
  const { ctx, registered } = makeCtx({
    selection: { provider: 'p', model: 'm' },
    llm: { stream: () => { called += 1; return textStream('x') } },
  })
  apply(ctx, {})
  const tool = captureTool(registered)
  for (const value of ['', '   ', '\n\t ', undefined, null, 42]) {
    const out = await tool.execute({ text: value }, {})
    assert.equal(out.success, false)
    assert.equal(out.code, 'empty_input')
    assert.equal(out.text, '')
  }
  assert.equal(called, 0)
})

test('缺少 llm 服务时返回 llm_unavailable', async () => {
  const { ctx, registered } = makeCtx({ selection: { provider: 'p', model: 'm' } })
  apply(ctx, {})
  const out = await captureTool(registered).execute({ text: 'hi' }, {})
  assert.equal(out.success, false)
  assert.equal(out.code, 'llm_unavailable')
})

test('llm 存在但没有 stream 方法时返回 llm_unavailable', async () => {
  const { ctx, registered } = makeCtx({ selection: { provider: 'p', model: 'm' }, llm: {} })
  apply(ctx, {})
  const out = await captureTool(registered).execute({ text: 'hi' }, {})
  assert.equal(out.code, 'llm_unavailable')
})

test('没有可用模型路由时返回 llm_unavailable', async () => {
  const { ctx, registered } = makeCtx({ llm: { stream: () => textStream('x') } })
  apply(ctx, {})
  const out = await captureTool(registered).execute({ text: 'hi' }, {})
  assert.equal(out.code, 'llm_unavailable')
})

test('成功路径：使用默认模型并把文本回传', async () => {
  const seen = []
  const { ctx, registered } = makeCtx({
    selection: { provider: 'deepseek', model: 'chat' },
    llm: {
      stream(request) {
        seen.push(request)
        return textStream('  改写后的提示词  ')
      },
    },
  })
  apply(ctx, {})
  const out = await captureTool(registered).execute({ text: '原始草稿' }, {})
  assert.equal(out.success, true)
  assert.equal(out.text, '改写后的提示词')
  assert.equal(seen.length, 1)
  assert.equal(seen[0].provider, 'deepseek')
  assert.equal(seen[0].model, 'chat')
  assert.equal(seen[0].messages[0].role, 'user')
  assert.ok(seen[0].messages[0].content[0].text.includes('原始草稿'))
  assert.equal(typeof seen[0].system, 'string')
})

test('分段 text-delta 会被拼接', async () => {
  const { ctx, registered } = makeCtx({
    selection: { provider: 'p', model: 'm' },
    llm: { stream: () => streamOf({ type: 'text-delta', text: 'AB' }, { type: 'text-delta', text: 'CD' }, { type: 'finish', reason: { kind: 'stop' } }) },
  })
  apply(ctx, {})
  const out = await captureTool(registered).execute({ text: 'x' }, {})
  assert.equal(out.text, 'ABCD')
})

test('参数 model 覆盖路由，且支持 provider/model 形式', async () => {
  const seen = []
  const { ctx, registered } = makeCtx({
    selection: { provider: 'def', model: 'defm' },
    llm: { stream: (req) => { seen.push(req); return textStream('ok') } },
  })
  apply(ctx, {})
  const tool = captureTool(registered)
  await tool.execute({ text: 'x', model: 'openai/gpt-4o' }, {})
  assert.equal(seen[0].provider, 'openai')
  assert.equal(seen[0].model, 'gpt-4o')
  await tool.execute({ text: 'x', model: 'plain-id' }, {})
  assert.equal(seen[1].model, 'plain-id')
})

test('配置的 model 优先于默认模型', async () => {
  const seen = []
  const { ctx, registered } = makeCtx({
    selection: { provider: 'def', model: 'defm' },
    llm: { stream: (req) => { seen.push(req); return textStream('ok') } },
  })
  apply(ctx, { provider: 'cfg', model: 'cfg-model' })
  await captureTool(registered).execute({ text: 'x' }, {})
  assert.equal(seen[0].provider, 'cfg')
  assert.equal(seen[0].model, 'cfg-model')
})

test('流内错误帧映射为 llm_error（真实 failure 帧形状）', async () => {
  const { ctx, registered } = makeCtx({
    selection: { provider: 'p', model: 'm' },
    llm: { stream: () => streamOf({ type: 'finish', reason: { kind: 'error', failure: { message: 'boom', code: 'X' } } }) },
  })
  apply(ctx, {})
  const out = await captureTool(registered).execute({ text: 'x' }, {})
  assert.equal(out.success, false)
  assert.equal(out.code, 'llm_error')
  assert.match(out.error, /boom/)
})

test('流内错误帧兼容旧顶层 message 形状', async () => {
  const { ctx, registered } = makeCtx({
    selection: { provider: 'p', model: 'm' },
    llm: { stream: () => streamOf({ type: 'finish', reason: { kind: 'error', message: 'legacy boom' } }) },
  })
  apply(ctx, {})
  const out = await captureTool(registered).execute({ text: 'x' }, {})
  assert.equal(out.code, 'llm_error')
  assert.match(out.error, /legacy boom/)
})

test('模型返回空白时判 llm_error', async () => {
  const { ctx, registered } = makeCtx({
    selection: { provider: 'p', model: 'm' },
    llm: { stream: () => textStream('   ') },
  })
  apply(ctx, {})
  const out = await captureTool(registered).execute({ text: 'x' }, {})
  assert.equal(out.code, 'llm_error')
})

test('stream 抛异常时返回 unknown 且不冒泡', async () => {
  const { ctx, registered } = makeCtx({
    selection: { provider: 'p', model: 'm' },
    llm: { stream: () => { throw new Error('kaboom') } },
  })
  apply(ctx, {})
  const out = await captureTool(registered).execute({ text: 'x' }, {})
  assert.equal(out.success, false)
  assert.equal(out.code, 'unknown')
  assert.match(out.error, /kaboom/)
})

test('超时会被映射为带 timeoutMs 的 llm_error', async () => {
  const { ctx, registered } = makeCtx({
    selection: { provider: 'p', model: 'm' },
    llm: {
      stream: () => ({
        async *[Symbol.asyncIterator]() {
          await new Promise((resolve) => setTimeout(resolve, 200))
          yield { type: 'text-delta', text: 'late' }
        },
      }),
    },
  })
  apply(ctx, { timeoutMs: 20 })
  const out = await captureTool(registered).execute({ text: 'x' }, {})
  assert.equal(out.code, 'llm_error')
  assert.match(out.error, /timed out after 20ms/)
})

test('外部 signal 中止会停下并返回 llm_error', async () => {
  const controller = new AbortController()
  const { ctx, registered } = makeCtx({
    selection: { provider: 'p', model: 'm' },
    llm: {
      stream: (req) => ({
        async *[Symbol.asyncIterator]() {
          assert.equal(req.signal.aborted, false)
          controller.abort()
          await new Promise((resolve) => setTimeout(resolve, 10))
          yield { type: 'text-delta', text: 'x' }
        },
      }),
    },
  })
  apply(ctx, {})
  const out = await captureTool(registered).execute({ text: 'x' }, { signal: controller.signal })
  assert.equal(out.success, false)
  assert.equal(out.code, 'llm_error')
})

test('注册 webServer 路由', () => {
  const routes = []
  const { ctx } = makeCtx({
    selection: { provider: 'p', model: 'm' },
    llm: { stream: () => textStream('ok') },
    webServer: { register: (route) => routes.push(route) },
  })
  apply(ctx, {})
  assert.equal(routes.length, 1)
  assert.equal(routes[0].kind, 'exact')
  assert.equal(routes[0].path, '/prompt-enhance')
  assert.equal(typeof routes[0].handler, 'function')
})

test('webServer 缺失时静默跳过', () => {
  const { ctx } = makeCtx({ selection: { provider: 'p', model: 'm' }, llm: { stream: () => textStream('ok') } })
  assert.doesNotThrow(() => apply(ctx, {}))
})

// ---------------------------------------------------------------------------
// 路由层集成测试：真实 http server + fetch
// ---------------------------------------------------------------------------

import { createServer } from 'node:http'
import { once } from 'node:events'
import net from 'node:net'

/** 用假 webServer 捕获注册的路由，并把它挂到一个真实的 http server 上。 */
async function startServer(ctxOptions, config) {
  let route
  const { ctx } = makeCtx({
    // 正常路径测试默认放行；fail-closed 用例显式覆盖 connection。
    connection: { requestRejection: () => undefined },
    ...ctxOptions,
    webServer: {
      register(def) {
        route = def
      },
    },
  })
  apply(ctx, config ?? {})
  assert.ok(route, '路由应已注册')
  const server = createServer(route.handler)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const url = `http://127.0.0.1:${server.address().port}${route.path}`
  return { server, url, route }
}

test('POST 合法请求返回增强结果', async () => {
  const { server, url } = await startServer({
    selection: { provider: 'p', model: 'm' },
    llm: { stream: () => textStream('增强结果') },
  })
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '原始' }),
    })
    assert.equal(response.status, 200)
    const data = await response.json()
    assert.equal(data.success, true)
    assert.equal(data.text, '增强结果')
  } finally {
    server.close()
  }
})

test('GET 返回 405', async () => {
  const { server, url } = await startServer({
    selection: { provider: 'p', model: 'm' },
    llm: { stream: () => textStream('x') },
  })
  try {
    const response = await fetch(url)
    assert.equal(response.status, 405)
    assert.equal(response.headers.get('allow'), 'POST')
  } finally {
    server.close()
  }
})

test('非法 JSON 返回 400 bad_request', async () => {
  const { server, url } = await startServer({
    selection: { provider: 'p', model: 'm' },
    llm: { stream: () => textStream('x') },
  })
  try {
    const response = await fetch(url, { method: 'POST', body: '{not json' })
    assert.equal(response.status, 400)
    const data = await response.json()
    assert.equal(data.code, 'bad_request')
  } finally {
    server.close()
  }
})

test('空 text 返回 empty_input 而不是 5xx', async () => {
  const { server, url } = await startServer({
    selection: { provider: 'p', model: 'm' },
    llm: { stream: () => textStream('x') },
  })
  try {
    const response = await fetch(url, { method: 'POST', body: JSON.stringify({ text: '' }) })
    assert.equal(response.status, 200)
    const data = await response.json()
    assert.equal(data.code, 'empty_input')
  } finally {
    server.close()
  }
})

test('宿主连接层拒绝时返回其状态码', async () => {
  const { server, url } = await startServer({
    selection: { provider: 'p', model: 'm' },
    llm: { stream: () => textStream('x') },
    connection: { requestRejection: () => 403 },
  })
  try {
    const response = await fetch(url, { method: 'POST', body: JSON.stringify({ text: 'x' }) })
    assert.equal(response.status, 403)
    const data = await response.json()
    assert.equal(data.code, 'forbidden')
  } finally {
    server.close()
  }
})

test('宿主没有 connection 服务时 fail-closed 403（对齐官方）', async () => {
  const { server, url } = await startServer({
    selection: { provider: 'p', model: 'm' },
    llm: { stream: () => textStream('ok') },
    connection: null,
  })
  try {
    const response = await fetch(url, { method: 'POST', body: JSON.stringify({ text: 'x' }) })
    assert.equal(response.status, 403)
  } finally {
    server.close()
  }
})

test('connection 服务存在但没有守卫时 fail-closed 403', async () => {
  const { server, url } = await startServer({
    selection: { provider: 'p', model: 'm' },
    llm: { stream: () => textStream('ok') },
    connection: {},
  })
  try {
    const response = await fetch(url, { method: 'POST', body: JSON.stringify({ text: 'x' }) })
    assert.equal(response.status, 403)
  } finally {
    server.close()
  }
})

test('守卫抛错时 fail-closed 返回 403', async () => {
  const { server, url } = await startServer({
    selection: { provider: 'p', model: 'm' },
    llm: { stream: () => textStream('x') },
    connection: { requestRejection: () => { throw new Error('guard exploded') } },
  })
  try {
    const response = await fetch(url, { method: 'POST', body: JSON.stringify({ text: 'x' }) })
    assert.equal(response.status, 403)
  } finally {
    server.close()
  }
})
test('回归：截断流（无 finish 帧）判 llm_error', async () => {
  const { ctx, registered } = makeCtx({
    selection: { provider: 'p', model: 'm' },
    llm: { stream: () => streamOf({ type: 'text-delta', text: 'PARTIAL' }) },
  })
  apply(ctx, {})
  const out = await captureTool(registered).execute({ text: 'x' }, {})
  assert.equal(out.success, false)
  assert.equal(out.code, 'llm_error')
  assert.match(out.error, /finish/)
})

test('回归：预先 abort 的 signal 短路，不调用 llm', async () => {
  let called = 0
  const { ctx, registered } = makeCtx({
    selection: { provider: 'p', model: 'm' },
    llm: { stream: () => { called += 1; return textStream('x') } },
  })
  apply(ctx, {})
  const controller = new AbortController()
  controller.abort()
  const out = await captureTool(registered).execute({ text: 'x' }, { signal: controller.signal })
  assert.equal(out.success, false)
  assert.equal(out.code, 'llm_error')
  assert.equal(called, 0)
})

test('回归：finish aborted 帧判 llm_error（不再依赖外部 signal）', async () => {
  const { ctx, registered } = makeCtx({
    selection: { provider: 'p', model: 'm' },
    llm: { stream: () => streamOf({ type: 'text-delta', text: 'x' }, { type: 'finish', reason: { kind: 'aborted' } }) },
  })
  apply(ctx, {})
  const out = await captureTool(registered).execute({ text: 'x' }, {})
  assert.equal(out.code, 'llm_error')
  assert.match(out.error, /aborted/i)
})

test('回归：超限 body 返回 413 payload_too_large', async () => {
  const { server, url } = await startServer({
    selection: { provider: 'p', model: 'm' },
    llm: { stream: () => textStream('ok') },
  })
  try {
    const big = 'x'.repeat(256 * 1024 + 1)
    const response = await fetch(url, { method: 'POST', body: JSON.stringify({ text: big }) })
    assert.equal(response.status, 413)
    const data = await response.json()
    assert.equal(data.code, 'payload_too_large')
    assert.equal(data.success, false)
    // 边界值：按 chunk.length 字节计，这里留出 JSON 包装的字节余量
    const edge = 'x'.repeat(256 * 1024 - 64)
    const ok = await fetch(url, { method: 'POST', body: JSON.stringify({ text: edge }) })
    assert.equal(ok.status, 200)
  } finally {
    server.close()
  }
})

test('回归：BOM 前缀 JSON 正常解析', async () => {
  const { server, url } = await startServer({
    selection: { provider: 'p', model: 'm' },
    llm: { stream: () => textStream('ok') },
  })
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '\uFEFF{"text":"你好"}',
    })
    assert.equal(response.status, 200)
    const data = await response.json()
    assert.equal(data.success, true)
  } finally {
    server.close()
  }
})


test('回归：裸 model-id 回落默认模型的 provider', async () => {
  const seen = []
  const { ctx, registered } = makeCtx({
    selection: { provider: 'deepseek', model: 'chat' },
    llm: { stream: (req) => { seen.push(req); return textStream('ok') } },
  })
  apply(ctx, {})
  await captureTool(registered).execute({ text: 'x', model: 'plain-id' }, {})
  assert.equal(seen[0].provider, 'deepseek')
  assert.equal(seen[0].model, 'plain-id')
})

test('回归：裸 model-id 且无默认模型时不可路由', async () => {
  const { ctx, registered } = makeCtx({
    llm: { stream: () => textStream('ok') },
  })
  apply(ctx, {})
  const out = await captureTool(registered).execute({ text: 'x', model: 'plain-id' }, {})
  assert.equal(out.code, 'llm_unavailable')
})

test('回归：守卫返回 401 时 code 为 unauthorized', async () => {
  const { server, url } = await startServer({
    selection: { provider: 'p', model: 'm' },
    llm: { stream: () => textStream('x') },
    connection: { requestRejection: () => 401 },
  })
  try {
    const response = await fetch(url, { method: 'POST', body: JSON.stringify({ text: 'x' }) })
    assert.equal(response.status, 401)
    const data = await response.json()
    assert.equal(data.code, 'unauthorized')
  } finally {
    server.close()
  }
})

test('回归：成功路径使用真实 failure 帧形状不误伤', async () => {
  const { ctx, registered } = makeCtx({
    selection: { provider: 'p', model: 'm' },
    llm: {
      stream: () => streamOf({ type: 'text-delta', text: 'ok' }, { type: 'finish', reason: { kind: 'stop' } }),
    },
  })
  apply(ctx, {})
  const out = await captureTool(registered).execute({ text: 'x' }, {})
  assert.equal(out.success, true)
  assert.equal(out.text, 'ok')
})


test('回归：客户端断连取消 LLM 调用', async () => {
  let sawAbort = false
  const { server, url } = await startServer({
    selection: { provider: 'p', model: 'm' },
    llm: {
      stream: (req) => ({
        async *[Symbol.asyncIterator]() {
          // 等宿主断连触发 abort，或 3s 超时兜底。
          await new Promise((resolve) => {
            const timer = setTimeout(resolve, 3000)
            req.signal.addEventListener('abort', () => {
              sawAbort = true
              clearTimeout(timer)
              resolve()
            })
          })
          if (req.signal.aborted) return
          yield { type: 'text-delta', text: 'late' }
        },
      }),
    },
  })
  try {
    // 原始 socket 发出完整请求，稍等 handler 进入 llm 挂起后直接断开（无响应）。
    await new Promise((resolve, reject) => {
      const socket = net.connect(server.address().port, '127.0.0.1', () => {
        socket.write(
          'POST /prompt-enhance HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 14\r\n\r\n{"text":"abc"}',
        )
        setTimeout(() => {
          socket.destroy()
          resolve()
        }, 60)
      })
      socket.on('error', reject)
    })
    // 等断连传播到 llm 流。
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.equal(sawAbort, true)
  } finally {
    server.close()
  }
})
