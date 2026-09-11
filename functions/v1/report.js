// POST /v1/report — dsh-why 崩溃案例上报端点（opt-in，白名单脱敏）
//
// 存储：db9 (serverless Postgres)，经 SQL-over-HTTP API 写入。
// 环境变量：DB9_TOKEN（scoped API token）、DB9_SQL_URL（可选覆盖）。
//
// 隐私红线：只接收并存储下列白名单字段，其它字段一律拒绝。
// 绝不接收用户消息、工具参数、文件路径、prompt、IP。

const ALLOWED_CATEGORIES = new Set([
  'provider-auth', 'provider-quota', 'tool-cancelled', 'compaction-overflow',
  'attachment-quarantine', 'module-missing', 'profile-boot', 'other',
])

const RE_SIG = /^[a-z0-9_-]{4,128}$/
const RE_SEMVER = /^[0-9a-z.+-]{1,32}$/i
const RE_NPM_NAME = /^(@[a-z0-9._-]+\/)?[a-z0-9._-]{1,100}$/
const RE_CODE = /^[A-Za-z0-9_.:-]{1,64}$/

const DAILY_CAP = 20000
const MAX_BODY_BYTES = 16384
const DEFAULT_SQL_URL = 'https://api.db9.ai/customer/databases/toc6zdt4vd7j/sql'

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

// db9 SQL API 只接受整串 query；所有入库字段都过了上面的严格正则
// （不含引号、空格、反斜线），插值是安全的。turns 是整数。
async function sql(env, query) {
  const token = env && env.DB9_TOKEN
  if (!token) throw new Error('DB9_TOKEN not configured')
  const url = (env && env.DB9_SQL_URL) || DEFAULT_SQL_URL
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ query }),
  })
  const body = await res.json().catch(() => null)
  if (!res.ok || body?.error || body?.message) {
    throw new Error(body?.error ?? body?.message ?? `HTTP ${res.status}`)
  }
  return body
}

function cleanString(v, re) {
  return typeof v === 'string' && re.test(v) ? v : null
}

const ALLOWED_KEYS = new Set(['v', 'sig', 'category', 'shell', 'plugin', 'plugin_ver', 'code', 'turns'])

// 服务端再脱敏：只保留白名单字段，任何不合规字段使整个请求被拒
function sanitize(body) {
  if (!body || typeof body !== 'object' || body.v !== 1) return null
  if (Object.keys(body).some((k) => !ALLOWED_KEYS.has(k))) return null
  const out = {
    sig: cleanString(body.sig, RE_SIG),
    category: ALLOWED_CATEGORIES.has(body.category) ? body.category : 'other',
    shell: cleanString(body.shell, RE_SEMVER),
  }
  if (!out.sig || !out.shell) return null
  if (body.plugin != null) {
    out.plugin = cleanString(body.plugin, RE_NPM_NAME)
    if (!out.plugin) return null
    out.plugin_ver = cleanString(body.plugin_ver, RE_SEMVER) || undefined
  }
  if (body.code != null) {
    out.code = cleanString(body.code, RE_CODE)
    if (!out.code) return null
  }
  if (body.turns != null) {
    const n = Number(body.turns)
    if (!Number.isInteger(n) || n < 0 || n > 100000) return null
    out.turns = n
  }
  return out
}

export async function onRequestPost({ request, env }) {
  const len = Number(request.headers.get('content-length')) || 0
  if (len > MAX_BODY_BYTES) return json({ ok: false, error: 'body too large' }, 413)

  let body
  try {
    body = await request.json()
  } catch {
    return json({ ok: false, error: 'invalid json' }, 400)
  }

  const report = sanitize(body)
  if (!report) return json({ ok: false, error: 'schema rejected' }, 400)

  try {
    const cap = await sql(env, "SELECT count(*) FROM reports WHERE created_at > now() - interval '24 hours'")
    if (Number(cap.rows?.[0]?.[0] ?? 0) >= DAILY_CAP) {
      return json({ ok: false, error: 'daily cap reached' }, 429)
    }

    const cols = ['sig', 'category', 'shell']
    const vals = [`'${report.sig}'`, `'${report.category}'`, `'${report.shell}'`]
    for (const k of ['plugin', 'plugin_ver', 'code']) {
      if (report[k] != null) { cols.push(k); vals.push(`'${report[k]}'`) }
    }
    if (report.turns != null) { cols.push('turns'); vals.push(String(report.turns)) }
    const inserted = await sql(
      env,
      `INSERT INTO reports (${cols.join(', ')}) VALUES (${vals.join(', ')}) RETURNING id`,
    )
    const id = inserted.rows?.[0]?.[0]
    return json({ ok: true, id: id != null ? `r_${id}` : null })
  } catch (err) {
    return json({ ok: false, error: `storage unavailable: ${err?.message ?? err}` }, 503)
  }
}

export function onRequestGet() {
  return json({ ok: false, error: 'method not allowed, use POST' }, 405)
}

export function onRequest() {
  return json({ ok: false, error: 'method not allowed, use POST' }, 405)
}
