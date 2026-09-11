// GET /v1/stats — 公开统计：累计上报数与去重签名数（透明度页面可用）

const DEFAULT_SQL_URL = 'https://api.db9.ai/customer/databases/toc6zdt4vd7j/sql'

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=UTF-8',
      'access-control-allow-origin': '*',
    },
  })
}

export async function onRequestGet({ env }) {
  const token = env && env.DB9_TOKEN
  if (!token) return json({ ok: false, error: 'storage not configured' }, 503)

  try {
    const res = await fetch((env && env.DB9_SQL_URL) || DEFAULT_SQL_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ query: 'SELECT count(*), count(DISTINCT sig) FROM reports' }),
    })
    const body = await res.json().catch(() => null)
    if (!res.ok || !body?.rows) return json({ ok: false, error: body?.message ?? `HTTP ${res.status}` }, 502)
    return json({
      ok: true,
      total_reports: Number(body.rows[0][0]),
      distinct_signatures: Number(body.rows[0][1]),
    })
  } catch (err) {
    return json({ ok: false, error: `storage unavailable: ${err?.message ?? err}` }, 503)
  }
}

export function onRequest() {
  return json({ ok: false, error: 'method not allowed, use GET' }, 405)
}
