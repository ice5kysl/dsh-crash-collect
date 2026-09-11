// GET /admin — 崩溃案例库管理后台（Basic Auth，服务端渲染，零依赖）
//
// 环境变量：ADMIN_KEY（Basic Auth 密码，缺省回落 EXPORT_KEY）、DB9_TOKEN。
// 用户名任意（admin），密码为 ADMIN_KEY。

const DEFAULT_SQL_URL = 'https://api.db9.ai/customer/databases/wqxvoyf8yu05/sql'

const PAGE = (title, body) => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · dsh-crash admin</title>
<style>
body{max-width:1080px;margin:24px auto;padding:0 16px;font:14px/1.6 -apple-system,"PingFang SC",sans-serif;color:#222}
h1{font-size:18px} h2{font-size:15px;margin-top:28px}
table{border-collapse:collapse;width:100%} td,th{border:1px solid #ddd;padding:4px 8px;text-align:left;font-size:13px}
th{background:#f6f6f6} .num{text-align:right;font-variant-numeric:tabular-nums}
a{color:#06c;text-decoration:none} a:hover{text-decoration:underline}
.cards{display:flex;gap:16px;margin:12px 0}.card{border:1px solid #ddd;border-radius:8px;padding:12px 20px}
.card b{font-size:24px;display:block}
form{display:inline} input,select{padding:3px 6px;font-size:13px}
.muted{color:#888;font-size:12px}
</style></head><body>${body}
<p class="muted">dsh-crash-collect admin · 数据：<a href="/v1/stats">/v1/stats</a>（公开） · 只收集白名单结构化字段</p>
</body></html>`

function html(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function unauthorized() {
  return new Response('401 — 需要管理密码', {
    status: 401,
    headers: { 'www-authenticate': 'Basic realm="dsh-crash-admin"', 'content-type': 'text/plain; charset=UTF-8' },
  })
}

async function sql(env, query) {
  const res = await fetch((env && env.DB9_SQL_URL) || DEFAULT_SQL_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${env.DB9_TOKEN}` },
    body: JSON.stringify({ query }),
  })
  const body = await res.json().catch(() => null)
  if (!res.ok || !body?.rows) throw new Error(body?.message ?? `HTTP ${res.status}`)
  return body.rows
}

const RE_FILTER = /^[a-z0-9@/._+-]{1,128}$/i

export async function onRequestGet({ request, env }) {
  const key = (env && (env.ADMIN_KEY || env.EXPORT_KEY)) || null
  if (!key) return new Response('admin not configured', { status: 503 })
  const auth = request.headers.get('authorization') || ''
  const pass = auth.startsWith('Basic ') ? atob(auth.slice(6)).split(':').slice(1).join(':') : ''
  if (pass !== key) return unauthorized()
  if (!env.DB9_TOKEN) return new Response('DB9_TOKEN not configured', { status: 503 })

  const url = new URL(request.url)
  const q = Object.fromEntries(
    ['sig', 'category', 'shell', 'plugin']
      .map((k) => [k, url.searchParams.get(k)])
      .filter(([, v]) => v && RE_FILTER.test(v)),
  )
  const where = Object.entries(q).map(([k, v]) => `${k} = '${v}'`).join(' AND ')

  try {
    const [[total, sigs], top, recent] = await Promise.all([
      sql(env, 'SELECT count(*), count(DISTINCT sig) FROM reports').then((r) => r[0]),
      sql(env, `SELECT sig, category, count(*), count(DISTINCT shell), count(DISTINCT plugin), max(created_at) FROM reports ${where ? `WHERE ${where}` : ''} GROUP BY sig, category ORDER BY count(*) DESC LIMIT 50`),
      sql(env, `SELECT id, sig, category, shell, plugin, plugin_ver, code, turns, created_at FROM reports ${where ? `WHERE ${where}` : ''} ORDER BY id DESC LIMIT 200`),
    ])

    const filterForm = `<form method="get" action="/admin">
      <input name="sig" placeholder="sig" value="${html(q.sig ?? '')}" size="18">
      <input name="category" placeholder="category" value="${html(q.category ?? '')}" size="14">
      <input name="shell" placeholder="shell" value="${html(q.shell ?? '')}" size="12">
      <input name="plugin" placeholder="plugin" value="${html(q.plugin ?? '')}" size="16">
      <button type="submit">过滤</button> <a href="/admin">重置</a></form>`

    const topRows = top.map((r) => `<tr>
      <td><a href="/admin?sig=${encodeURIComponent(r[0])}">${html(r[0])}</a></td>
      <td>${html(r[1])}</td><td class="num">${r[2]}</td><td class="num">${r[3]}</td><td class="num">${r[4] ?? 0}</td>
      <td class="muted">${html(String(r[5]).slice(0, 19))}</td></tr>`).join('')

    const recentRows = recent.map((r) => `<tr>
      <td class="num">${r[0]}</td><td>${html(r[1])}</td><td>${html(r[2])}</td><td>${html(r[3])}</td>
      <td>${html(r[4] ?? '')}</td><td>${html(r[5] ?? '')}</td><td>${html(r[6] ?? '')}</td>
      <td class="num">${r[7] ?? ''}</td><td class="muted">${html(String(r[8]).slice(0, 19))}</td></tr>`).join('')

    return new Response(PAGE('admin', `
      <h1>dsh-crash 案例库</h1>
      <div class="cards">
        <div class="card"><b>${total}</b>累计上报</div>
        <div class="card"><b>${sigs}</b>去重签名</div>
      </div>
      ${filterForm}
      <h2>签名排行（按出现次数）</h2>
      <table><tr><th>sig</th><th>category</th><th class="num">次数</th><th class="num">shell 数</th><th class="num">插件数</th><th>最近</th></tr>${topRows || '<tr><td colspan="6" class="muted">暂无数据</td></tr>'}</table>
      <h2>最近上报（${recent.length}）</h2>
      <table><tr><th>id</th><th>sig</th><th>category</th><th>shell</th><th>plugin</th><th>ver</th><th>code</th><th>turns</th><th>时间</th></tr>${recentRows || '<tr><td colspan="9" class="muted">暂无数据</td></tr>'}</table>
    `), { headers: { 'content-type': 'text/html; charset=UTF-8' } })
  } catch (err) {
    return new Response(PAGE('error', `<h1>存储不可用</h1><p>${html(err?.message ?? err)}</p>`), {
      status: 502,
      headers: { 'content-type': 'text/html; charset=UTF-8' },
    })
  }
}

export function onRequest() {
  return new Response('method not allowed', { status: 405 })
}
