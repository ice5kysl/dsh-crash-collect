// GET /v1/stats — 公开统计：累计上报数与去重签名数（透明度页面可用）

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=UTF-8',
      'access-control-allow-origin': '*',
    },
  })
}

export async function onRequestGet() {
  const store = globalThis.crash_kv
  if (!store) return json({ ok: false, error: 'storage not configured' }, 503)

  const total = Number(await store.get('meta_total')) || 0

  let signatures = 0
  let cursor
  do {
    const page = await store.list({ prefix: 'agg_', limit: 256, cursor })
    signatures += page.keys.length
    cursor = page.complete ? null : page.cursor
  } while (cursor)

  return json({ ok: true, total_reports: total, distinct_signatures: signatures })
}

export function onRequest() {
  return json({ ok: false, error: 'method not allowed, use GET' }, 405)
}
