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
