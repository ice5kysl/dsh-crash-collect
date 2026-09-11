// GET /admin — 总览：指标卡片、签名排行 Top 10、最近上报 10 条

import { badge, card, esc, errorPage, guard, layout, page, sql, table } from './_layout.js'

export async function onRequestGet(context) {
  const denied = guard(context)
  if (denied) return denied
  const { env } = context
  if (!env.DB9_TOKEN) return new Response('DB9_TOKEN not configured', { status: 503 })

  try {
    const [[total, sigs], today, top, recent] = await Promise.all([
      sql(env, 'SELECT count(*), count(DISTINCT sig) FROM reports').then((r) => r[0]),
      sql(env, "SELECT count(*) FROM reports WHERE created_at > now() - interval '24 hours'").then((r) => r[0][0]),
      sql(env, `SELECT sig, category, count(*), count(DISTINCT shell), max(created_at)
                FROM reports GROUP BY sig, category ORDER BY count(*) DESC, max(created_at) DESC LIMIT 10`),
      sql(env, 'SELECT id, sig, category, shell, plugin, code, created_at FROM reports ORDER BY id DESC LIMIT 10'),
    ])

    const topRows = top.map((r) => `<tr class="hover:bg-slate-50">
      <td class="px-4 py-2.5 font-mono text-xs"><a class="text-indigo-600 hover:underline" href="/admin/signatures?sig=${encodeURIComponent(r[0])}">${esc(r[0])}</a></td>
      <td class="px-4 py-2.5">${badge(r[1], 'indigo')}</td>
      <td class="px-4 py-2.5 text-right font-semibold">${r[2]}</td>
      <td class="px-4 py-2.5 text-right">${r[3]}</td>
      <td class="px-4 py-2.5 text-slate-400">${esc(String(r[4]).slice(0, 16))}</td></tr>`).join('')

    const recentRows = recent.map((r) => `<tr class="hover:bg-slate-50">
      <td class="px-4 py-2.5 text-slate-400">#${r[0]}</td>
      <td class="px-4 py-2.5 font-mono text-xs">${esc(r[1])}</td>
      <td class="px-4 py-2.5">${badge(r[2])}</td>
      <td class="px-4 py-2.5 font-mono text-xs">${esc(r[3])}</td>
      <td class="px-4 py-2.5">${r[4] ? esc(r[4]) : '<span class="text-slate-300">—</span>'}</td>
      <td class="px-4 py-2.5">${r[5] ? badge(r[5], 'amber') : ''}</td>
      <td class="px-4 py-2.5 text-slate-400">${esc(String(r[6]).slice(0, 19))}</td></tr>`).join('')

    return page(layout({
      title: '总览',
      active: 'overview',
      content: `
      <div class="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-3">
        ${card('累计上报', total)}
        ${card('去重签名', sigs)}
        ${card('最近 24 小时', today)}
      </div>
      <div class="space-y-8">
        <section>
          <div class="mb-3 flex items-baseline justify-between">
            <h2 class="font-semibold text-slate-900">签名排行 Top 10</h2>
            <a href="/admin/signatures" class="text-sm text-indigo-600 hover:underline">全部签名 →</a>
          </div>
          ${table(['sig', 'category', '次数', 'shell 数', '最近出现'], topRows)}
        </section>
        <section>
          <div class="mb-3 flex items-baseline justify-between">
            <h2 class="font-semibold text-slate-900">最近上报</h2>
            <a href="/admin/reports" class="text-sm text-indigo-600 hover:underline">全部明细 →</a>
          </div>
          ${table(['id', 'sig', 'category', 'shell', 'plugin', 'code', '时间'], recentRows)}
        </section>
      </div>`,
    }))
  } catch (err) {
    return errorPage(err)
  }
}

export function onRequest() {
  return new Response('method not allowed', { status: 405 })
}
