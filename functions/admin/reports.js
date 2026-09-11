// GET /admin/reports — 上报明细：组合过滤 + 分页；?id=N 单条详情（全字段 + 原始 JSON）

import { badge, esc, errorPage, guard, layout, page, RE_FILTER, sql, table } from './_layout.js'

const PAGE_SIZE = 50

const FIELDS = ['id', 'sig', 'category', 'shell', 'plugin', 'plugin_ver', 'code', 'turns', 'created_at']

async function detail(env, id) {
  const rows = await sql(env, `SELECT ${FIELDS.join(', ')} FROM reports WHERE id = ${id} LIMIT 1`)
  if (!rows.length) {
    return layout({ title: `上报 #${id}`, active: 'reports', content: '<p class="text-slate-500">记录不存在。</p>' })
  }
  const obj = Object.fromEntries(FIELDS.map((f, i) => [f, rows[0][i]]))
  const fieldRows = FIELDS.map((f, i) => `<tr class="hover:bg-slate-50">
    <td class="px-4 py-2.5 font-mono text-xs text-slate-500 w-40">${f}</td>
    <td class="px-4 py-2.5">${f === 'sig'
      ? `<a class="font-mono text-xs text-indigo-600 hover:underline" href="/admin/signatures?sig=${encodeURIComponent(rows[0][i])}">${esc(rows[0][i])}</a>`
      : (rows[0][i] == null || rows[0][i] === '' ? '<span class="text-slate-300">—</span>' : esc(rows[0][i]))}</td></tr>`).join('')

  return layout({
    title: `上报 #${id}`,
    active: 'reports',
    content: `
    <div class="mb-5"><a href="/admin/reports" class="text-sm text-indigo-600 hover:underline">← 返回明细列表</a></div>
    <div class="space-y-6">
      ${table(['字段', '值'], fieldRows)}
      <section>
        <h2 class="mb-3 font-semibold text-slate-900">原始记录（JSON）</h2>
        <pre class="overflow-x-auto rounded-xl border border-slate-200 bg-slate-900 p-4 text-xs leading-relaxed text-slate-100">${esc(JSON.stringify(obj, null, 2))}</pre>
        <p class="mt-2 text-xs text-slate-400">入库前已通过白名单校验：只有上述结构化字段，绝不含消息文本、文件路径或 prompt。</p>
      </section>
    </div>`,
  })
}

export async function onRequestGet(context) {
  const denied = guard(context)
  if (denied) return denied
  const { request, env } = context
  if (!env.DB9_TOKEN) return new Response('DB9_TOKEN not configured', { status: 503 })

  const url = new URL(request.url)
  const id = Number(url.searchParams.get('id'))

  try {
    if (Number.isInteger(id) && id > 0) return page(await detail(env, id))

    const q = Object.fromEntries(
      ['sig', 'category', 'shell', 'plugin']
        .map((k) => [k, url.searchParams.get(k)])
        .filter(([, v]) => v && RE_FILTER.test(v)),
    )
    const conds = Object.entries(q).map(([k, v]) => `${k} = '${v}'`)
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
    const pageNum = Math.max(1, Number(url.searchParams.get('page')) || 1)
    const qs = new URLSearchParams(q)

    const [[count], rows] = await Promise.all([
      sql(env, `SELECT count(*) FROM reports ${where}`).then((r) => r[0]),
      sql(env, `SELECT id, sig, category, shell, plugin, plugin_ver, code, turns, created_at
                FROM reports ${where} ORDER BY id DESC LIMIT ${PAGE_SIZE} OFFSET ${(pageNum - 1) * PAGE_SIZE}`),
    ])
    const pages = Math.max(1, Math.ceil(count / PAGE_SIZE))

    const bodyRows = rows.map((r) => `<tr class="hover:bg-slate-50">
      <td class="px-4 py-2.5"><a class="text-indigo-600 hover:underline" href="/admin/reports?id=${r[0]}">#${r[0]}</a></td>
      <td class="px-4 py-2.5 font-mono text-xs"><a class="text-indigo-600 hover:underline" href="/admin/signatures?sig=${encodeURIComponent(r[1])}">${esc(r[1])}</a></td>
      <td class="px-4 py-2.5">${badge(r[2])}</td>
      <td class="px-4 py-2.5 font-mono text-xs">${esc(r[3])}</td>
      <td class="px-4 py-2.5">${r[4] ? esc(r[4]) : '<span class="text-slate-300">—</span>'}</td>
      <td class="px-4 py-2.5 font-mono text-xs">${esc(r[5] ?? '')}</td>
      <td class="px-4 py-2.5">${r[6] ? badge(r[6], 'amber') : ''}</td>
      <td class="px-4 py-2.5 text-right">${r[7] ?? ''}</td>
      <td class="px-4 py-2.5 text-slate-400">${esc(String(r[8]).slice(0, 19))}</td></tr>`).join('')

    const input = (name, ph, size) =>
      `<input name="${name}" value="${esc(q[name] ?? '')}" placeholder="${ph}" size="${size}"
        class="rounded-lg border border-slate-300 px-3 py-1.5 text-sm focus:border-indigo-500 focus:outline-none">`

    const pageLink = (p, label, enabled) => enabled
      ? `<a href="/admin/reports?${qs}&page=${p}" class="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm hover:bg-slate-50">${label}</a>`
      : `<span class="rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-300">${label}</span>`

    return page(layout({
      title: '上报明细',
      active: 'reports',
      content: `
      <form method="get" action="/admin/reports" class="mb-5 flex flex-wrap items-center gap-2">
        ${input('sig', 'sig', 20)}${input('category', 'category', 12)}${input('shell', 'shell', 10)}${input('plugin', 'plugin', 14)}
        <button class="rounded-lg bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-700">过滤</button>
        <a href="/admin/reports" class="px-2 text-sm text-slate-500 hover:underline">重置</a>
        <span class="ml-auto text-sm text-slate-400">共 ${count} 条</span>
      </form>
      ${table(['id', 'sig', 'category', 'shell', 'plugin', 'ver', 'code', 'turns', '时间'], bodyRows)}
      <div class="mt-4 flex items-center justify-center gap-2">
        ${pageLink(pageNum - 1, '← 上一页', pageNum > 1)}
        <span class="text-sm text-slate-500">第 ${pageNum} / ${pages} 页</span>
        ${pageLink(pageNum + 1, '下一页 →', pageNum < pages)}
      </div>`,
    }))
  } catch (err) {
    return errorPage(err)
  }
}

export function onRequest() {
  return new Response('method not allowed', { status: 405 })
}
