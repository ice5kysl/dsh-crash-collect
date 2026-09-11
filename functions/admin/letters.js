// GET /admin/letters — 生态周报：week/range/model/token 用量列表；?week= 右侧抽屉看 extra

import { badge, drawer, esc, errorPage, field, guard, jsonBlock, layout, page, sql, table } from './_layout.js'

const sqlStr = (v) => `'${String(v).replace(/'/g, "''")}'`

const parseJson = (v) => {
  if (v == null || typeof v !== 'string') return v
  try { return JSON.parse(v) } catch { return v }
}

const fmtTokens = (usage) => {
  const u = parseJson(usage)
  if (!u || typeof u !== 'object') return '<span class="text-slate-300">—</span>'
  return `${u.total_tokens ?? '—'}<span class="ml-1 text-xs text-slate-400">(入 ${u.prompt_tokens ?? '—'} / 出 ${u.completion_tokens ?? '—'})</span>`
}

export async function onRequestGet(context) {
  const denied = guard(context)
  if (denied) return denied
  const { request, env } = context
  if (!env.DB9_TOKEN) return new Response('DB9_TOKEN not configured', { status: 503 })

  const url = new URL(request.url)
  const selWeek = url.searchParams.get('week') ?? ''

  try {
    const rows = await sql(env, 'SELECT week, range, generated_at, model, usage FROM weekly_letters ORDER BY week DESC')

    const bodyRows = rows.map((r) => `<tr class="hover:bg-indigo-50 ${selWeek === r[0] ? 'bg-indigo-50' : ''}">
      <td class="px-4 py-2.5"><a class="font-mono text-xs font-semibold text-indigo-600 hover:underline" href="/admin/letters?week=${encodeURIComponent(r[0])}">${esc(r[0])}</a></td>
      <td class="px-4 py-2.5 text-xs">${esc(r[1] ?? '—')}</td>
      <td class="px-4 py-2.5">${r[3] ? badge(r[3], 'indigo') : ''}</td>
      <td class="px-4 py-2.5 text-right font-mono text-xs">${fmtTokens(r[4])}</td>
      <td class="px-4 py-2.5 text-slate-400">${esc(String(r[2]).slice(0, 19))}</td></tr>`).join('')

    let panel = ''
    if (selWeek) {
      const full = await sql(env, `SELECT week, range, generated_at, model, usage, extra FROM weekly_letters
                                   WHERE week = ${sqlStr(selWeek)} LIMIT 1`)
      if (full.length) {
        const r = full[0]
        panel = drawer(
          `周报 · ${esc(r[0])}`,
          '/admin/letters',
          field('week', esc(r[0])) +
          field('range', esc(r[1] ?? '—')) +
          field('generated_at', esc(String(r[2]).slice(0, 19))) +
          field('model', esc(r[3] ?? '—')) +
          `<div class="p-4"><div class="mb-1 text-xs font-semibold text-slate-500">usage</div>${jsonBlock(parseJson(r[4]) ?? null)}</div>` +
          `<div class="p-4 pt-0"><div class="mb-1 text-xs font-semibold text-slate-500">extra</div>${jsonBlock(parseJson(r[5]) ?? null)}</div>`,
          'w-[36rem]',
        )
      } else {
        panel = `<div class="w-[36rem] max-w-[90vw] shrink-0 rounded-xl border border-slate-200 bg-white p-5 text-sm text-slate-500 shadow-sm">周报 ${esc(selWeek)} 不存在。</div>`
      }
    }

    return page(layout({
      title: '周报',
      active: 'letters',
      content: `
      <p class="mb-4 text-sm text-slate-500">dsh-insights 生成的生态周报，共 ${rows.length} 期。</p>
      <div class="flex items-start gap-6">
        <div class="min-w-0 flex-1">
          ${table(['week', 'range', 'model', 'token 用量', '生成时间'], bodyRows)}
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
