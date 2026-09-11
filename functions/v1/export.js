// GET /v1/export?key=<EXPORT_KEY>[&since=YYYYMMDD][&limit=N]
// 供 dsh-insights pipeline 每日拉取上报明细，输出 JSONL。
// EXPORT_KEY 在 Pages 项目环境变量中配置，不写入仓库。

const MAX_SCAN = 20000

function unauthorized() {
  return new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), {
    status: 401,
    headers: { 'content-type': 'application/json; charset=UTF-8' },
  })
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url)
  const expected = env && env.EXPORT_KEY
  if (!expected || url.searchParams.get('key') !== expected) return unauthorized()

  const store = globalThis.crash_kv
  if (!store) {
    return new Response(JSON.stringify({ ok: false, error: 'storage not configured' }), {
      status: 503,
      headers: { 'content-type': 'application/json; charset=UTF-8' },
    })
  }

  const since = url.searchParams.get('since') // 按 key 内嵌的日期前缀过滤：r_YYYYMMDD_...
  const limit = Math.min(Number(url.searchParams.get('limit')) || 5000, MAX_SCAN)
  const prefix = since ? `r_${since}` : 'r_'

  const lines = []
  let cursor
  do {
    const page = await store.list({ prefix, limit: 256, cursor })
    for (const { key } of page.keys) {
      if (lines.length >= limit) break
      const value = await store.get(key)
      if (value) lines.push(JSON.stringify({ id: key, ...JSON.parse(value) }))
    }
    cursor = page.complete ? null : page.cursor
  } while (cursor && lines.length < limit)

  return new Response(lines.join('\n') + (lines.length ? '\n' : ''), {
    headers: { 'content-type': 'application/x-ndjson; charset=UTF-8' },
  })
}

export function onRequest() {
  return new Response(JSON.stringify({ ok: false, error: 'method not allowed, use GET' }), {
    status: 405,
    headers: { 'content-type': 'application/json; charset=UTF-8' },
  })
}
