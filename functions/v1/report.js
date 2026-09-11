// POST /v1/report — dsh-why 崩溃案例上报端点（opt-in，白名单脱敏）
//
// 隐私红线：只接收并存储下列白名单字段，其它字段一律丢弃。
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

function kv() {
  // KV 命名空间绑定变量名为 crash_kv；Pages 运行时将其暴露为全局变量
  const ref = globalThis.crash_kv
  if (!ref) throw new Error('KV binding crash_kv not configured')
  return ref
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

function dayKey(d = new Date()) {
  return d.toISOString().slice(0, 10).replace(/-/g, '')
}

function rid() {
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function bumpCounter(store, key, delta = 1) {
  // KV 为最终一致，计数是近似值——用于软限流和公开统计，精度足够
  const cur = Number(await store.get(key)) || 0
  await store.put(key, String(cur + delta))
  return cur + delta
}

async function aggregate(store, report, now) {
  const key = `agg_${report.sig}`
  let agg
  try {
    agg = (await store.get(key, { type: 'json' })) || null
  } catch {
    agg = null
  }
  if (!agg || typeof agg !== 'object') {
    agg = { n: 0, first: now, shells: {}, plugins: {}, categories: {} }
  }
  agg.n += 1
  agg.last = now
  agg.shells[report.shell] = (agg.shells[report.shell] || 0) + 1
  if (report.plugin) {
    const p = report.plugin_ver ? `${report.plugin}@${report.plugin_ver}` : report.plugin
    agg.plugins[p] = (agg.plugins[p] || 0) + 1
  }
  agg.categories[report.category] = (agg.categories[report.category] || 0) + 1
  await store.put(key, JSON.stringify(agg))
}

export async function onRequestPost({ request }) {
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

  let store
  try {
    store = kv()
  } catch {
    return json({ ok: false, error: 'storage not configured' }, 503)
  }

  const today = dayKey()
  const used = await bumpCounter(store, `cap_${today}`)
  if (used > DAILY_CAP) return json({ ok: false, error: 'daily cap reached' }, 429)

  const id = `r_${today}_${rid()}`
  report.ts = Date.now()
  await store.put(id, JSON.stringify(report))
  await bumpCounter(store, 'meta_total')
  await aggregate(store, report, report.ts)

  return json({ ok: true, id })
}

export function onRequestGet() {
  return json({ ok: false, error: 'method not allowed, use POST' }, 405)
}

export function onRequest() {
  return json({ ok: false, error: 'method not allowed, use POST' }, 405)
}
