// LLM 转发配置（/v1/llm 与 /admin/llm 共用）。
// 本文件以 _ 开头，不会被 Pages Functions 当作路由。
//
// 配置存 db9 库 dsh-data 的 llm_config 表（key/value），admin 页在线改，
// 不需要动 EdgeOne 环境变量。模块级缓存 30s：读多写少，改完最多 30s 生效。

export const DEFAULT_MODEL = 'deepseek-flash'
export const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions'

const SQL_URL = 'https://api.db9.ai/customer/databases/toc6zdt4vd7j/sql'
const CACHE_TTL_MS = 30000

let cache = { at: 0, config: null }

function sql(env, query) {
  const token = env && env.DB9_TOKEN
  if (!token) return Promise.reject(new Error('DB9_TOKEN not configured'))
  return fetch((env && env.DB9_SQL_URL) || SQL_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ query }),
  }).then(async (res) => {
    const body = await res.json().catch(() => null)
    if (!res.ok || body?.error || body?.message) throw new Error(body?.error ?? body?.message ?? `HTTP ${res.status}`)
    return body
  })
}

const sq = (s) => String(s).replace(/'/g, "''")

const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS llm_config (
  key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`

// 读配置：返回 { api_key: {value, updatedAt}, model: {...}, client_key: {...} }；
// 存储不可用或表不存在时返回 null（调用方决定 503 还是引导去 /admin/llm）。
export async function loadConfig(env) {
  const now = Date.now()
  if (cache.config && now - cache.at < CACHE_TTL_MS) return cache.config
  try {
    await sql(env, CREATE_TABLE)
    const rows = (await sql(env, 'SELECT key, value, updated_at FROM llm_config')).rows ?? []
    const config = {}
    for (const r of rows) config[r[0]] = { value: r[1], updatedAt: r[2] }
    cache = { at: now, config }
    return config
  } catch {
    return null
  }
}

export function invalidateCache() {
  cache = { at: 0, config: null }
}

// upsert 配置项；value 为 null/undefined 的项跳过（保留原值，空表单字段不覆盖）。
export async function saveConfig(env, entries) {
  await sql(env, CREATE_TABLE)
  for (const [key, value] of Object.entries(entries)) {
    if (value == null) continue
    await sql(env, `INSERT INTO llm_config (key, value) VALUES ('${sq(key)}', '${sq(value)}')
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`)
  }
  invalidateCache()
}

// 调 DeepSeek chat completions。EdgeOne Pages 运行时的 AbortSignal 没有 .timeout()，
// 用 AbortController + setTimeout 手动包超时（abort 时 fetch reject AbortError）。
export async function postChat(apiKey, payload, timeoutMs) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    return await fetch(DEEPSEEK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    })
  } finally {
    clearTimeout(timer)
  }
}

// 调用记录：只存统计字段（模型/token 数/延迟/状态码/错误签名），绝不存消息内容——
// 隐私红线与 /v1/report 一致。写入 fire-and-forget：调用方不 await，不阻塞响应；
// 少量丢失不影响统计口径。90 天滚动清理（随每次写入顺带执行，表小代价可忽略）。
const CREATE_CALLS_TABLE = `CREATE TABLE IF NOT EXISTS llm_calls (
  id BIGSERIAL PRIMARY KEY,
  model TEXT NOT NULL DEFAULT 'unknown',
  upstream_status INT NOT NULL DEFAULT 0,
  ok BOOLEAN NOT NULL DEFAULT FALSE,
  prompt_tokens INT,
  completion_tokens INT,
  total_tokens INT,
  latency_ms INT NOT NULL DEFAULT 0,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now())`

const CREATE_CALLS_INDEX = `CREATE INDEX IF NOT EXISTS llm_calls_created_at_idx ON llm_calls (created_at DESC)`

export async function ensureCallsTable(env) {
  await sql(env, CREATE_CALLS_TABLE)
  await sql(env, CREATE_CALLS_INDEX)
}

// rec: {model, status, ok, promptTokens?, completionTokens?, totalTokens?, latencyMs, error?}
// status=0 表示网络失败/超时（没拿到 DeepSeek 响应）。
export function recordCall(env, rec) {
  const num = (v) => (Number.isFinite(v) ? String(Math.round(v)) : 'NULL')
  const str = (v) => (v ? `'${sq(String(v).slice(0, 128))}'` : 'NULL')
  const query = `INSERT INTO llm_calls
    (model, upstream_status, ok, prompt_tokens, completion_tokens, total_tokens, latency_ms, error)
    VALUES ('${sq(String(rec.model || 'unknown').slice(0, 128))}', ${num(rec.status)},
            ${rec.ok ? 'TRUE' : 'FALSE'}, ${num(rec.promptTokens)}, ${num(rec.completionTokens)},
            ${num(rec.totalTokens)}, ${num(rec.latencyMs)}, ${str(rec.error)})`
  return (async () => {
    await ensureCallsTable(env)
    await sql(env, query)
    await sql(env, "DELETE FROM llm_calls WHERE created_at < now() - interval '90 days'")
  })().catch(() => {})
}
