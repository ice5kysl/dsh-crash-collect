// GET /v1/stats — 公开统计：用户上报数与去重签名数（透明度页面可用）
//
// 口径：total_reports / distinct_signatures 只统计 source='organic' 的**真实用户
// 上报**。冷启动种子（source='seed'，scripts/seed-corpus.mjs 灌入的实测语料）
// 单独放在 seeded_* 里，绝不计入对外数字——否则"累计上报"会把我们自己的种子
// 当作社区上报量。全表规模见 corpus_*。

const DEFAULT_SQL_URL = 'https://api.db9.ai/customer/databases/toc6zdt4vd7j/sql'

const STATS_QUERY = `SELECT
  count(*) FILTER (WHERE source = 'organic'),
  count(DISTINCT sig) FILTER (WHERE source = 'organic'),
  count(*) FILTER (WHERE source = 'seed'),
  count(DISTINCT sig) FILTER (WHERE source = 'seed'),
  count(*),
  count(DISTINCT sig)
FROM reports`

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
      body: JSON.stringify({ query: STATS_QUERY }),
    })
    const body = await res.json().catch(() => null)
    if (!res.ok || !body?.rows) return json({ ok: false, error: body?.message ?? `HTTP ${res.status}` }, 502)
    const [organic, organicSigs, seeded, seededSigs, all, allSigs] = body.rows[0].map(Number)
    return json({
      ok: true,
      // 对外口径：只有 organic 是用户上报
      total_reports: organic,
      distinct_signatures: organicSigs,
      // 冷启动种子语料（机器灌入，不是用户上报）
      seeded_reports: seeded,
      seeded_signatures: seededSigs,
      // 全表规模（含种子）
      corpus_reports: all,
      corpus_signatures: allSigs,
    })
  } catch (err) {
    return json({ ok: false, error: `storage unavailable: ${err?.message ?? err}` }, 503)
  }
}

export function onRequest() {
  return json({ ok: false, error: 'method not allowed, use GET' }, 405)
}
