// GET /admin/tables — db9 库浏览：表清单 → 表结构 + 分页数据 → 右侧栏行详情
//
// 只读。表名先与 information_schema 实际清单比对后才入库查询（杜绝注入），
// 行定位用 Postgres 系统列 ctid（格式严格校验）。

import { esc, errorPage, guard, layout, page, sql } from './_layout.js'

const PAGE_SIZE = 20
const RE_TABLE = /^[a-z_][a-z0-9_]{0,62}$/
const RE_CTID = /^\(\d+,\d+\)$/

async function listTables(env) {
  return sql(env, `SELECT c.relname, c.reltuples::bigint
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY c.relname`)
}

function rowPanel(name, cols, row, backQs) {
  const obj = Object.fromEntries(cols.map((c, i) => [c, row[i]]))
  const fields = cols.map((c, i) => `
    <div class="border-b border-slate-100 px-4 py-2">
      <div class="text-xs text-slate-400">${esc(c)}</div>
      <div class="break-all font-mono text-xs text-slate-800">${row[i] == null ? '<span class="text-slate-300">NULL</span>' : esc(row[i])}</div>
    </div>`).join('')
  return `
  <aside class="sticky top-8 max-h-[calc(100vh-6rem)] w-96 shrink-0 overflow-y-auto rounded-xl border border-indigo-200 bg-white shadow-lg">
    <div class="flex items-center justify-between border-b border-slate-200 px-4 py-3">
      <span class="text-sm font-semibold">行详情 · ${esc(name)}</span>
      <a href="/admin/tables?${backQs}" class="rounded-lg px-2 py-1 text-sm text-slate-400 hover:bg-slate-100 hover:text-slate-700">✕</a>
    </div>
    ${fields}
    <div class="p-4">
      <div class="mb-1 text-xs font-semibold text-slate-500">JSON</div>
      <pre class="overflow-x-auto rounded-lg bg-slate-900 p-3 text-xs leading-relaxed text-slate-100">${esc(JSON.stringify(obj, null, 2))}</pre>
    </div>
  </aside>`
}

async function tableView(env, url, tableNames) {
  const name = url.searchParams.get('name')
  if (!name || !RE_TABLE.test(name) || !tableNames.includes(name)) {
    return layout({
      title: '数据库', active: 'tables',
      content: `<p class="text-slate-500">未知表。<a class="text-indigo-600 hover:underline" href="/admin/tables">返回表清单</a></p>`,
    })
  }

  const pageNum = Math.max(1, Number(url.searchParams.get('page')) || 1)
  const ctid = url.searchParams.get('ctid')

  const [colRows, [count], data] = await Promise.all([
    sql(env, `SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns WHERE table_schema='public' AND table_name='${name}' ORDER BY ordinal_position`),
    sql(env, `SELECT count(*) FROM "${name}"`).then((r) => r[0]),
    sql(env, `SELECT ctid::text, * FROM "${name}" ORDER BY ctid DESC LIMIT ${PAGE_SIZE} OFFSET ${(pageNum - 1) * PAGE_SIZE}`),
  ])
  const pages = Math.max(1, Math.ceil(count / PAGE_SIZE))
  const cols = colRows.map((c) => c[0])
  const baseQs = `name=${encodeURIComponent(name)}&page=${pageNum}`

  const structRows = colRows.map((c) => `<tr class="hover:bg-slate-50">
    <td class="px-4 py-2 font-mono text-xs">${esc(c[0])}</td>
    <td class="px-4 py-2 font-mono text-xs text-slate-500">${esc(c[1])}</td>
    <td class="px-4 py-2">${c[2] === 'YES' ? 'NULL' : 'NOT NULL'}</td>
    <td class="px-4 py-2 font-mono text-xs text-slate-400">${esc(c[3] ?? '')}</td></tr>`).join('')

  const dataRows = data.map((r) => `<tr class="hover:bg-indigo-50 ${ctid === r[0] ? 'bg-indigo-50' : ''}">
    <td class="px-3 py-2"><a href="/admin/tables?${baseQs}&ctid=${encodeURIComponent(r[0])}"
      class="rounded-md border border-slate-200 px-2 py-0.5 text-xs text-indigo-600 hover:border-indigo-400" title="查看完整行">详情</a></td>
    ${r.slice(1).map((v) => `<td class="max-w-48 truncate px-3 py-2 font-mono text-xs">${v == null ? '<span class="text-slate-300">NULL</span>' : esc(String(v).slice(0, 60))}</td>`).join('')}
  </tr>`).join('')

  const pageLink = (p, label, enabled) => enabled
    ? `<a href="/admin/tables?name=${encodeURIComponent(name)}&page=${p}" class="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm hover:bg-slate-50">${label}</a>`
    : `<span class="rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-300">${label}</span>`

  let panel = ''
  if (ctid && RE_CTID.test(ctid)) {
    const full = await sql(env, `SELECT * FROM "${name}" WHERE ctid = '${ctid}' LIMIT 1`)
    if (full.length) panel = rowPanel(name, cols, full[0], baseQs)
  }

  return layout({
    title: `表 ${name}`,
    active: 'tables',
    content: `
    <div class="mb-6 flex items-center gap-3 text-sm">
      <a href="/admin/tables" class="text-indigo-600 hover:underline">← 表清单</a>
      <span class="text-slate-400">共 ${count} 行 · ${cols.length} 列</span>
    </div>
    <div class="flex items-start gap-6">
      <div class="min-w-0 flex-1 space-y-8">
        <section>
          <h2 class="mb-3 font-semibold text-slate-900">结构</h2>
          <div class="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
            <table class="min-w-full divide-y divide-slate-200 text-sm">
              <thead class="bg-slate-50"><tr><th class="px-4 py-2.5 text-left text-xs font-semibold text-slate-500">列</th><th class="px-4 py-2.5 text-left text-xs font-semibold text-slate-500">类型</th><th class="px-4 py-2.5 text-left text-xs font-semibold text-slate-500">可空</th><th class="px-4 py-2.5 text-left text-xs font-semibold text-slate-500">默认值</th></tr></thead>
              <tbody class="divide-y divide-slate-100">${structRows}</tbody>
            </table>
          </div>
        </section>
        <section>
          <h2 class="mb-3 font-semibold text-slate-900">数据（第 ${pageNum} / ${pages} 页）</h2>
          <div class="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
            <table class="min-w-full divide-y divide-slate-200 text-sm">
              <thead class="bg-slate-50"><tr><th class="px-3 py-2.5"></th>${cols.map((c) => `<th class="px-3 py-2.5 text-left text-xs font-semibold text-slate-500">${esc(c)}</th>`).join('')}</tr></thead>
              <tbody class="divide-y divide-slate-100">${dataRows || `<tr><td colspan="${cols.length + 1}" class="px-4 py-8 text-center text-slate-400">空表</td></tr>`}</tbody>
            </table>
          </div>
          <div class="mt-4 flex items-center justify-center gap-2">
            ${pageLink(pageNum - 1, '← 上一页', pageNum > 1)}
            <span class="text-sm text-slate-500">第 ${pageNum} / ${pages} 页</span>
            ${pageLink(pageNum + 1, '下一页 →', pageNum < pages)}
          </div>
        </section>
      </div>
      ${panel}
    </div>`,
  })
}

export async function onRequestGet(context) {
  const denied = guard(context)
  if (denied) return denied
  const { request, env } = context
  if (!env.DB9_TOKEN) return new Response('DB9_TOKEN not configured', { status: 503 })

  try {
    const url = new URL(request.url)
    const tables = await listTables(env)
    const names = tables.map((t) => t[0])

    if (url.searchParams.get('name')) return page(await tableView(env, url, names))

    const rows = tables.map((t) => `<tr class="hover:bg-slate-50">
      <td class="px-4 py-3 font-mono text-sm"><a class="text-indigo-600 hover:underline" href="/admin/tables?name=${encodeURIComponent(t[0])}">${esc(t[0])}</a></td>
      <td class="px-4 py-3 text-right text-slate-500">${t[1] < 0 ? '—' : `≈ ${t[1]}`}</td>
      <td class="px-4 py-3"><a href="/admin/tables?name=${encodeURIComponent(t[0])}" class="text-sm text-indigo-600 hover:underline">结构与数据 →</a></td></tr>`).join('')

    return page(layout({
      title: '数据库',
      active: 'tables',
      content: `
      <p class="mb-4 text-sm text-slate-500">db9 库 <code class="rounded bg-slate-200 px-1.5 py-0.5 text-xs">dsh-crash</code>（public schema，只读视图；行数为优化器估算）</p>
      <div class="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <table class="min-w-full divide-y divide-slate-200 text-sm">
          <thead class="bg-slate-50"><tr><th class="px-4 py-3 text-left text-xs font-semibold text-slate-500">表</th><th class="px-4 py-3 text-right text-xs font-semibold text-slate-500">行数（估算）</th><th class="px-4 py-3"></th></tr></thead>
          <tbody class="divide-y divide-slate-100">${rows}</tbody>
        </table>
      </div>`,
    }))
  } catch (err) {
    return errorPage(err)
  }
}

export function onRequest() {
  return new Response('method not allowed', { status: 405 })
}
