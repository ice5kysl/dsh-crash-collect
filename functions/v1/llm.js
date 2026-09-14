// POST /v1/llm — LLM 转发：调用方只带 client_key，真正的 DeepSeek key 由服务端持有。
//
// 鉴权：请求头 x-llm-key（或 body.key）必须等于 /admin/llm 里配置的 client_key——
// LLM 调用要花钱，绝不能像 /v1/report 那样裸奔。client_key 未配置时端点返回 503。
//
// 入参（JSON）：
//   messages: [{role: system|user|assistant, content: string}]   — OpenAI 风格
//   prompt:   string                                              — 简写，等价于单条 user 消息
//   model / temperature(0-2) / max_tokens(≤8192) 可选，缺省用 /admin/llm 里配置的模型
//
// 出参：DeepSeek chat completion 原文透传（非流式；stream 暂不支持）。
// 配置存 db9 llm_config 表（见 functions/_lib/llm.js），30s 缓存。

import { DEFAULT_MODEL, loadConfig, postChat, recordCall } from '../_lib/llm.js'

const MAX_BODY_BYTES = 131072
const MAX_MESSAGES = 100
const MAX_CONTENT_CHARS = 32768
const MAX_MAX_TOKENS = 8192
const UPSTREAM_TIMEOUT_MS = 120000

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=UTF-8',
      'access-control-allow-origin': '*',
      ...extraHeaders,
    },
  })
}

function buildMessages(body) {
  if (Array.isArray(body.messages)) {
    if (!body.messages.length || body.messages.length > MAX_MESSAGES) return null
    const msgs = []
    for (const m of body.messages) {
      if (!m || typeof m !== 'object') return null
      const role = String(m.role ?? '')
      const content = m.content
      if (!['system', 'user', 'assistant'].includes(role)) return null
      if (typeof content !== 'string' || !content.length || content.length > MAX_CONTENT_CHARS) return null
      msgs.push({ role, content })
    }
    return msgs
  }
  if (typeof body.prompt === 'string' && body.prompt.trim()) {
    return [{ role: 'user', content: body.prompt.slice(0, MAX_CONTENT_CHARS) }]
  }
  return null
}

export async function onRequestPost(context) {
  const { request, env } = context
  const len = Number(request.headers.get('content-length')) || 0
  if (len > MAX_BODY_BYTES) return json({ ok: false, error: 'body too large' }, 413)

  let body
  try {
    body = await request.json()
  } catch {
    return json({ ok: false, error: 'invalid json' }, 400)
  }
  if (!body || typeof body !== 'object') return json({ ok: false, error: 'invalid json' }, 400)
  if (body.stream) return json({ ok: false, error: 'stream not supported' }, 400)

  const config = await loadConfig(env)
  if (!config) return json({ ok: false, error: 'storage unavailable' }, 503)

  const apiKey = config.api_key?.value
  const clientKey = config.client_key?.value
  if (!apiKey) {
    return json({ ok: false, error: 'llm not configured, set api_key at /admin/llm' }, 503)
  }
  if (!clientKey) {
    return json({ ok: false, error: 'llm client_key not configured, set it at /admin/llm' }, 503)
  }

  const presented = request.headers.get('x-llm-key') || (typeof body.key === 'string' ? body.key : '')
  if (presented !== clientKey) return json({ ok: false, error: 'invalid client key' }, 401)

  const messages = buildMessages(body)
  if (!messages) return json({ ok: false, error: 'messages (or prompt) required' }, 400)

  const payload = {
    model: typeof body.model === 'string' && body.model.trim() ? body.model.trim() : (config.model?.value || DEFAULT_MODEL),
    messages,
  }
  if (body.temperature != null) {
    const t = Number(body.temperature)
    if (!Number.isFinite(t) || t < 0 || t > 2) return json({ ok: false, error: 'temperature must be 0-2' }, 400)
    payload.temperature = t
  }
  if (body.max_tokens != null) {
    const n = Number(body.max_tokens)
    if (!Number.isInteger(n) || n < 1 || n > MAX_MAX_TOKENS) {
      return json({ ok: false, error: `max_tokens must be 1-${MAX_MAX_TOKENS}` }, 400)
    }
    payload.max_tokens = n
  }

  const started = Date.now()
  let upstream
  try {
    upstream = await postChat(apiKey, payload, UPSTREAM_TIMEOUT_MS)
  } catch (err) {
    track(context, env, {
      model: payload.model, status: 0, ok: false, latencyMs: Date.now() - started,
      error: `network: ${String(err?.message ?? err).slice(0, 100)}`,
    })
    return json({ ok: false, error: `upstream unreachable: ${err?.message ?? err}` }, 502)
  }

  const latencyMs = Date.now() - started
  const text = await upstream.text()

  // 从响应体里抠 usage 统计（DeepSeek 返回 OpenAI 标准 usage 字段）；抠不到就只记状态。
  // 状态与响应体透传：DeepSeek 的 error JSON 对调用方排障有用（key 失效、限流、模型名错等）
  let usage = null
  let echoedModel = payload.model
  let errorSig = null
  try {
    const parsed = JSON.parse(text)
    usage = parsed.usage ?? null
    echoedModel = parsed.model ?? payload.model
    if (!upstream.ok) errorSig = `${upstream.status} ${parsed?.error?.code ?? ''}`.trim()
  } catch {
    if (!upstream.ok) errorSig = `HTTP ${upstream.status}`
  }
  track(context, env, {
    model: echoedModel, status: upstream.status, ok: upstream.ok, latencyMs,
    promptTokens: usage?.prompt_tokens, completionTokens: usage?.completion_tokens,
    totalTokens: usage?.total_tokens, error: errorSig,
  })

  return new Response(text, {
    status: upstream.status,
    headers: {
      'content-type': upstream.headers.get('content-type') ?? 'application/json; charset=UTF-8',
      'access-control-allow-origin': '*',
      'x-llm-latency-ms': String(latencyMs),
    },
  })
}

// 记录调用：fire-and-forget，绝不让统计写入拖慢响应。运行时支持 ctx.waitUntil
// 就挂上去（响应返回后保证执行完），否则纯后台跑，极端情况下丢少量行。
function track(context, env, rec) {
  const pending = recordCall(env, rec)
  if (typeof context.waitUntil === 'function') context.waitUntil(pending)
}

export function onRequestOptions() {
  return new Response(null, {
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'content-type, x-llm-key',
      'access-control-max-age': '86400',
    },
  })
}

export function onRequestGet() {
  return json({ ok: false, error: 'method not allowed, use POST' }, 405)
}

export function onRequest() {
  return json({ ok: false, error: 'method not allowed, use POST' }, 405)
}
