/**
 * dsh-semantic-copilot 的 Web 客户端：输入框右侧的「语义增强」按钮。
 *
 * 位置：slot `conversation.input.right`。该 slot 的渲染点正好落在
 * `div.standardControls` 之后、`div.activity` 之前，因此按钮稳定地夹在
 * 标准控件与活动区之间，不依赖任何哈希类名。
 *
 * 交互：
 *   空闲   → 点击：把当前草稿发给 Host 增强；成功后整段替换草稿并记住原文；
 *   已增强 → 草稿未被手动改动时按钮变为「恢复原文」，点击还原；
 *   失败   → 按钮变为「增强失败」，title 显示原因，再次点击重试。
 *
 * 与 Host 的唯一通道是同源 `POST /prompt-enhance`（见 index.js）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-semantic-copilot',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    const API = '/prompt-enhance'
    const SLOT = 'conversation.input.right'
    const NS = 'semantic-copilot'

    const ZH = {
      enhance: '语义增强',
      enhancing: '正在增强草稿…',
      revert: '恢复原文',
      failed: '增强失败',
      empty: '先输入内容再增强',
      hint: '语义增强：把当前草稿改写成更清晰具体的提示词',
      tooltipRevert: '恢复原文',
    }
    const EN = {
      enhance: 'Semantic enhance',
      enhancing: 'Enhancing draft…',
      revert: 'Restore original',
      failed: 'Enhance failed',
      empty: 'Type something first',
      hint: 'Semantic enhance: rewrite the current draft into a clearer, more specific prompt',
      tooltipRevert: 'Restore original',
    }

    /** 没有注入 useInput 时的兜底选择器：始终返回空草稿。 */
    const noInput = (selector) => selector({ draft: '' })


    // ---------- 图标（宿主约定：24 viewBox / stroke currentColor / round cap-join） ----------
    function icon(paths) {
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: 16,
          height: 16,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { display: 'block' },
        },
        paths.map((d) => h('path', { key: d, d })),
      )
    }
    // ✦ 语义增强：菱形星 + 小星（与「增强」语义绑定）
    const IconSparkle = () =>
      icon(['M12 4l1.7 4.3L18 10l-4.3 1.7L12 16l-1.7-4.3L6 10l4.3-1.7L12 4z', 'M18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7.7-1.8z'])
    // ↩ 恢复原文：回复箭头
    const IconRevert = () => icon(['M9 14L4 9l5-5', 'M4 9h10a6 6 0 0 1 6 6v0a6 6 0 0 1-6 6h-3'])
    // ⚠ 失败：三角警告
    const IconWarn = () => icon(['M12 3L2 20h20L12 3z', 'M12 9v5', 'M12 17.5v.5'])
    // 增强中：彩色 loading——暗底环（label-secondary 弱化）+ 品牌色转弧，双层描边。
    // 品牌色不继承 currentColor（busy 时按钮字色被弱化），直接取 brand 变量保证彩色观感。
    const IconBusy = () =>
      h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: 16,
          height: 16,
          fill: 'none',
          strokeWidth: 2.2,
          strokeLinecap: 'round',
          'aria-hidden': true,
          style: { display: 'block' },
        },
        h('circle', {
          cx: 12,
          cy: 12,
          r: 9,
          stroke: 'var(--dsw-alias-border-l1)',
        }),
        h('path', {
          d: 'M21 12a9 9 0 0 0-9-9',
          stroke: 'var(--dsw-alias-brand-primary)',
          style: { animation: 'dsh-semantic-copilot-spin 0.9s linear infinite', transformOrigin: '12px 12px' },
        }),
      )


    /**
     * 取得本地化函数。
     *
     * 依次尝试 locale 服务的 register / bind；任何一步不可用都退回内置 ZH 表，
     * 保证按钮永远有可读文案，绝不因为缺少 locale 服务而渲染出键名。
     */
    function translator(ctx) {
      // locale 服务不可用/注册失败时的兜底：至少跟随宿主语言，英文用户不再固定看到中文。
      const guessEnglish = () => {
        try {
          const lang = typeof document !== 'undefined' ? document.documentElement?.lang : ''
          if (lang && !/^zh/i.test(lang)) return EN
        } catch {}
        return ZH
      }
      const fallback = (key) => guessEnglish()[key] ?? key
      try {
        const locale = ctx.get('locale')
        if (!locale) return fallback
        if (typeof locale.register === 'function') {
          // 注册挂到 fiber 上，且回调必须返回 disposer：register 返回的清理函数
          // 若被丢弃，重载时再次 register 会抛 "already has locale"，触发静默降级。
          const registerLocales = () => {
            const disposers = [locale.register(NS, 'zh', ZH), locale.register(NS, 'en', EN)]
            return () => {
              for (const dispose of disposers) {
                if (typeof dispose === 'function') dispose()
              }
            }
          }
          if (typeof ctx.effect === 'function') ctx.effect(registerLocales)
          else registerLocales()
        }
        if (typeof locale.bind !== 'function') return fallback
        const bound = locale.bind(NS)
        if (typeof bound !== 'function') return fallback
        return (key) => {
          const value = bound(key)
          return typeof value === 'string' && value !== '' && value !== key ? value : fallback(key)
        }
      } catch (error) {
        console.warn('[semantic-copilot] locale unavailable:', error)
        return fallback
      }
    }

    /**
     * 生成按钮组件。slot meta 已声明 `locale: NS`：kit 会在运行时切换语言时传新的 `t`，
     * 组件优先用 props.t；闭包 `t` 仅兜 kit 未提供的场景。
     */
    function makeEnhanceButton(t) {
      return function SemanticCopilotButton(props) {
        const useInput = typeof props.useInput === 'function' ? props.useInput : noInput
        const draft =
          useInput((state) => (state && typeof state.draft === 'string' ? state.draft : '')) || ''
        const inputActions = props.inputActions
        const sessionId = props.sessionId
        const tr = typeof props.t === 'function' ? props.t : t

        const [phase, setPhase] = useState('idle')
        const [original, setOriginal] = useState('')
        const [enhanced, setEnhanced] = useState('')
        const [error, setError] = useState('')
        const [hover, setHover] = useState(false)
        const controllerRef = useRef(null)
        // 请求发起时的会话 id：响应回来前若用户已切走，则丢弃响应，
        // 绝不把 A 会话的增强结果写进 B 会话的输入框。
        // 渲染期写 ref 在并发渲染下可能被丢弃的渲染触发，但写入幂等，
        // 最坏情况只是多丢弃一次响应（安全方向），故不放进 effect。
        const sessionRef = useRef(sessionId)
        sessionRef.current = sessionId

        // 切换会话时回到初始态，避免把上一个会话的原文带进来。
        useEffect(() => {
          setPhase('idle')
          setOriginal('')
          setEnhanced('')
          setError('')
        }, [sessionId])

        // 卸载时中止在途请求，避免回调落到已卸载组件上。
        // 清空 ref：AbortError 稍后落入 .catch 时，重试路径的守卫才能正确判定「非当前请求」。
        useEffect(
          () => () => {
            const controller = controllerRef.current
            if (controller) {
              controller.abort()
              if (controllerRef.current === controller) controllerRef.current = null
            }
          },
          [],
        )

        /** 写回草稿：该 slot 的 standard kit 只提供 inputActions.setDraft。 */
        const writeDraft = useCallback(
          (text) => {
            if (inputActions && typeof inputActions.setDraft === 'function') {
              inputActions.setDraft(text)
              return true
            }
            return false
          },
          [inputActions],
        )

        const busy = phase === 'running'
        const canRevert = phase === 'done' && enhanced !== '' && draft === enhanced
        const disabled = busy || (!canRevert && draft.trim() === '')

        const onClick = useCallback(() => {
          if (busy) return

          // 已增强且草稿未被改动：还原原文。setDraft 同样可能抛错，与成功路径保持
          // 一致的失败语义：进入 error 态并保留当前草稿，而不是让异常冒泡到事件层。
          if (canRevert) {
            let restored = false
            try {
              restored = writeDraft(original)
            } catch (error) {
              setError(error && error.message ? error.message : 'restore failed')
              setPhase('error')
              return
            }
            if (restored) {
              setPhase('idle')
              setError('')
            }
            return
          }

          const text = draft
          if (text.trim() === '') return

          const requestedSessionId = sessionRef.current
          const controller = new AbortController()
          controllerRef.current = controller
          setPhase('running')
          setError('')

          // Host 端自带 60s 超时；这里 90s 只是兜底 Host 完全失联的场景，
          // 避免按钮永远停留在「增强中…」。
          const watchdog = setTimeout(() => controller.abort(), 90_000)

          fetch(API, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text }),
            signal: controller.signal,
          })
            .then(async (response) => {
              // 会话已切换：丢弃响应。此时组件状态已被切会话的 effect 重置，
              // 任何写草稿的动作都会污染新会话。
              if (sessionRef.current !== requestedSessionId) return
              const data = await response.json().catch(() => ({}))
              if (sessionRef.current !== requestedSessionId) return
              if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`)
              if (!data || data.success !== true) {
                const failure = new Error((data && data.error) || 'enhance failed')
                failure.code = data && data.code
                throw failure
              }
              if (typeof data.text !== 'string' || data.text.trim() === '') {
                throw new Error('enhanced result is empty')
              }
              if (sessionRef.current !== requestedSessionId) return
              if (!writeDraft(data.text)) throw new Error('composer is not editable')
              setOriginal(text)
              setEnhanced(data.text)
              setPhase('done')
            })
            .catch((reason) => {
              // 切会话后的失败同样不打扰新会话。
              if (sessionRef.current !== requestedSessionId) return
              if (controller.signal.aborted) {
                // watchdog 超时：给出明确反馈；卸载/重试导致的 abort 不置状态。
                if (controllerRef.current === controller) {
                  setError('Request timed out')
                  setPhase('error')
                }
                return
              }
              setError(reason && reason.message ? reason.message : 'enhance failed')
              setPhase('error')
            })
            .finally(() => {
              clearTimeout(watchdog)
              if (controllerRef.current === controller) controllerRef.current = null
            })
        }, [busy, canRevert, draft, original, writeDraft])

        // 图标态：busy 旋弧 / 可恢复 ↩ / 失败 ⚠ / 默认 ✦。无文字标签，语义走 aria-label + title。
        const label = busy
          ? tr('enhancing')
          : canRevert
            ? tr('revert')
            : phase === 'error'
              ? tr('failed')
              : tr('enhance')
        // tooltip（原生 title，宿主惯例）：失败给原因，空草稿给引导，其余给当前动作说明。
        const title =
          phase === 'error' && error !== ''
            ? tr('failed') + '：' + error
            : disabled && !busy
              ? tr('empty')
              : phase === 'idle'
                ? tr('hint')
                : label

        return h(
          'button',
          {
            type: 'button',
            'data-semantic-copilot': phase,
            'aria-label': label,
            'aria-busy': busy ? 'true' : undefined,
            title,
            disabled,
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              // 与旁边控件中心轴对齐：inline 默认 baseline 会下沉，flex 父级则靠 alignSelf。
              verticalAlign: 'middle',
              alignSelf: 'center',
              boxSizing: 'border-box',
              width: 28,
              height: 28,
              padding: 0,
              border: 'none',
              borderRadius: 6,
              background: hover && !disabled ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
              color:
                phase === 'error'
                  ? 'var(--dsw-alias-state-error-primary)'
                  : canRevert || (hover && !disabled)
                    ? 'var(--dsw-alias-brand-primary)'
                    : 'var(--dsw-alias-label-secondary)',
              cursor: disabled ? 'default' : 'pointer',
              // busy 时保持全亮：彩色 loading 即视觉焦点，不再叠加弱化。
              opacity: disabled && !busy ? 0.45 : 1,
              transition: 'background .12s ease, color .12s ease',
            },
            onClick,
            onMouseEnter: () => setHover(true),
            onMouseLeave: () => setHover(false),
          },
          busy ? h(IconBusy) : canRevert ? h(IconRevert) : phase === 'error' ? h(IconWarn) : h(IconSparkle),
        )
      }
    }

    /** 注入图标动画的 keyframes（一次性；重复注入前先摘除旧节点，重载安全）。 */
    function ensureSpinStyle() {
      try {
        if (typeof document === 'undefined') return
        if (document.getElementById('dsh-semantic-copilot-style')) return
        const style = document.createElement('style')
        style.id = 'dsh-semantic-copilot-style'
        style.textContent =
          '@keyframes dsh-semantic-copilot-spin{to{transform:rotate(360deg)}}'
        document.head.appendChild(style)
      } catch (error) {
        console.warn('[semantic-copilot] style injection unavailable:', error)
      }
    }

    function apply(ctx) {
      ensureSpinStyle()
      const t = translator(ctx)
      const EnhanceButton = makeEnhanceButton(t)
      try {
        ctx.slots.inject(SLOT, () =>
          ctx.slots.register({ name: SLOT, id: 'semantic-copilot', order: 20, locale: NS }, EnhanceButton),
        )
      } catch (error) {
        console.warn('[semantic-copilot] composer button unavailable:', error)
      }
    }

    return { inject: ['slots'], apply }
  },
})
