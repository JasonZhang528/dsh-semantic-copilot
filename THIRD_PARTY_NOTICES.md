# THIRD PARTY NOTICES

## Design reference

The composer-button placement (`conversation.input.right`) and the general
"enhance the draft, then restore it" interaction pattern were studied from
publicly available DSH plugins, notably `dsh-prompt-enhance`.

No source code from those projects is copied. `prompt.js`, `index.js` and
`client.js` in this package are an independent implementation with its own
wording, structure and error handling.

## Upstream platform

This plugin runs inside DeepSeek Harness and uses only the host-provided
`slots`, `llm`, `tools` and `webServer` services. It bundles no third-party
runtime dependencies.
