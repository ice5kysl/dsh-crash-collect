// GET /v1/export?key=<EXPORT_KEY>[&since=YYYY-MM-DD][&limit=N]
// 供 dsh-insights pipeline 拉取上报明细，输出 JSONL。
// （pipeline 也可以绕过本端点直接 psql 查库——此端点只是便捷通道。）
// EXPORT_KEY 在 Pages 项目环境变量中配置，不写入仓库。

const DEFAULT_SQL_URL = 'https://api.db9.ai/customer/databases/wqxvoyf8yu05/sql'
const MAX_LIMIT = 20000

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=UTF-8' },
  })
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url)
  const expected = env && env.EXPORT_KEY
  if (!expected || url.searchParams.get('key') !== expected) {
    return json({ ok: false, error: 'unauthorized' }, 401)
  }
  const token = env && env.DB9_TOKEN
  if (!token) return json({ ok: false, error: 'storage not configured' }, 503)

  const since = url.searchParams.get('since')
  if (since && !/^\d{4}-\d{2}(-\d{2})?$/.test(since)) return json({ ok: false, error: 'bad since' }, 400)
  const limit = Math.min(Number(url.searchParams.get('limit')) || 5000, MAX_LIMIT)

  const where = since ? `WHERE created_at >= '${since}'::timestamptz` : ''
  const query = `SELECT id, sig, category, shell, plugin, plugin_ver, code, turns, created_at FROM reports ${where} ORDER BY id LIMIT ${limit}`

  try {
    const res = await fetch((env && env.DB9_SQL_URL) || DEFAULT_SQL_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ query }),
    })
    const body = await res.json().catch(() => null)
    if (!res.ok || !body?.rows) return json({ ok: false, error: body?.message ?? `HTTP ${res.status}` }, 502)

    const lines = body.rows.map((r) => JSON.stringify({
      id: `r_${r[0]}`, sig: r[1], category: r[2], shell: r[3],
      plugin: r[4] ?? undefined, plugin_ver: r[5] ?? undefined,
      code: r[6] ?? undefined, turns: r[7] ?? undefined, ts: r[8],
    }))
    return new Response(lines.join('\n') + (lines.length ? '\n' : ''), {
      headers: { 'content-type': 'application/x-ndjson; charset=UTF-8' },
    })
  } catch (err) {
    return json({ ok: false, error: `storage unavailable: ${err?.message ?? err}` }, 503)
  }
}

export function onRequest() {
  return json({ ok: false, error: 'method not allowed, use GET' }, 405)
}
