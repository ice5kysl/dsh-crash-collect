// GET /admin/events — 生态事件时间线：按 occurred_at 倒序，按 type 过滤；?type=&key= 右侧抽屉看 payload

import { badge, drawer, esc, errorPage, field, guard, jsonBlock, layout, page, sql, table } from './_layout.js'

const PAGE_SIZE = 50

const TYPE_TONE = {
  shell_release: 'indigo',
  npm_publish: 'green',
  platform_release: 'amber',
  api_model_first_seen: 'red',
}

const sqlStr = (v) => `'${String(v).replace(/'/g, "''")}'`

export async function onRequestGet(context) {
  const denied = guard(context)
  if (denied) return denied
  const { request, env } = context
  if (!env.DB9_TOKEN) return new Response('DB9_TOKEN not configured', { status: 503 })

  const url = new URL(request.url)
  const pageNum = Math.max(1, Number(url.searchParams.get('page')) || 1)
  const selType = url.searchParams.get('type') ?? ''
  const selKey = url.searchParams.get('key') ?? ''

  try {
    const typeRows = await sql(env, 'SELECT DISTINCT type FROM ecosystem_events ORDER BY 1')
    const types = typeRows.map((r) => r[0])
    // type 同时是过滤条件与抽屉选择器（点行时该行的 type 即成为过滤值）
    const type = types.includes(url.searchParams.get('type')) ? url.searchParams.get('type') : ''

    const where = type ? `WHERE type = ${sqlStr(type)}` : ''
    const [[count], rows] = await Promise.all([
      sql(env, `SELECT count(*) FROM ecosystem_events ${where}`).then((r) => r[0]),
      sql(env, `SELECT type, key, occurred_at, payload FROM ecosystem_events ${where}
                ORDER BY occurred_at DESC LIMIT ${PAGE_SIZE} OFFSET ${(pageNum - 1) * PAGE_SIZE}`),
    ])
    const pages = Math.max(1, Math.ceil(count / PAGE_SIZE))

    const qs = new URLSearchParams()
    if (type) qs.set('type', type)

    const payloadPreview = (p) => {
      const s = typeof p === 'string' ? p : JSON.stringify(p)
      return esc((s ?? '').slice(0, 60))
    }

    const bodyRows = rows.map((r) => {
      const on = selType === r[0] && selKey === r[1]
      return `<tr class="hover:bg-indigo-50 ${on ? 'bg-indigo-50' : ''}">
      <td class="px-4 py-2.5 text-slate-400">${esc(String(r[2]).slice(0, 19))}</td>
      <td class="px-4 py-2.5">${badge(r[0], TYPE_TONE[r[0]])}</td>
      <td class="px-4 py-2.5"><a class="font-mono text-xs text-indigo-600 hover:underline"
        href="/admin/events?${qs}&type=${encodeURIComponent(r[0])}&key=${encodeURIComponent(r[1])}">${esc(r[1])}</a></td>
      <td class="max-w-96 truncate px-4 py-2.5 font-mono text-xs text-slate-400">${payloadPreview(r[3])}</td></tr>`
    }).join('')

    const typeOpts = `<option value="">全部类型</option>` +
      types.map((t) => `<option value="${esc(t)}" ${t === type ? 'selected' : ''}>${esc(t)}</option>`).join('')

    const pageLink = (p, label, enabled) => enabled
      ? `<a href="/admin/events?${qs}&page=${p}" class="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm hover:bg-slate-50">${label}</a>`
      : `<span class="rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-300">${label}</span>`

    let panel = ''
    if (selType && selKey) {
      const full = await sql(env, `SELECT type, key, occurred_at, first_seen, payload FROM ecosystem_events
                                   WHERE type = ${sqlStr(selType)} AND key = ${sqlStr(selKey)} LIMIT 1`)
      if (full.length) {
        const r = full[0]
        let payload = r[4]
        if (typeof payload === 'string') { try { payload = JSON.parse(payload) } catch { /* 原样展示 */ } }
        panel = drawer(
          `事件 · ${esc(r[0])}`,
          `/admin/events?${qs}&page=${pageNum}`,
          field('type', badge(r[0], TYPE_TONE[r[0]])) +
          field('key', esc(r[1])) +
          field('occurred_at', esc(String(r[2]).slice(0, 19))) +
          field('first_seen', esc(String(r[3]).slice(0, 19))) +
          `<div class="p-4"><div class="mb-1 text-xs font-semibold text-slate-500">payload</div>${jsonBlock(payload)}</div>`,
        )
      } else {
        panel = `<div class="w-96 shrink-0 rounded-xl border border-slate-200 bg-white p-5 text-sm text-slate-500 shadow-sm">事件不存在。</div>`
      }
    }

    return page(layout({
      title: '事件',
      active: 'events',
      content: `
      <form method="get" action="/admin/events" class="mb-5 flex flex-wrap items-center gap-2">
        <select name="type" class="rounded-lg border border-slate-300 px-2 py-1.5 text-sm">${typeOpts}</select>
        <button class="rounded-lg bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-700">过滤</button>
        <a href="/admin/events" class="px-2 text-sm text-slate-500 hover:underline">重置</a>
        <span class="ml-auto text-sm text-slate-400">共 ${count} 条事件</span>
      </form>
      <div class="flex items-start gap-6">
        <div class="min-w-0 flex-1">
          ${table(['时间', '类型', 'key', 'payload 预览'], bodyRows)}
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
