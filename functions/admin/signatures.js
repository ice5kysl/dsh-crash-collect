// GET /admin/signatures — 签名聚合全表；?sig=xxx 右侧抽屉：分布 + 样本

import { badge, esc, errorPage, guard, layout, page, RE_FILTER, sql, table } from './_layout.js'

function dist(rows, keyIdx) {
  const total = rows.reduce((a, r) => a + Number(r[1]), 0) || 1
  return rows.map((r) => {
    const pct = Math.round((Number(r[1]) / total) * 100)
    return `<div class="mb-2">
      <div class="mb-0.5 flex justify-between text-xs">
        <span class="break-all font-mono">${esc(r[keyIdx])}</span>
        <span class="ml-2 shrink-0 text-slate-500">${r[1]} 次 · ${pct}%</span>
      </div>
      <div class="h-1.5 rounded-full bg-slate-100"><div class="h-1.5 rounded-full bg-indigo-500" style="width:${pct}%"></div></div>
    </div>`
  }).join('')
}

async function drawer(env, sig) {
  const [[summary], shells, plugins, samples] = await Promise.all([
    sql(env, `SELECT count(*), min(created_at), max(created_at), max(category) FROM reports WHERE sig = '${sig}'`).then((r) => r[0]),
    sql(env, `SELECT shell, count(*) FROM reports WHERE sig = '${sig}' GROUP BY shell ORDER BY count(*) DESC LIMIT 8`),
    sql(env, `SELECT coalesce(plugin, '(无插件信息)'), count(*) FROM reports WHERE sig = '${sig}' GROUP BY plugin ORDER BY count(*) DESC LIMIT 8`),
    sql(env, `SELECT id, shell, plugin, code, created_at FROM reports WHERE sig = '${sig}' ORDER BY id DESC LIMIT 10`),
  ])

  const sampleRows = samples.map((r) => `<tr class="hover:bg-slate-50">
    <td class="px-3 py-2"><a class="text-indigo-600 hover:underline" href="/admin/reports?id=${r[0]}">#${r[0]}</a></td>
    <td class="px-3 py-2 font-mono text-xs">${esc(r[1])}</td>
    <td class="px-3 py-2 text-xs">${esc(r[2] ?? '')}</td>
    <td class="px-3 py-2 text-xs text-slate-400">${esc(String(r[4]).slice(5, 16))}</td></tr>`).join('')

  return `
  <aside class="sticky top-8 max-h-[calc(100vh-6rem)] w-[26rem] shrink-0 overflow-y-auto rounded-xl border border-indigo-200 bg-white shadow-lg">
    <div class="flex items-center justify-between border-b border-slate-200 px-4 py-3">
      <span class="break-all font-mono text-sm font-semibold">${esc(sig)}</span>
      <a href="/admin/signatures" class="ml-2 shrink-0 rounded-lg px-2 py-1 text-sm text-slate-400 hover:bg-slate-100 hover:text-slate-700">✕</a>
    </div>
    <div class="border-b border-slate-100 px-4 py-3 text-sm text-slate-600">
      ${badge(summary[3] ?? 'other', 'indigo')}
      <span class="ml-2">共 <b>${summary[0]}</b> 次</span>
      <div class="mt-1 text-xs text-slate-400">首现 ${esc(String(summary[1]).slice(0, 10))} · 最近 ${esc(String(summary[2]).slice(0, 16))}</div>
    </div>
    <div class="border-b border-slate-100 px-4 py-3">
      <div class="mb-3 text-xs font-semibold text-slate-500">shell 版本分布</div>${dist(shells, 0)}
      <div class="mb-3 mt-4 text-xs font-semibold text-slate-500">插件分布</div>${dist(plugins, 0)}
    </div>
    <div class="px-4 py-3">
      <div class="mb-2 text-xs font-semibold text-slate-500">样本（最近 ${samples.length} 条）</div>
      <table class="min-w-full divide-y divide-slate-100 text-sm">
        <tbody class="divide-y divide-slate-100">${sampleRows}</tbody>
      </table>
    </div>
  </aside>`
}

export async function onRequestGet(context) {
  const denied = guard(context)
  if (denied) return denied
  const { request, env } = context
  if (!env.DB9_TOKEN) return new Response('DB9_TOKEN not configured', { status: 503 })

  const sig = new URL(request.url).searchParams.get('sig')
  try {
    const rows = await sql(env, `SELECT sig, category, count(*), count(DISTINCT shell), count(DISTINCT plugin),
      min(created_at), max(created_at) FROM reports GROUP BY sig, category
      ORDER BY count(*) DESC, max(created_at) DESC LIMIT 200`)
    const bodyRows = rows.map((r) => `<tr class="hover:bg-indigo-50 ${sig === r[0] ? 'bg-indigo-50' : ''}">
      <td class="px-4 py-2.5 font-mono text-xs"><a class="text-indigo-600 hover:underline" href="/admin/signatures?sig=${encodeURIComponent(r[0])}">${esc(r[0])}</a></td>
      <td class="px-4 py-2.5">${badge(r[1], 'indigo')}</td>
      <td class="px-4 py-2.5 text-right font-semibold">${r[2]}</td>
      <td class="px-4 py-2.5 text-right">${r[3]}</td>
      <td class="px-4 py-2.5 text-right">${r[4]}</td>
      <td class="px-4 py-2.5 text-slate-400">${esc(String(r[5]).slice(0, 10))}</td>
      <td class="px-4 py-2.5 text-slate-400">${esc(String(r[6]).slice(0, 16))}</td></tr>`).join('')

    const panel = sig && RE_FILTER.test(sig) ? await drawer(env, sig) : ''

    return page(layout({
      title: '签名分析',
      active: 'signatures',
      content: `
      <p class="mb-4 text-sm text-slate-500">同一签名 = 同一类故障。次数即「全生态出现 N 次」的数据源；点击签名在右侧查看分布与样本。</p>
      <div class="flex items-start gap-6">
        <div class="min-w-0 flex-1">
          ${table(['sig', 'category', '次数', 'shell 数', '插件数', '首现', '最近'], bodyRows)}
        </div>
        ${panel}
      </div>`,
    }))
  } catch (err) {
    return errorPage(err)
  }
}

export function onRequest() {
  return new Response('method not allowed', { status: 405 })
}
