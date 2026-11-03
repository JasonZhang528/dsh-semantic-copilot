# dsh-semantic-copilot

DeepSeek Harness 输入框语义增强插件：在会话输入框右侧注入一枚「✦」图标按钮（纯图标 + 悬停提示），
把尚未发送的草稿交给**当前模型**改写为更清晰、更具体的提示词，一键整段替换原文；
再次点击「↩」图标即可还原。

功能对齐 WorkBuddy 输入框的「增强提示词」入口，模型与网络能力全部来自宿主，
本插件不代理流量、不持有任何 API Key、不引入新的运行时依赖。

## 安装

```bash
dsh plugin --profile <name> add dsh-semantic-copilot
```

或从 GitHub release 安装：

```bash
dsh plugin --profile <name> add github:<owner>/dsh-semantic-copilot
```

安装后重启 profile（或关闭再打开对应 bundle）生效。

## 使用

1. 在输入框写下草稿（任意语言）。
2. 悬停「✦」图标可查看功能提示；点击后图标变为彩色加载环（增强中），完成后草稿被替换。
3. 再次点击「↩」图标还原；手动编辑过草稿则按钮自动回到空闲态。
4. 失败时图标变为「⚠」，悬停可查看原因，再次点击重试。

按钮注册在 slot `conversation.input.right`，渲染位置位于 `standardControls`
与 `activity` 之间，多插件共存时按 `order: 20` 排列。按钮为 28×28 图标热区，
24×24 viewBox 线性描边图标（16px 渲染），悬停提示用原生 `title`，
与输入框既有图标风格一致；通过 `vertical-align: middle` + `align-self: center`
与相邻控件保持中心轴对齐。

## 工作方式

- **客户端**（`client.js`）：slot 按钮，通过同源 `POST /prompt-enhance` 调用 Host。
  会话切换重置状态，卸载时中止在途请求。
- **Host**（`index.js`）：
  - `enhance_prompt` 工具：Agent 可在对话中直接调用，参数 `text`（必填）、`model`（可选，`model-id` 或 `provider/model-id`）。
  - `POST /prompt-enhance` 路由：按钮专用，复用宿主 connection 层拒绝策略。
  - 两者共用同一套增强逻辑：`ctx.llm.stream()` 单次补全 + 超时/中止保护。

模型路由优先级：**参数 `model` > 插件配置 `provider/model` > 当前默认模型**。

响应信封：

```json
{ "success": true,  "text": "增强后的提示词" }
{ "success": false, "text": "", "code": "empty_input", "error": "Empty input" }
```

失败码：`empty_input`（空输入，不调用模型）、`llm_unavailable`（无 LLM 服务或无模型路由）、
`llm_error`（流错误 / 超时 / 中止 / 截断 / 空结果）、`payload_too_large`（请求体超过 256 KiB，按字节计，HTTP 413）、
`unauthorized`（宿主连接层返回 401）、`forbidden`（宿主连接层拒绝，HTTP 403）、
`bad_request`（非法 JSON，HTTP 400）、`unknown`。

## 配置

在 profile 的 bundle 配置中可覆盖：

```yaml
- id: dsh-semantic-copilot
  name: dsh-semantic-copilot
  config:
    provider: ""      # 可选，默认跟随当前模型
    model: ""         # 可选，默认跟随当前模型
    timeoutMs: 60000  # 单次补全超时（工具级上限 90000）
```

## 测试

```bash
npm test          # node --test（77 个用例：prompt 纯函数 / Host 行为与 HTTP 路由 / 客户端状态机）
```

## 许可

MIT，详见 [LICENSE](./LICENSE) 与 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
