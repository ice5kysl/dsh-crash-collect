// GET /admin/traffic — 站点访问：Umami(dsh-insights.com + dsh-why.com，按 hostname 拆) 的滚动窗口快照
// 数据来自共享 dsh-data 库的 site_traffic 表（每日一行，最新一行即当前视图）。
// 刻意不写入公开仓库，本页是唯一展示入口。

import { badge, card, esc, errorPage, guard, layout, page, sql, table } from './_layout.js'

const SOURCES = [
  { key: 'umami', label: 'Umami（两站合计）', note: 'dsh-insights.com + dsh-why.com 共用一个 website，下方按域名拆开', tone: 'green' },
  { key: 'ga4', label: 'GA4（历史来源）', note: 'dsh-why.com 2026-09-13 起改用 Umami，此处只会有旧快照', tone: 'sky' },
]

const COLS = 'date, window_days, visitors, pageviews, sessions, bounces, avg_duration, daily, top_paths, referrers, countries, hostnames, collected_at'

// db9 报「表不存在 / 关系未定义」时走友好空状态，而不是把错误信息当堆栈抛给用户
const MISSING_RE = /does not exist|doesn't exist|no such table|undefined table|unknown relation|unknown table/i

const SETUP_CMD = 'DB9_TOKEN=… UMAMI_SHARE=<share-url> node bin/traffic-sync.mjs'

const fmtInt = (v) => {
  if (v == null || v === '') return '<span class="text-slate-300">—</span>'
  return Number.isFinite(Number(v)) ? Number(v).toLocaleString('en-US') : esc(v)
}

const fmtDuration = (sec) => {
  if (sec == null || sec === '') return '<span class="text-slate-300">—</span>'
  const n = Number(sec)
  if (!Number.isFinite(n) || n < 0) return esc(sec)
  const s = Math.round(n)
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`
}

// 跳出率：bounces/sessions，GA4 无 bounces → —
const fmtBounce = (bounces, sessions) => {
  if (bounces == null || sessions == null) return '<span class="text-slate-300">—</span>'
  const b = Number(bounces)
  const s = Number(sessions)
  if (!Number.isFinite(b) || !Number.isFinite(s) || s <= 0) return '<span class="text-slate-300">—</span>'
  return `${((b / s) * 100).toFixed(1)}%`
}

// 时间戳统一成 YYYY-MM-DD HH:MM
const fmtStamp = (ts) => (ts == null ? '—' : esc(String(ts).replace('T', ' ').slice(0, 16)))
const fmtDay = (d) => (d == null ? '—' : esc(String(d).slice(0, 10)))

// JSONB 可能是已解码的数组，也可能是 JSON 字符串；坏值一律退化为 []
function parseList(v) {
  if (Array.isArray(v)) return v
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }
  return []
}

const truncate = (s, n = 44) => {
  const t = String(s ?? '')
  return t.length > n ? `${t.slice(0, n)}…` : t
}

// 无快照 / 表缺失时的引导卡片：告诉运维在 dsh-insights 仓库跑同步脚本
function setupCard(reason = '') {
  return `
  <div class="rounded-xl border border-dashed border-slate-300 bg-white p-6 shadow-sm">
    <div class="text-sm font-semibold text-slate-900">暂无站点访问数据</div>
    <p class="mt-2 text-sm text-slate-500">db9 的 <code class="rounded bg-slate-100 px-1 font-mono text-xs">site_traffic</code> 表还没有可用快照。该表由 dsh-insights 仓库的同步脚本写入，每天一行滚动窗口。</p>
    <p class="mt-4 text-sm text-slate-500">在 dsh-insights 仓库运行：</p>
    <pre class="mt-2 overflow-x-auto rounded-lg bg-slate-900 p-3 font-mono text-xs leading-relaxed text-slate-100">${esc(SETUP_CMD)}</pre>
    <p class="mt-3 text-xs text-slate-400">同步完成后刷新本页。${reason ? `（${esc(reason)}）` : ''}</p>
  </div>`
}

// 按天柱状：纯 inline style 宽度，不依赖任何 JS 库
function dailyBars(daily) {
  const items = parseList(daily)
    .filter((d) => d && typeof d === 'object')
    .map((d) => ({ date: String(d.date ?? ''), pageviews: Number(d.pageviews) || 0 }))
    .sort((a, b) => a.date.localeCompare(b.date))
  if (!items.length) return '<div class="px-1 py-6 text-center text-sm text-slate-400">暂无数据</div>'

  const max = items.reduce((m, d) => Math.max(m, d.pageviews), 0)
  const peak = max.toLocaleString('en-US')
  const rows = items.map((d) => {
    const pct = max > 0 ? Math.round((d.pageviews / max) * 100) : 0
    const width = d.pageviews > 0 ? Math.max(pct, 1) : 0
    return `<div class="flex items-center gap-3">
      <span class="w-20 shrink-0 font-mono text-xs text-slate-500">${esc(d.date.slice(0, 10))}</span>
      <div class="h-2 min-w-0 flex-1 rounded-full bg-slate-100"><div class="h-2 rounded-full bg-indigo-500" style="width:${width}%"></div></div>
      <span class="w-16 shrink-0 text-right text-xs font-semibold text-slate-700">${d.pageviews.toLocaleString('en-US')}</span>
    </div>`
  }).join('')
  return `<div class="mb-3 text-xs text-slate-400">共 ${items.length} 天 · 峰值 ${peak} 次/天</div>
    <div class="space-y-1.5">${rows}</div>`
}

function sourceSection(src, row) {
  if (!row) {
    return `<div class="mb-8 rounded-xl border border-dashed border-slate-300 bg-slate-50 p-5 text-sm text-slate-400">
      <span class="font-medium text-slate-500">${esc(src.label)}</span> · 尚未接入
      <span class="ml-2 text-xs">（${esc(src.note)}，快照表里还没有它的行）</span>
    </div>`
  }

  const [date, windowDays, visitors, pageviews, sessions, bounces, avgDuration, daily, topPaths, referrers, countries, hostnames, collectedAt] = row

  const paths = parseList(topPaths).filter((x) => x && typeof x === 'object')
  const refs = parseList(referrers).filter((x) => x && typeof x === 'object')
  const geos = parseList(countries).filter((x) => x && typeof x === 'object')
  const hosts = parseList(hostnames).filter((x) => x && typeof x === 'object')

  const hostRows = hosts.map((h) => `<tr class="hover:bg-slate-50">
    <td class="px-4 py-2.5 font-mono text-xs">${esc(truncate(h.host ?? '—', 32))}</td>
    <td class="px-4 py-2.5 text-right font-semibold">${fmtInt(h.visitors)}</td></tr>`).join('')

  const pathRows = paths.map((p) => `<tr class="hover:bg-slate-50">
    <td class="px-4 py-2.5 font-mono text-xs" title="${esc(p.path ?? '')}">${esc(truncate(p.path ?? '—'))}</td>
    <td class="px-4 py-2.5 text-right font-semibold">${fmtInt(p.pageviews)}</td></tr>`).join('')

  const refRows = refs.map((r) => `<tr class="hover:bg-slate-50">
    <td class="px-4 py-2.5 text-xs" title="${esc(r.referrer ?? '')}">${esc(truncate(r.referrer ?? '—', 32))}</td>
    <td class="px-4 py-2.5 text-right font-semibold">${fmtInt(r.sessions)}</td></tr>`).join('')

  const geoRows = geos.map((c) => `<tr class="hover:bg-slate-50">
    <td class="px-4 py-2.5 text-xs">${esc(truncate(c.country ?? '—', 32))}</td>
    <td class="px-4 py-2.5 text-right font-semibold">${fmtInt(c.sessions)}</td></tr>`).join('')

  return `<section class="mb-10">
    <div class="mb-1 flex flex-wrap items-center gap-2">
      <h2 class="text-lg font-semibold text-slate-900">${esc(src.label)}</h2>
      ${badge(src.key, src.tone)}
    </div>
    <p class="mb-4 text-sm text-slate-500">快照 ${fmtDay(date)} · 窗口 ${fmtInt(windowDays)} 天 · 采集于 ${fmtStamp(collectedAt)}</p>

    <div class="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
      ${card('访客', fmtInt(visitors), `${esc(src.note)} · 窗口内去重`)}
      ${card('浏览量', fmtInt(pageviews), 'pageviews')}
      ${card('会话', fmtInt(sessions), 'sessions')}
      ${card('跳出率', fmtBounce(bounces, sessions), 'bounces / sessions')}
      ${card('平均停留', fmtDuration(avgDuration), '每次会话')}
    </div>

    <section class="mb-6">
      <h3 class="mb-3 font-semibold text-slate-900">按天</h3>
      <div class="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">${dailyBars(daily)}</div>
    </section>

    <div class="grid grid-cols-1 gap-4 lg:grid-cols-2 2xl:grid-cols-4">
      <div class="min-w-0"><h3 class="mb-3 font-semibold text-slate-900">域名 Top</h3>${table(['域名', '访客'], hostRows)}</div>
      <div class="min-w-0"><h3 class="mb-3 font-semibold text-slate-900">页面 Top</h3>${table(['路径', '浏览量'], pathRows)}</div>
      <div class="min-w-0"><h3 class="mb-3 font-semibold text-slate-900">来源 Top</h3>${table(['来源', '会话'], refRows)}</div>
      <div class="min-w-0"><h3 class="mb-3 font-semibold text-slate-900">国家 Top</h3>${table(['国家', '会话'], geoRows)}</div>
    </div>
  </section>`
}

export async function onRequestGet(context) {
  const denied = guard(context)
  if (denied) return denied
  const { env } = context
  if (!env.DB9_TOKEN) return new Response('DB9_TOKEN not configured', { status: 503 })

  const friendly = (reason) => page(layout({ title: '站点访问', active: 'traffic', content: setupCard(reason) }))

  try {
    const settled = await Promise.allSettled(
      SOURCES.map((s) => sql(env, `SELECT ${COLS} FROM site_traffic WHERE source = '${s.key}' ORDER BY date DESC LIMIT 1`)),
    )
    const errors = settled.filter((r) => r.status === 'rejected').map((r) => r.reason)
    const rows = settled.map((r) => (r.status === 'fulfilled' && Array.isArray(r.value) ? r.value[0] : null))

    // 表缺失（db9 报 does not exist）→ 友好空状态，而不是把错误当堆栈抛出来
    if (errors.some((e) => MISSING_RE.test(String(e?.message ?? e)))) return friendly('site_traffic 表不存在')
    // 有查询真失败且没拿到任何行 → 仍然报存储不可用
    if (errors.length && !rows.some(Boolean)) return errorPage(errors[0])
    // 表存在但一行都没有：同样是「还没同步过」
    if (!rows.some(Boolean)) return friendly()

    const content = `
      ${rows.map((row, i) => sourceSection(SOURCES[i], row)).join('')}
      <p class="mt-8 text-xs text-slate-400">数据来自 Umami 公开分享链接与 GA4 Data API，仅存于 db9，不写入公开仓库。每天一份滚动窗口快照，最新一份即当前视图。</p>`

    return page(layout({ title: '站点访问', active: 'traffic', content }))
  } catch (err) {
    if (MISSING_RE.test(String(err?.message ?? err))) return friendly('site_traffic 表不存在')
    return errorPage(err)
  }
}

export function onRequest() {
  return new Response('method not allowed', { status: 405 })
}
