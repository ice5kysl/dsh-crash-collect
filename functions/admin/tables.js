// GET /admin/tables — db9 库浏览（三栏）：侧边导航 | 表清单 | 多 tab 面板（结构/数据）→ 右侧抽屉行详情
//
// 只读。表名先与 information_schema 实际清单比对后才入库查询（杜绝注入）。
// 行定位：db9 是 TiKV 底座，没有 ctid —— 优先用主键，无 PK 的表退化为 OFFSET 序号。
// 深链：?table=plugins&tab=data&page=2&row=<pk>

import { esc, errorPage, guard, layout, page, sql } from './_layout.js'

const PAGE_SIZE = 20
const RE_TABLE = /^[a-z_][a-z0-9_]{0,62}$/
const RE_ROWKEY = /^[a-zA-Z0-9._:@/+-]{1,128}$/
const TABS = [
  ['struct', '结构'],
  ['data', '数据'],
]

async function listTables(env) {
  return sql(env, `SELECT c.relname, c.reltuples::bigint
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY c.relname`)
}

function tableList(tables, active) {
  const items = tables.map((t) => {
    const on = t[0] === active
    return `<a href="/admin/tables?table=${encodeURIComponent(t[0])}"
      class="flex items-baseline justify-between gap-2 rounded-lg px-3 py-1.5 text-sm transition ${
        on ? 'bg-indigo-600 text-white' : 'text-slate-600 hover:bg-slate-200/70'
      }"><span class="truncate font-mono text-xs">${esc(t[0])}</span><span class="shrink-0 text-xs ${on ? 'text-indigo-200' : 'text-slate-400'}">${t[1] < 0 ? '—' : `≈${t[1]}`}</span></a>`
  }).join('')
  return `
  <div class="sticky top-8 max-h-[calc(100vh-6rem)] w-52 shrink-0 overflow-y-auto rounded-xl border border-slate-200 bg-white p-2 shadow-sm">
    <div class="px-3 pb-2 pt-1 text-xs font-semibold text-slate-400">表清单（${tables.length}）</div>
    <div class="flex flex-col gap-0.5">${items}</div>
  </div>`
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

async function tablePanel(env, url, name) {
  const tab = TABS.some(([k]) => k === url.searchParams.get('tab')) ? url.searchParams.get('tab') : 'struct'
  const pageNum = Math.max(1, Number(url.searchParams.get('page')) || 1)
  const rowKey = url.searchParams.get('row')

  const pkRows = await sql(env, `SELECT kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema AND tc.table_name = kcu.table_name
    WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = 'public' AND tc.table_name = '${name}'
    ORDER BY kcu.ordinal_position LIMIT 1`)
  const pk = pkRows.length ? pkRows[0][0] : null
  const orderCol = pk ?? '1'

  const colRows = await sql(env, `SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns WHERE table_schema='public' AND table_name='${name}' ORDER BY ordinal_position`)
  const cols = colRows.map((c) => c[0])
  const pkIdx = pk ? cols.indexOf(pk) : -1
  const baseQs = `table=${encodeURIComponent(name)}&tab=${tab}&page=${pageNum}`

  const tabBar = `<div class="mb-4 flex items-center gap-1 border-b border-slate-200">${TABS.map(([k, label]) => {
    const on = k === tab
    return `<a href="/admin/tables?table=${encodeURIComponent(name)}&tab=${k}"
      class="-mb-px border-b-2 px-4 py-2 text-sm font-medium ${on ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-700'}">${label}</a>`
  }).join('')}</div>`

  let body = ''
  let panel = ''

  if (tab === 'struct') {
    const structRows = colRows.map((c) => `<tr class="hover:bg-slate-50">
      <td class="px-4 py-2 font-mono text-xs">${esc(c[0])}</td>
      <td class="px-4 py-2 font-mono text-xs text-slate-500">${esc(c[1])}</td>
      <td class="px-4 py-2">${c[2] === 'YES' ? 'NULL' : 'NOT NULL'}</td>
      <td class="px-4 py-2 font-mono text-xs text-slate-400">${esc(c[3] ?? '')}</td></tr>`).join('')
    body = `
      <div class="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <table class="min-w-full divide-y divide-slate-200 text-sm">
          <thead class="bg-slate-50"><tr><th class="px-4 py-2.5 text-left text-xs font-semibold text-slate-500">列</th><th class="px-4 py-2.5 text-left text-xs font-semibold text-slate-500">类型</th><th class="px-4 py-2.5 text-left text-xs font-semibold text-slate-500">可空</th><th class="px-4 py-2.5 text-left text-xs font-semibold text-slate-500">默认值</th></tr></thead>
          <tbody class="divide-y divide-slate-100">${structRows}</tbody>
        </table>
      </div>`
  } else {
    const [[count], data] = await Promise.all([
      sql(env, `SELECT count(*) FROM "${name}"`).then((r) => r[0]),
      sql(env, `SELECT * FROM "${name}" ORDER BY ${orderCol} DESC LIMIT ${PAGE_SIZE} OFFSET ${(pageNum - 1) * PAGE_SIZE}`),
    ])
    const pages = Math.max(1, Math.ceil(count / PAGE_SIZE))

    const dataRows = data.map((r, i) => {
      const key = pk ? String(r[pkIdx]) : String((pageNum - 1) * PAGE_SIZE + i)
      return `<tr class="hover:bg-indigo-50 ${rowKey === key ? 'bg-indigo-50' : ''}">
      <td class="px-3 py-2"><a href="/admin/tables?${baseQs}&row=${encodeURIComponent(key)}"
        class="rounded-md border border-slate-200 px-2 py-0.5 text-xs text-indigo-600 hover:border-indigo-400" title="查看完整行">详情</a></td>
      ${r.map((v) => `<td class="max-w-48 truncate px-3 py-2 font-mono text-xs">${v == null ? '<span class="text-slate-300">NULL</span>' : esc(String(v).slice(0, 60))}</td>`).join('')}
    </tr>` }).join('')

    const pageLink = (p, label, enabled) => enabled
      ? `<a href="/admin/tables?table=${encodeURIComponent(name)}&tab=data&page=${p}" class="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm hover:bg-slate-50">${label}</a>`
      : `<span class="rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-300">${label}</span>`

    body = `
      <div class="mb-2 text-sm text-slate-400">共 ${count} 行 · 第 ${pageNum} / ${pages} 页</div>
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
      </div>`

    if (rowKey && RE_ROWKEY.test(rowKey)) {
      const full = pk
        ? await sql(env, `SELECT * FROM "${name}" WHERE "${pk}" = '${rowKey}' LIMIT 1`)
        : await sql(env, `SELECT * FROM "${name}" ORDER BY ${orderCol} DESC LIMIT 1 OFFSET ${Number(rowKey) || 0}`)
      if (full.length) panel = rowPanel(name, cols, full[0], baseQs)
    }
  }

  return { body: `${tabBar}${body}`, panel }
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

    let main = `
      <div class="flex h-full items-center justify-center rounded-xl border border-dashed border-slate-300 p-16 text-sm text-slate-400">
        从左侧选择一张表查看结构与数据
      </div>`
    let panel = ''
    const name = url.searchParams.get('table')
    if (name && RE_TABLE.test(name) && names.includes(name)) {
      const view = await tablePanel(env, url, name)
      main = view.body
      panel = view.panel
    } else if (name) {
      main = `<div class="rounded-xl border border-slate-200 bg-white p-8 text-sm text-slate-500 shadow-sm">未知表 <code class="font-mono">${esc(name)}</code>，请从左侧表清单选择。</div>`
    }

    return page(layout({
      title: '表浏览',
      active: 'tables',
      content: `
      <p class="mb-4 text-sm text-slate-500">db9 库 <code class="rounded bg-slate-200 px-1.5 py-0.5 text-xs">dsh-data</code>（public schema，只读视图；表清单行数为优化器估算）</p>
      <div class="flex items-start gap-6">
        ${tableList(tables, name)}
        <div class="min-w-0 flex-1">${main}</div>
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
