import test from 'node:test'
import assert from 'node:assert/strict'

import {
  SYSTEM_PROMPT,
  USER_TEMPLATE,
  buildUserPrompt,
  stripWrappingQuotes,
  finalizeEnhanced,
  buildRequest,
} from '../prompt.js'

test('buildUserPrompt 原样嵌入用户输入', () => {
  const out = buildUserPrompt('给狗狗做一个网站')
  assert.ok(out.includes('给狗狗做一个网站'))
  assert.ok(!out.includes('{input}'))
})

test('buildUserPrompt 把替换模式字符按字面量保留', () => {
  // $& / $1 / 反引号前的美元符在 String.replace 的字符串替换里都有特殊含义。
  const tricky = "$& and $' and $` and $1 stay literal"
  const out = buildUserPrompt(tricky)
  assert.ok(out.includes(tricky))
})

test('buildUserPrompt 支持空串与多行输入', () => {
  assert.ok(buildUserPrompt('').includes('USER INPUT:'))
  const multi = 'line one\nline two'
  assert.ok(buildUserPrompt(multi).includes(multi))
})

test('stripWrappingQuotes 只剥成对包裹引号并 trim', () => {
  assert.equal(stripWrappingQuotes('  "hello"  '), 'hello')
  assert.equal(stripWrappingQuotes('""abc""'), '"abc"')
  assert.equal(stripWrappingQuotes('“中文引号”'), '中文引号')
  assert.equal(stripWrappingQuotes('‘单引号’'), '单引号')
  assert.equal(stripWrappingQuotes('plain'), 'plain')
})

test('stripWrappingQuotes 回归：Rename "foo" to "bar" 原样保留', () => {
  assert.equal(stripWrappingQuotes('Rename "foo" to "bar"'), 'Rename "foo" to "bar"')
})

test('stripWrappingQuotes 不破坏成对标点与单侧引号', () => {
  // 成对标点：首尾引号不属于同一对包裹。
  assert.equal(stripWrappingQuotes('Rename "foo" to "bar"'), 'Rename "foo" to "bar"')
  // 单侧引号：无配对，保留原样。
  assert.equal(stripWrappingQuotes('"abc'), '"abc')
  assert.equal(stripWrappingQuotes("it's"), "it's")
  assert.equal(stripWrappingQuotes('abc"'), 'abc"')
})

test('stripWrappingQuotes 容忍 null / undefined / 非字符串', () => {
  assert.equal(stripWrappingQuotes(null), '')
  assert.equal(stripWrappingQuotes(undefined), '')
  assert.equal(stripWrappingQuotes(42), '42')
})

test('finalizeEnhanced 空结果判失败', () => {
  for (const value of ['', '   ', '""', '\n\t']) {
    const out = finalizeEnhanced(value)
    assert.equal(out.ok, false)
    assert.equal(out.code, 'llm_error')
  }
})

test('finalizeEnhanced 正常结果原样返回且不截断', () => {
  const long = 'x'.repeat(4000)
  const out = finalizeEnhanced(long)
  assert.equal(out.ok, true)
  assert.equal(out.text, long)
})

test('finalizeEnhanced 去掉模型擅自加上的包裹引号', () => {
  const out = finalizeEnhanced('"请把这段代码重构为可测试的模块"')
  assert.equal(out.ok, true)
  assert.equal(out.text, '请把这段代码重构为可测试的模块')
})

test('SYSTEM_PROMPT 覆盖关键约束', () => {
  assert.match(SYSTEM_PROMPT, /LANGUAGE/i)
  assert.match(SYSTEM_PROMPT, /OUTPUT FORMAT/i)
  assert.ok(SYSTEM_PROMPT.length < 8000)
})

test('buildRequest 返回 system + user', () => {
  const req = buildRequest('hello')
  assert.equal(req.system, SYSTEM_PROMPT)
  assert.ok(req.user.includes('hello'))
  assert.equal(USER_TEMPLATE.includes('{input}'), true)
})
