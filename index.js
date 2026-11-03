/**
 * dsh-semantic-copilot — Host 侧。
 *
 * 职责：
 *  1. 注册 `enhance_prompt` 工具，供 Agent 在对话中主动调用；
 *  2. 注册 `POST /prompt-enhance` 路由，供输入框按钮（client.js）调用；
 *  3. 两条入口共用同一套「当前模型单次补全」逻辑：不代理、不持有任何 API Key，
 *     模型与网络能力全部来自宿主 ctx.llm。
 */

import { SYSTEM_PROMPT, buildUserPrompt, finalizeEnhanced } from './prompt.js'

export const name = 'dsh-semantic-copilot'

/** 本插件依赖的工具注册表；webServer 为可选依赖，用 ctx.inject 动态挂载。 */
export const inject = ['tools']

const DEFAULT_TIMEOUT_MS = 60_000
const TOOL_TIMEOUT_MS = 90_000
const ROUTE_PATH = '/prompt-enhance'
const MAX_BODY_CHARS = 256 * 1024
// 输出防线：系统提示已约束模型控制在 ~800 字符内，这里只兜「模型失控」的场景。
const MAX_OUTPUT_CHARS = 64 * 1024

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * opencode-go 路由的会话标识兜底。
 *
 * llm-pi-ai 适配器只有在 options.sessionId 存在时才会向 provider 包装器透传
 * sessionId，opencode-headers 的 withSessionHeader 据此注入 x-opencode-session
 * 请求头；缺失即被网关以 400 {"type":"MissingSessionID"} 拒绝。
 *
 * 两条入口都取不到真实会话标识时，回退到本模块级稳定标识：只惰性生成一次并
 * 持续复用（绝不每次请求新生成，否则每次都被当作新会话）。生成过程自身绝不抛异常。
 */
let fallbackSessionId
function stableFallbackSessionId() {
  if (fallbackSessionId === undefined) {
    try {
      const generated =
        typeof globalThis.crypto?.randomUUID === 'function'
          ? globalThis.crypto.randomUUID()
          : `dsh-semantic-copilot-${Date.now()}-${Math.random().toString(16).slice(2)}`
      fallbackSessionId = String(generated)
    } catch {
      fallbackSessionId = `dsh-semantic-copilot-${Date.now()}-${Math.random().toString(16).slice(2)}`
    }
  }
  return fallbackSessionId
}

/**
 * 解析本次请求要透传给 llm.stream 的 sessionId。
 *
 * 显式标识（工具路径的 exec.agent.id / 路由体里的 sessionId）优先；缺失或空白时
 * 回退到模块级稳定标识，保证 opencode-go 不再因缺头失败。
 */
function resolveSessionId(explicit) {
  const value = nonEmpty(typeof explicit === 'string' ? explicit : undefined)
  return value ?? stableFallbackSessionId()
}

function readOptions(config) {
  const source = config && typeof config === 'object' ? config : {}
  const timeoutMs = Number.isFinite(source.timeoutMs) && source.timeoutMs > 0 ? source.timeoutMs : DEFAULT_TIMEOUT_MS
  return {
    provider: nonEmpty(source.provider),
    model: nonEmpty(source.model),
    timeoutMs,
  }
}

/**
 * 解析本次调用使用哪条模型路由。
 *
 * 优先级：显式参数 `provider/model-id` > 显式参数 `model-id` > 插件配置 > 当前默认模型。
 * 参数里的 `provider/model-id` 按第一个斜杠切分，模型 id 自身可含斜杠。
 */
function resolveRoute(ctx, options, argModel) {
  const explicit = nonEmpty(argModel)
  if (explicit) {
    const slash = explicit.indexOf('/')
    if (slash > 0) {
      return { provider: explicit.slice(0, slash), model: explicit.slice(slash + 1) }
    }
    // 裸 model-id：provider 取插件配置；配置也没有时借当前默认模型的 provider，
    // 否则 {provider: undefined} 会让 llm.stream 必然失败。
    if (options.provider) return { provider: options.provider, model: explicit }
    const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
    const provider = nonEmpty(selection?.provider)
    return provider ? { provider, model: explicit } : undefined
  }
  if (options.model) {
    if (options.provider) return { provider: options.provider, model: options.model }
    // 只配置了 model 没配 provider：借当前默认模型的 provider，避免 {provider: undefined}。
    const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
    const provider = nonEmpty(selection?.provider)
    return provider ? { provider, model: options.model } : undefined
  }
  const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
  const provider = nonEmpty(selection?.provider)
  const model = nonEmpty(selection?.model)
  if (!provider || !model) return undefined
  return { provider, model }
}

function failure(code, error) {
  return { success: false, text: '', code, error }
}

/**
 * 收集流式补全的文本。
 *
 * 只累积 text-delta；finish 帧带错误/中止原因时记录下来，交给上层决定错误码。
 * 流对象缺失或没有异步迭代器时按失败处理，避免静默产出空串。
 */
async function collectText(stream) {
  if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
    return { text: '', failureMessage: 'LLM stream is not available', sawFinish: false }
  }
  let text = ''
  let failureMessage = ''
  let sawFinish = false
  for await (const chunk of stream) {
    if (!chunk || typeof chunk !== 'object') continue
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      text += chunk.text
      continue
    }
    if (chunk.type === 'finish') {
      sawFinish = true
      const kind = chunk.reason?.kind
      // 宿主 FinishReasonMap 的帧形如 {kind, failure:{message, code}}；
      // 兼容旧的顶层 message 字段。
      if (kind === 'error') {
        failureMessage = String(chunk.reason?.failure?.message ?? chunk.reason?.message ?? 'LLM request failed')
      } else if (kind === 'aborted') {
        failureMessage = String(chunk.reason?.failure?.message ?? chunk.reason?.message ?? 'Request aborted')
      }
    }
  }
  // 没有 finish 帧说明流被截断，部分文本不可信，按失败处理。
  if (!sawFinish && failureMessage === '') {
    failureMessage = 'LLM stream ended without a finish frame'
  }
  return { text, failureMessage }
}

function messageOf(error) {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

/**
 * 复用宿主连接层的拒绝策略（CSRF / 来源校验等）。
 *
 * 语义对齐官方插件（fail-closed）：
 *  - connection 服务不可得或守卫抛错 → 403；
 *  - 守卫返回数字 / {status} → 按该状态码拒绝；undefined/null/false → 放行。
 */
function rejectRequest(ctx, req) {
  let connection
  try {
    connection = ctx.get?.('connection')
  } catch {
    return 403
  }
  const guard = connection?.requestRejection
  if (typeof guard !== 'function') return 403
  try {
    const result = guard.call(connection, req)
    if (result === undefined || result === null || result === false) return undefined
    if (typeof result === 'number') return result
    if (typeof result === 'object' && Number.isFinite(result.status)) return result.status
    return 403
  } catch {
    return 403
  }
}

function readBody(req, res) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let bytes = 0
    let tooLarge = false
    req.on('data', (chunk) => {
      if (tooLarge) return
      bytes += chunk.length
      if (bytes > MAX_BODY_CHARS) {
        tooLarge = true
        // 先给客户端一个结构化的 413，再断开，避免对端只看到 connection reset。
        // destroy 延后到响应冲刷完成，不依赖「end 后立刻 destroy 仍能送达」的实现细节。
        try {
          sendJson(res, 413, { success: false, code: 'payload_too_large', error: `Request body exceeds ${MAX_BODY_CHARS} bytes` })
        } catch {
          // 头部已发出时无法再写状态码，只能照旧断开。
        }
        chunks.length = 0
        if (res.writableFinished) {
          req.destroy()
        } else {
          res.once('close', () => req.destroy())
        }
        reject(new Error('request body too large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function createRouteHandler(ctx, options, enhance) {
  return (req, res) => {
    void (async () => {
      const rejection = rejectRequest(ctx, req)
      if (rejection !== undefined) {
        sendJson(res, rejection, {
          success: false,
          code: rejection === 401 ? 'unauthorized' : 'forbidden',
          error: 'request rejected',
        })
        return
      }
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' })
        res.end()
        return
      }
      let payload
      try {
        const raw = await readBody(req, res)
        // 容忍 UTF-8 BOM：有些客户端会带上。
        payload = raw === '' ? {} : JSON.parse(raw.replace(/^\uFEFF/, ''))
      } catch (error) {
        // 413 已在 readBody 内直接应答；这里只兜真正的解析错误。
        if (res.writableEnded || res.destroyed) return
        sendJson(res, 400, { success: false, code: 'bad_request', error: messageOf(error) })
        return
      }
      const text = payload && typeof payload.text === 'string' ? payload.text : ''
      const model = payload && typeof payload.model === 'string' ? payload.model : undefined
      // 客户端在请求体里带上自己的会话标识；缺失时 enhance 内部回退稳定标识。
      const sessionId = payload && typeof payload.sessionId === 'string' ? payload.sessionId : undefined
      // 客户端断开时取消 LLM 调用（60s 上限仍兜底）。
      const disconnect = new AbortController()
      res.on('close', () => {
        if (!res.writableEnded) disconnect.abort()
      })
      const envelope = await enhance(text, model, disconnect.signal, sessionId)
      sendJson(res, 200, envelope)
    })().catch((error) => {
      // 不把内部错误细节回给客户端；具体原因交给宿主日志。
      // logger 是 Context 直挂属性（ctx.logger），get('logger') 仅作 facade 场景的兜底。
      try {
        const logger = ctx.logger ?? ctx.get('logger')
        logger?.warn?.('[dsh-semantic-copilot] route handler failed:', messageOf(error))
      } catch {}
      if (!res.headersSent) {
        sendJson(res, 500, { success: false, code: 'unknown', error: 'prompt enhancement failed' })
      } else {
        res.destroy()
      }
    })
  }
}

export function apply(ctx, config) {
  const options = readOptions(config)

  /**
   * 单次补全：把草稿改写为更强的提示词。
   * 所有失败都以 `{success:false, code, error}` 信封返回，不抛给调用方。
   */
  async function enhance(rawText, modelArg, signal, sessionIdArg) {
    const input = typeof rawText === 'string' ? rawText : ''
    // 空输入不发起模型调用。
    if (input.trim() === '') return failure('empty_input', 'Empty input')
    // 调用方已取消：不再触碰 LLM。
    if (signal?.aborted) return failure('llm_error', 'Request aborted')

    const llm = ctx.get('llm')
    if (!llm || typeof llm.stream !== 'function') {
      return failure('llm_unavailable', 'LLM service is not available')
    }

    const route = resolveRoute(ctx, options, modelArg)
    if (!route) {
      return failure('llm_unavailable', 'No model route is selected')
    }

    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, options.timeoutMs)
    const forwardAbort = () => controller.abort()
    signal?.addEventListener('abort', forwardAbort, { once: true })

    try {
      const stream = llm.stream({
        provider: route.provider,
        model: route.model,
        system: SYSTEM_PROMPT,
        messages: [
          { role: 'user', content: [{ type: 'text', text: buildUserPrompt(input) }] },
        ],
        signal: controller.signal,
        // opencode-go 路由依赖该字段注入 x-opencode-session；缺失即 400 MissingSessionID。
        sessionId: resolveSessionId(sessionIdArg),
      })
      const { text, failureMessage } = await collectText(stream)
      // 流可能不感知中止（或在收尾帧前被切断），这里做二次校验，
      // 保证「已超时/已中止」永远不会以 success 结尾。
      if (timedOut) return failure('llm_error', `Request timed out after ${options.timeoutMs}ms`)
      if (controller.signal.aborted) return failure('llm_error', 'Request aborted')
      if (failureMessage) return failure('llm_error', failureMessage)
      const final = finalizeEnhanced(text)
      if (!final.ok) return failure(final.code, final.error)
      if (final.text.length > MAX_OUTPUT_CHARS) {
        return failure('llm_error', `Enhanced result exceeds ${MAX_OUTPUT_CHARS} characters`)
      }
      return { success: true, text: final.text }
    } catch (error) {
      if (timedOut) return failure('llm_error', `Request timed out after ${options.timeoutMs}ms`)
      if (controller.signal.aborted) return failure('llm_error', 'Request aborted')
      return failure('unknown', messageOf(error) || 'prompt enhancement failed')
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', forwardAbort)
    }
  }

  // 注册失败只降级（工具不可用），绝不能把异常抛给宿主启动流程。
  try {
  ctx.tools.register({
    name: 'enhance_prompt',
    description:
      '把一段原始提示词改写为更清晰、更具体的提示词，并原样返回改写结果：保持输入语言，只产出提示词本身，不回答提示词里的请求。当用户要求增强/优化/润色提示词，或想把一句模糊需求整理成可直接发给模型的提示词时调用。',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description:
            '用户原始提示词，按用户写下的原样传入；不要预先改写，也不要用它代替本工具去回答原请求。空白输入直接返回 success=false（code=empty_input），不会调用模型。',
        },
        model: {
          type: 'string',
          description:
            '可选模型覆盖，写 `model-id` 或 `provider/model-id`；省略时依次使用插件配置与当前默认模型。',
        },
      },
      required: ['text'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          success: { type: 'boolean', description: '是否得到可用的增强结果。' },
          text: { type: 'string', description: '成功时是增强后的提示词；失败时为空串。' },
          code: {
            type: 'string',
            description:
              '失败码：empty_input / llm_unavailable / llm_error / payload_too_large / unauthorized / forbidden / bad_request / unknown。',
          },
          error: { type: 'string', description: '失败时的可读原因。' },
        },
        required: ['success', 'text'],
      },
      render: (_args, value) =>
        value?.success
          ? [{ type: 'text', text: value.text }]
          : [{ type: 'text', text: `[${value?.code ?? 'unknown'}] ${value?.error ?? 'prompt enhancement failed'}` }],
      presentationMeta: (_args, value) => ({
        success: value?.success === true,
        chars: typeof value?.text === 'string' ? value.text.length : 0,
        ...(value?.code ? { code: value.code } : {}),
      }),
    },
    presentCall: () => ({ card: 'generic', title: '增强提示词', kind: 'other', content: [] }),
    presentResult: (_args, { isError, meta }) => ({
      card: 'generic',
      title: isError || meta?.success !== true ? '增强提示词 · 失败' : '增强提示词 · 已改写',
      content: [],
    }),
    timeoutMs: TOOL_TIMEOUT_MS,
    async execute(args, exec) {
      const input = args && typeof args === 'object' ? args : {}
      // Agent 接口只暴露只读 id（SessionId）；取不到时 enhance 内部回退稳定标识。
      const sessionId = exec?.agent?.id
      return enhance(input.text, input.model, exec?.signal, sessionId)
    },
  })
  } catch (error) {
    ctx.logger?.warn?.('[dsh-semantic-copilot] tool registration failed:', messageOf(error))
  }

  // 路由注册同样降级处理：注册失败只意味着按钮不可用，不影响宿主启动。
  try {
  ctx.inject(['webServer'], (c) => {
    const server = c.webServer
    if (!server || typeof server.register !== 'function') return
    // register 返回的 disposer 必须挂在 cordis fiber 上：插件禁用/重载时先释放旧路由，
    // 否则重新注册会命中 duplicate exact route，插件加载失败。
    const registerRoute = () =>
      server.register({
        kind: 'exact',
        path: ROUTE_PATH,
        handler: createRouteHandler(ctx, options, enhance),
      })
    if (typeof c.effect === 'function') c.effect(registerRoute)
    // 防御分支：声明的 cordis ^4.0.4 上 effect 恒存在（已实测），此分支仅兜异常宿主；
    // 代价是该场景下重载时旧路由不释放（disposer 丢失）。
    else registerRoute()
  })
  } catch (error) {
    ctx.logger?.warn?.('[dsh-semantic-copilot] route registration failed:', messageOf(error))
  }
}
