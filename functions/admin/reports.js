// GET /admin/reports — 上报明细：组合过滤 + 分页；?id=N 右侧抽屉展示完整记录

import { badge, esc, errorPage, guard, layout, page, RE_FILTER, sql, table } from './_layout.js'

const PAGE_SIZE = 50
const FIELDS = ['id', 'sig', 'category', 'shell', 'plugin', 'plugin_ver', 'code', 'turns', 'created_at']

function drawer(id, row, backQs) {
  const obj = Object.fromEntries(FIELDS.map((f, i) => [f, row[i]]))
  const fields = FIELDS.map((f, i) => `
    <div class="border-b border-slate-100 px-4 py-2">
      <div class="text-xs text-slate-400">${f}</div>
      <div class="break-all font-mono text-xs text-slate-800">${f === 'sig'
        ? `<a class="text-indigo-600 hover:underline" href="/admin/signatures?sig=${encodeURIComponent(row[i])}">${esc(row[i])}</a>`
        : (row[i] == null || row[i] === '' ? '<span class="text-slate-300">—</span>' : esc(row[i]))}</div>
    </div>`).join('')
  return `
  <aside class="sticky top-8 max-h-[calc(100vh-6rem)] w-96 shrink-0 overflow-y-auto rounded-xl border border-indigo-200 bg-white shadow-lg">
    <div class="flex items-center justify-between border-b border-slate-200 px-4 py-3">
      <span class="text-sm font-semibold">上报 #${id}</span>
      <a href="/admin/reports?${backQs}" class="rounded-lg px-2 py-1 text-sm text-slate-400 hover:bg-slate-100 hover:text-slate-700">✕</a>
    </div>
    ${fields}
    <div class="p-4">
      <div class="mb-1 text-xs font-semibold text-slate-500">原始记录（JSON）</div>
      <pre class="overflow-x-auto rounded-lg bg-slate-900 p-3 text-xs leading-relaxed text-slate-100">${esc(JSON.stringify(obj, null, 2))}</pre>
      <p class="mt-2 text-xs text-slate-400">入库前已通过白名单校验：只有结构化字段，绝不含消息文本、文件路径或 prompt。</p>
    </div>
  </aside>`
}

export async function onRequestGet(context) {
  const denied = guard(context)
  if (denied) return denied
  const { request, env } = context
  if (!env.DB9_TOKEN) return new Response('DB9_TOKEN not configured', { status: 503 })

  const url = new URL(request.url)
  const id = Number(url.searchParams.get('id'))
  const q = Object.fromEntries(
    ['sig', 'category', 'shell', 'plugin']
      .map((k) => [k, url.searchParams.get(k)])
      .filter(([, v]) => v && RE_FILTER.test(v)),
  )
  const conds = Object.entries(q).map(([k, v]) => `${k} = '${v}'`)
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
  const pageNum = Math.max(1, Number(url.searchParams.get('page')) || 1)
  const qs = new URLSearchParams(q)

  try {
    const [[count], rows] = await Promise.all([
      sql(env, `SELECT count(*) FROM reports ${where}`).then((r) => r[0]),
      sql(env, `SELECT id, sig, category, shell, plugin, plugin_ver, code, turns, created_at
                FROM reports ${where} ORDER BY id DESC LIMIT ${PAGE_SIZE} OFFSET ${(pageNum - 1) * PAGE_SIZE}`),
    ])
    const pages = Math.max(1, Math.ceil(count / PAGE_SIZE))

    const bodyRows = rows.map((r) => `<tr class="hover:bg-indigo-50 ${id === Number(r[0]) ? 'bg-indigo-50' : ''}">
      <td class="px-4 py-2.5"><a class="text-indigo-600 hover:underline" href="/admin/reports?${qs}&id=${r[0]}">#${r[0]}</a></td>
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

    let panel = ''
    if (Number.isInteger(id) && id > 0) {
      const full = await sql(env, `SELECT ${FIELDS.join(', ')} FROM reports WHERE id = ${id} LIMIT 1`)
      panel = full.length
        ? drawer(id, full[0], qs.toString())
        : `<div class="w-96 shrink-0 rounded-xl border border-slate-200 bg-white p-5 text-sm text-slate-500 shadow-sm">记录 #${id} 不存在。</div>`
    }

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
      <div class="flex items-start gap-6">
        <div class="min-w-0 flex-1">
          ${table(['id', 'sig', 'category', 'shell', 'plugin', 'ver', 'code', 'turns', '时间'], bodyRows)}
          <div class="mt-4 flex items-center justify-center gap-2">
            ${pageLink(pageNum - 1, '← 上一页', pageNum > 1)}
            <span class="text-sm text-slate-500">第 ${pageNum} / ${pages} 页</span>
            ${pageLink(pageNum + 1, '下一页 →', pageNum < pages)}
          </div>
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
