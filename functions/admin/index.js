// GET /admin — 总览：指标卡片、签名排行 Top 10、最近上报 10 条

import { badge, card, esc, errorPage, guard, layout, page, sourceBadge, sql, table } from './_layout.js'

export async function onRequestGet(context) {
  const denied = guard(context)
  if (denied) return denied
  const { env } = context
  if (!env.DB9_TOKEN) return new Response('DB9_TOKEN not configured', { status: 503 })

  try {
    const [[organic, organicSigs, seeded], today, top, recent, [plugins], [events], latestRelease] = await Promise.all([
      sql(env, `SELECT
                  count(*) FILTER (WHERE source = 'organic') AS organic,
                  count(DISTINCT sig) FILTER (WHERE source = 'organic') AS organic_sigs,
                  count(*) FILTER (WHERE source = 'seed') AS seeded,
                  count(*) AS total
                FROM reports`).then((r) => r[0]),
      sql(env, "SELECT count(*) FROM reports WHERE created_at > now() - interval '24 hours'").then((r) => r[0][0]),
      sql(env, `SELECT sig, category,
                  count(*) FILTER (WHERE source = 'organic') AS organic,
                  count(*) FILTER (WHERE source = 'seed') AS seeded,
                  count(DISTINCT shell), max(created_at)
                FROM reports GROUP BY sig, category
                ORDER BY organic DESC, seeded DESC, max(created_at) DESC LIMIT 10`),
      sql(env, 'SELECT id, sig, category, shell, plugin, code, source, created_at FROM reports ORDER BY id DESC LIMIT 10'),
      sql(env, 'SELECT count(*) FROM plugins').then((r) => r[0]),
      sql(env, 'SELECT count(*) FROM ecosystem_events').then((r) => r[0]),
      sql(env, `SELECT key, occurred_at FROM ecosystem_events WHERE type = 'shell_release'
                ORDER BY occurred_at DESC LIMIT 1`).then((r) => r[0]),
    ])

    const topRows = top.map((r) => `<tr class="hover:bg-slate-50">
      <td class="px-4 py-2.5 font-mono text-xs"><a class="text-indigo-600 hover:underline" href="/admin/signatures?sig=${encodeURIComponent(r[0])}">${esc(r[0])}</a></td>
      <td class="px-4 py-2.5">${badge(r[1], 'indigo')}</td>
      <td class="px-4 py-2.5 text-right font-semibold">${r[2]}</td>
      <td class="px-4 py-2.5 text-right text-amber-600">${r[3]}</td>
      <td class="px-4 py-2.5 text-right">${r[4]}</td>
      <td class="px-4 py-2.5 text-slate-400">${esc(String(r[5]).slice(0, 16))}</td></tr>`).join('')

    const recentRows = recent.map((r) => `<tr class="hover:bg-slate-50">
      <td class="px-4 py-2.5"><a class="text-indigo-600 hover:underline" href="/admin/reports?id=${r[0]}">#${r[0]}</a></td>
      <td class="px-4 py-2.5 font-mono text-xs">${esc(r[1])}</td>
      <td class="px-4 py-2.5">${badge(r[2])}</td>
      <td class="px-4 py-2.5 font-mono text-xs">${esc(r[3])}</td>
      <td class="px-4 py-2.5">${r[4] ? esc(r[4]) : '<span class="text-slate-300">—</span>'}</td>
      <td class="px-4 py-2.5">${r[5] ? badge(r[5], 'amber') : ''}</td>
      <td class="px-4 py-2.5">${sourceBadge(r[6])}</td>
      <td class="px-4 py-2.5 text-slate-400">${esc(String(r[7]).slice(0, 19))}</td></tr>`).join('')

    return page(layout({
      title: '总览',
      active: 'overview',
      content: `
      <div class="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        ${card('用户上报', organic, '真实用户 --share 上报')}
        ${card('去重签名', organicSigs, '用户上报去重后')}
        ${card('种子入库', seeded, '冷启动语料，不计入用户上报')}
        ${card('最近 24 小时', today, '含种子')}
      </div>
      <div class="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <a href="/admin/plugins" class="block transition hover:-translate-y-0.5">${card('生态插件', plugins, 'dsh-insights 收录，点击查看插件库')}</a>
        <a href="/admin/events" class="block transition hover:-translate-y-0.5">${card('生态事件', events, '发版 / 上架 / 模型观察')}</a>
        <a href="/admin/events?type=shell_release" class="block transition hover:-translate-y-0.5">${card('最近发版', latestRelease ? esc(latestRelease[0]) : '—', latestRelease ? esc(String(latestRelease[1]).slice(0, 19)) : '')}</a>
      </div>
      <div class="space-y-8">
        <section>
          <div class="mb-3 flex items-baseline justify-between">
            <h2 class="font-semibold text-slate-900">签名排行 Top 10</h2>
            <a href="/admin/signatures" class="text-sm text-indigo-600 hover:underline">全部签名 →</a>
          </div>
          ${table(['sig', 'category', '用户', '种子', 'shell 数', '最近出现'], topRows)}
        </section>
        <section>
          <div class="mb-3 flex items-baseline justify-between">
            <h2 class="font-semibold text-slate-900">最近上报</h2>
            <a href="/admin/reports" class="text-sm text-indigo-600 hover:underline">全部明细 →</a>
          </div>
          ${table(['id', 'sig', 'category', 'shell', 'plugin', 'code', '来源', '时间'], recentRows)}
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
