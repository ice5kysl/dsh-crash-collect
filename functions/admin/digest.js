// GET /admin/digest — 运营速览（按天视图）：?date=YYYY-MM-DD，默认最新有数据的一天
//
// 区块：当日流量（site_traffic 快照 + daily 高亮当天的小柱图）、当日事件流（主菜）、
// 当日上报、当日大盘（score_runs ± 前一天）、内容产出（weekly_letters，周一才有）、
// 底部「滚动窗口参考」（UTM 来源 + 最近一周下载 Top，28 天/周窗口口径，不适合按天）。
// 纪律：日期集合与各区块全部独立小查询、Promise.all 并行、safe() 空态。

import { badge, card, esc, errorPage, guard, layout, page, sql, table } from './_layout.js'
import { TYPE_TONE, parsePayload, summary as eventSummary } from './events.js'

const safe = (p) => p.catch(() => [])

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)
const fmtDay = (d) => String(d ?? '').slice(0, 10)
const fmtTime = (t) => String(t ?? '').slice(11, 16)

function parseJson(v, fallback) {
  if (v == null) return fallback
  if (typeof v === 'object') return v
  try { return JSON.parse(v) ?? fallback } catch { return fallback }
}

const RE_DATE = /^\d{4}-\d{2}-\d{2}$/
const HOST_LABEL = { '': '两站合计' }
const hostLabel = (h) => HOST_LABEL[h] ?? h

const fmtBounce = (bounces, sessions) => {
  const b = num(bounces)
  const s = num(sessions)
  return s > 0 ? `${((b / s) * 100).toFixed(1)}%` : '—'
}
const fmtDuration = (sec) => {
  const s = Math.round(num(sec))
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`
}

// 近 7 天小柱图，D 当天那根高亮（纯 CSS，沿用 plugins 抽屉做法）
function miniBars(daily7, date) {
  const max = daily7.reduce((m, d) => Math.max(m, num(d.pageviews)), 0)
  const bars = daily7.map((d) => {
    const v = num(d.pageviews)
    const h = max > 0 ? Math.max(2, Math.round((v / max) * 56)) : 2
    const on = fmtDay(d.date) === date
    return `<div class="flex min-w-0 flex-1 flex-col items-center justify-end gap-0.5" title="${esc(fmtDay(d.date))} · ${v.toLocaleString('en-US')} 浏览">
      <div class="text-[10px] font-semibold leading-none ${on ? 'text-indigo-700' : 'text-slate-500'}">${v.toLocaleString('en-US')}</div>
      <div class="w-full rounded-sm ${on ? 'bg-indigo-600' : 'bg-indigo-300'}" style="height:${h}px"></div>
      <div class="text-[10px] leading-none ${on ? 'font-semibold text-indigo-700' : 'text-slate-400'}">${esc(fmtDay(d.date).slice(8))}</div>
    </div>`
  }).join('')
  return `<div class="flex h-20 items-end gap-1">${bars}</div>`
}

function trafficCard(row, date) {
  const [hostname, , visitors, pageviews, sessions, bounces, avgDuration, dailyRaw] = row
  const daily = (Array.isArray(parseJson(dailyRaw, [])) ? parseJson(dailyRaw, []) : [])
    .filter((d) => d && typeof d === 'object')
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
  const last7 = daily.slice(-7)
  return `
  <div class="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
    <div class="mb-2 font-mono text-sm font-semibold text-slate-900">${esc(hostLabel(hostname))}</div>
    <div class="mb-3 grid grid-cols-3 gap-2 text-center">
      ${[['访客', num(visitors).toLocaleString('en-US')], ['浏览', num(pageviews).toLocaleString('en-US')], ['会话', num(sessions).toLocaleString('en-US')],
         ['跳出率', fmtBounce(bounces, sessions)], ['平均停留', fmtDuration(avgDuration)], ['窗口天数', last7.length ? `${last7.length} 天` : '—']]
        .map(([k, v]) => `<div class="rounded-lg bg-slate-50 px-1 py-2"><div class="text-sm font-bold text-slate-900">${v}</div><div class="text-xs text-slate-400">${k}</div></div>`).join('')}
    </div>
    ${last7.length ? miniBars(last7, date) : '<div class="py-4 text-center text-xs text-slate-400">暂无按天数据</div>'}
    <div class="mt-2 text-xs text-slate-400">快照口径为截至当日的滚动窗口（非当日单日）</div>
  </div>`
}

const UTM_DIMS = [['utmSource', '来源'], ['utmMedium', '媒介'], ['utmCampaign', '活动']]

function utmBlock(hostname, breakdowns) {
  const b = parseJson(breakdowns, {})
  const parts = UTM_DIMS.map(([key, label]) => {
    const rows = parseJson(b?.[key]?.rows, [])
    if (!Array.isArray(rows) || !rows.length) return ''
    const items = rows.map((r) => `<span class="mr-2 inline-block rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs">${esc(r.value)} <b>${num(r.count)}</b></span>`).join('')
    return `<div class="mt-1.5 text-xs"><span class="text-slate-400">${label}：</span>${items}</div>`
  }).filter(Boolean).join('')
  return `
  <div class="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
    <div class="font-mono text-sm font-semibold text-slate-900">${esc(hostLabel(hostname))}</div>
    ${parts || '<div class="mt-2 text-xs text-slate-400">还没有 UTM 流量进来</div>'}
  </div>`
}

const emptyBox = (t) => `<div class="rounded-xl border border-dashed border-slate-300 bg-white p-5 text-sm text-slate-400">${t}</div>`

export async function onRequestGet(context) {
  const denied = guard(context)
  if (denied) return denied
  const { request, env } = context
  if (!env.DB9_TOKEN) return new Response('DB9_TOKEN not configured', { status: 503 })

  try {
    // 阶段一：可选日期集合 = 各表有数据的日期并集（events 只取近 35 天，
    // plugin_created 回填用的是仓库创建时间，会把 min 拉到 2012 年）
    const [dTraffic, dReports, dRuns, dLetters, dEvents] = await Promise.all([
      safe(sql(env, `SELECT DISTINCT date FROM site_traffic WHERE source = 'umami'`)),
      safe(sql(env, `SELECT DISTINCT created_at::date FROM reports`)),
      safe(sql(env, 'SELECT date FROM score_runs')),
      safe(sql(env, `SELECT DISTINCT generated_at::date FROM weekly_letters`)),
      safe(sql(env, `SELECT DISTINCT occurred_at::date FROM ecosystem_events
                     WHERE occurred_at > now() - interval '35 days'`)),
    ])
    const dateSet = [...new Set([...dTraffic, ...dReports, ...dRuns, ...dLetters, ...dEvents]
      .map((r) => fmtDay(r[0])).filter((d) => RE_DATE.test(d)))].sort()
    if (!dateSet.length) {
      return page(layout({ title: '运营速览', active: 'digest', content: emptyBox('暂无任何数据（site_traffic / reports / score_runs / weekly_letters / ecosystem_events 均为空）') }))
    }

    const want = String(new URL(request.url).searchParams.get('date') ?? '')
    const date = dateSet.includes(want) ? want : dateSet[dateSet.length - 1]
    const prev = [...dateSet].reverse().find((d) => d < date) ?? null
    const next = dateSet.find((d) => d > date) ?? null
    const strip = dateSet.slice(-14)

    const navLink = (d, label) => d
      ? `<a href="/admin/digest?date=${d}" class="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm hover:bg-slate-50">${label}</a>`
      : `<span class="rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-300">${label}</span>`

    const nav = `
    <div class="mb-2 flex items-center gap-4">
      ${navLink(prev, '← 前一天')}
      <span class="text-2xl font-bold tabular-nums text-slate-900">${date}</span>
      ${navLink(next, '后一天 →')}
      ${RE_DATE.test(want) && !dateSet.includes(want) ? '<span class="text-xs text-amber-600">该日无数据，以下为最近有数据的一天</span>' : ''}
    </div>
    <div class="mb-6 flex flex-wrap gap-1">${strip.map((d) => {
      const on = d === date
      return `<a href="/admin/digest?date=${d}" class="rounded-md px-2 py-1 font-mono text-xs ${on ? 'bg-indigo-600 text-white' : 'text-slate-500 hover:bg-slate-200'}">${d.slice(5)}</a>`
    }).join('')}</div>`

    // 阶段二：选中日的各区块（全并行，safe 空态）
    const [traffic, events, eventCounts, [reportTotal], reports, runRows, letterRows, dlTop] = await Promise.all([
      safe(sql(env, `SELECT hostname, date, visitors, pageviews, sessions, bounces, avg_duration, daily, breakdowns
                     FROM site_traffic WHERE source = 'umami' AND date = '${date}' ORDER BY hostname`)),
      safe(sql(env, `SELECT type, key, occurred_at, payload FROM ecosystem_events
                     WHERE occurred_at::date = '${date}' ORDER BY occurred_at DESC LIMIT 200`)),
      safe(sql(env, `SELECT type, count(*) FROM ecosystem_events
                     WHERE occurred_at::date = '${date}' GROUP BY type ORDER BY count(*) DESC`)),
      safe(sql(env, `SELECT count(*) FROM reports WHERE created_at::date = '${date}'`)).then((r) => r[0] ?? [0]),
      safe(sql(env, `SELECT id, sig, category, plugin, source, created_at FROM reports
                     WHERE created_at::date = '${date}' ORDER BY id DESC LIMIT 50`)),
      safe(sql(env, `SELECT date, total, avg, grades FROM score_runs WHERE date <= '${date}' ORDER BY date DESC LIMIT 2`)),
      safe(sql(env, `SELECT week, range, generated_at, model, usage FROM weekly_letters
                     WHERE generated_at::date = '${date}' ORDER BY week DESC LIMIT 1`)),
      safe(sql(env, `SELECT pkg_name, downloads FROM plugin_downloads
                     WHERE week_start = (SELECT max(week_start) FROM plugin_downloads WHERE week_start <= '${date}')
                     ORDER BY downloads DESC LIMIT 5`)),
    ])

    // 当日流量（'' 合计排最前）
    const trafficSorted = [...traffic].sort((a, b) => (a[0] === '' ? -1 : b[0] === '' ? 1 : a[0].localeCompare(b[0])))

    // 当日事件流
    const evCountBadges = eventCounts.map((r) => `${badge(r[0], TYPE_TONE[r[0]])} <b class="ml-1">${num(r[1])}</b>`).join('<span class="mx-1.5 text-slate-200">·</span>')
    const evRows = events.map((e) => `<div class="flex items-baseline gap-2 border-b border-slate-50 py-1.5">
      <span class="w-12 shrink-0 font-mono text-xs text-slate-400">${esc(fmtTime(e[2]))}</span>
      <span class="shrink-0">${badge(e[0], TYPE_TONE[e[0]])}</span>
      <span class="min-w-0 font-mono text-xs text-slate-700">${esc(e[1])}</span>
      <span class="min-w-0 truncate text-xs text-slate-400">${eventSummary(e[0], parsePayload(e[3]))}</span>
    </div>`).join('')

    // 当日上报
    const reportRows = reports.map((r) => `<tr class="hover:bg-slate-50">
      <td class="px-4 py-2 text-slate-400">${esc(fmtTime(r[5]))}</td>
      <td class="px-4 py-2 font-mono text-xs"><a class="text-indigo-600 hover:underline" href="/admin/reports?sig=${encodeURIComponent(r[1])}">${esc(r[1])}</a></td>
      <td class="px-4 py-2">${badge(r[2])}</td>
      <td class="px-4 py-2 font-mono text-xs">${esc(r[3] ?? '—')}</td>
      <td class="px-4 py-2">${badge(r[4], r[4] === 'organic' ? 'green' : 'slate')}</td></tr>`).join('')

    // 当日大盘（score_runs 当日期 + 前一期的 ±delta）
    const run = runRows[0] && fmtDay(runRows[0][0]) === date ? runRows[0] : null
    const runPrev = run ? runRows[1] : (runRows[0] ?? null)
    const gradeCards = run ? ['S', 'A', 'B', 'C', 'D'].map((k) => {
      const cur = num(parseJson(run[3], {})[k])
      const d = runPrev ? cur - num(parseJson(runPrev[3], {})[k]) : 0
      const tone = d > 0 ? 'text-emerald-600' : d < 0 ? 'text-red-500' : 'text-slate-400'
      return `<div class="rounded-lg border border-slate-200 bg-white p-3 text-center shadow-sm">
        <div class="text-xs text-slate-400">${k} 级</div>
        <div class="mt-0.5 text-xl font-bold text-slate-900">${cur.toLocaleString('en-US')}</div>
        <div class="text-xs font-semibold ${tone}">${d > 0 ? `+${d}` : d === 0 ? '±0' : d}</div>
      </div>`
    }).join('') : ''

    const letter = letterRows[0]
    const usage = letter ? parseJson(letter[4], {}) : {}

    const content = `
    ${nav}

    <section class="mb-8">
      <h2 class="mb-3 font-semibold text-slate-900">当日流量</h2>
      ${trafficSorted.length
        ? `<div class="grid grid-cols-1 gap-4 lg:grid-cols-3">${trafficSorted.map((r) => trafficCard(r, date)).join('')}</div>`
        : emptyBox('当日无快照（Umami 追踪自 2026-09-06 开始，且每日 CI 采集一次）')}
    </section>

    <section class="mb-8">
      <h2 class="mb-3 font-semibold text-slate-900">当日事件流 <span class="text-xs font-normal text-slate-400">${events.length ? `共 ${eventCounts.reduce((a, r) => a + num(r[1]), 0)} 条` : ''}</span></h2>
      ${events.length
        ? `<div class="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <div class="mb-3 text-xs">${evCountBadges}</div>
            ${evRows}
            ${eventCounts.reduce((a, r) => a + num(r[1]), 0) > events.length ? `<p class="mt-3 text-xs text-slate-400">仅显示最近 ${events.length} 条，全部见 <a class="text-indigo-600 hover:underline" href="/admin/events">事件页</a></p>` : ''}
          </div>`
        : emptyBox('当日无生态事件')}
    </section>

    <section class="mb-8">
      <h2 class="mb-3 font-semibold text-slate-900">当日上报 <span class="text-xs font-normal text-slate-400">共 ${num(reportTotal)} 条（organic 破零是核心观察指标）</span></h2>
      ${reports.length
        ? table(['时刻', 'sig', 'category', 'plugin', 'source'], reportRows) +
          (num(reportTotal) > reports.length ? `<p class="mt-2 text-xs text-slate-400">仅显示最近 ${reports.length} 条，全部见 <a class="text-indigo-600 hover:underline" href="/admin/reports">上报明细</a></p>` : '')
        : emptyBox('当日无上报')}
    </section>

    <section class="mb-8">
      <h2 class="mb-3 font-semibold text-slate-900">当日大盘 <span class="text-xs font-normal text-slate-400">score_runs${runPrev ? `（对比 ${esc(fmtDay(runPrev[0]))}）` : ''}</span></h2>
      ${run
        ? `<div class="mb-4 grid grid-cols-2 gap-4 sm:grid-cols-3">
            ${card('评分插件总数', num(run[1]).toLocaleString('en-US'))}
            ${card('平均分', num(run[2]).toFixed(1))}
            ${card('评级分布', `${['S', 'A', 'B', 'C', 'D'].map((k) => `${k} ${num(parseJson(run[3], {})[k])}`).join(' · ')}`, '见下方 ± 变化')}
          </div>
          <div class="grid grid-cols-2 gap-3 sm:grid-cols-5">${gradeCards}</div>`
        : emptyBox('当日无评分 run（评分管线并非每天跑）')}
    </section>

    <section class="mb-8">
      <h2 class="mb-3 font-semibold text-slate-900">内容产出</h2>
      ${letter
        ? `<div class="grid grid-cols-1 gap-4 sm:grid-cols-3">
            ${card('周报', esc(letter[0]), esc(letter[1] ?? ''))}
            ${card('生成时间', esc(String(letter[2]).slice(0, 16)), `模型 ${esc(letter[3] ?? '—')}`)}
            ${card('token 用量', num(usage.total_tokens).toLocaleString('en-US'), `入 ${num(usage.prompt_tokens).toLocaleString('en-US')} / 出 ${num(usage.completion_tokens).toLocaleString('en-US')}`)}
          </div>
          <p class="mt-2 text-xs text-slate-400"><a class="text-indigo-600 hover:underline" href="/admin/letters">全部周报 →</a></p>`
        : emptyBox('当日无内容产出（周报每周一生成）')}
    </section>

    <section class="mb-8">
      <h2 class="mb-1 font-semibold text-slate-900">滚动窗口参考</h2>
      <p class="mb-3 text-xs text-slate-400">UTM 与下载量本来就是滚动窗口口径，不适合按天——此处为截至 ${date} 的窗口快照</p>
      ${trafficSorted.length
        ? `<div class="grid grid-cols-1 gap-4 lg:grid-cols-3">${trafficSorted.map((r) => utmBlock(r[0], r[8])).join('')}</div>`
        : emptyBox('当日无快照，UTM 无窗口数据')}
      <div class="mt-4">
        ${dlTop.length
          ? table(['pkg_name（最近一周）', '下载量'], dlTop.map((r) => `<tr class="hover:bg-slate-50">
              <td class="px-4 py-2 font-mono text-xs">${esc(r[0])}</td>
              <td class="px-4 py-2 text-right font-semibold">${num(r[1]).toLocaleString('en-US')}</td></tr>`).join(''))
          : '<div class="text-xs text-slate-400">截至当日无下载量周窗数据</div>'}
      </div>
    </section>`

    return page(layout({ title: `运营速览 ${date}`, active: 'digest', content }))
  } catch (err) {
    return errorPage(err)
  }
}

export function onRequest() {
  return new Response('method not allowed', { status: 405 })
}
