// GET /admin/digest — 运营速览：每周一看的运营数据汇总（纯服务端渲染，无 JS）
//
// 区块：流量周环比（site_traffic 快照里的 daily 按天数组）、UTM 来源（breakdowns）、
// 崩溃上报（organic vs seed）、生态脉搏（近 7 天事件 + grade 分布变化）、内容产出（weekly_letters）。
// 纪律：每区块独立查询、Promise.all 并行、safe() 包裹——单点失败只空态对应区块。

import { badge, card, esc, errorPage, guard, layout, page, sql, table } from './_layout.js'
import { TYPE_TONE } from './events.js'

const safe = (p) => p.catch(() => [])

const fmtDay = (d) => String(d ?? '').slice(0, 10)
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)

function parseJson(v, fallback) {
  if (v == null) return fallback
  if (typeof v === 'object') return v
  try { return JSON.parse(v) ?? fallback } catch { return fallback }
}

const HOST_LABEL = { '': '两站合计' }
const hostLabel = (h) => HOST_LABEL[h] ?? h

// ↑↓% 周环比：按日均比（前窗口天数不足 7 天时避免总量虚高）
function wowHtml(curSum, curDays, prevSum, prevDays) {
  if (!prevDays) return '<span class="text-xs text-slate-400">前一周期无基数</span>'
  const cur = curSum / curDays
  const prev = prevSum / prevDays
  if (!prev) return '<span class="text-xs text-slate-400">前一周期无基数</span>'
  const d = cur - prev
  const pctVal = (Math.abs(d / prev) * 100).toFixed(1)
  const tone = d === 0 ? 'text-slate-400' : d > 0 ? 'text-emerald-600' : 'text-red-500'
  return `<span class="text-xs font-semibold ${tone}">${d > 0 ? '↑' : d === 0 ? '→' : '↓'} ${pctVal}%</span>
    <span class="text-xs text-slate-400">（日均 ${cur.toFixed(1)} vs 前 ${prevDays} 天日均 ${prev.toFixed(1)}）</span>`
}

// 近 7 天小柱图（纯 CSS，参照 plugins 抽屉做法）
function miniBars(daily7) {
  const max = daily7.reduce((m, d) => Math.max(m, num(d.pageviews)), 0)
  const bars = daily7.map((d) => {
    const v = num(d.pageviews)
    const h = max > 0 ? Math.max(2, Math.round((v / max) * 56)) : 2
    return `<div class="flex min-w-0 flex-1 flex-col items-center justify-end gap-0.5" title="${esc(fmtDay(d.date))} · ${v.toLocaleString('en-US')} 浏览">
      <div class="text-[10px] font-semibold leading-none text-slate-600">${v.toLocaleString('en-US')}</div>
      <div class="w-full rounded-sm bg-indigo-400" style="height:${h}px"></div>
      <div class="text-[10px] leading-none text-slate-400">${esc(fmtDay(d.date).slice(8))}</div>
    </div>`
  }).join('')
  return `<div class="flex h-20 items-end gap-1">${bars}</div>`
}

// 流量周环卡：latest 行的 daily（28 天窗口）切近 7 天 / 前 7 天
function trafficCard(row) {
  const [hostname, date, visitors, sessions, dailyRaw] = row
  const daily = (Array.isArray(parseJson(dailyRaw, [])) ? parseJson(dailyRaw, []) : [])
    .filter((d) => d && typeof d === 'object')
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
  const last7 = daily.slice(-7)
  const prev7 = daily.slice(-14, -7)
  const sum = (list) => list.reduce((a, d) => a + num(d.pageviews), 0)
  return `
  <div class="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
    <div class="mb-1 flex items-baseline justify-between">
      <span class="font-mono text-sm font-semibold text-slate-900">${esc(hostLabel(hostname))}</span>
      <span class="text-xs text-slate-400">快照 ${esc(fmtDay(date))}</span>
    </div>
    <div class="mt-2 text-2xl font-bold text-slate-900">${sum(last7).toLocaleString('en-US')}<span class="ml-1 text-sm font-normal text-slate-400">近 ${last7.length} 天浏览</span></div>
    <div class="mb-3 mt-1">${wowHtml(sum(last7), last7.length, sum(prev7), prev7.length)}</div>
    ${last7.length ? miniBars(last7) : '<div class="py-4 text-center text-xs text-slate-400">暂无按天数据</div>'}
    <div class="mt-3 text-xs text-slate-400">主窗口去重：${num(visitors).toLocaleString('en-US')} 访客 · ${num(sessions).toLocaleString('en-US')} 会话（daily 只有浏览量口径，周环比按浏览量算）</div>
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
    ${parts || '<div class="mt-2 text-xs text-slate-400">还没有 UTM 流量进来 —— 站点内部跳转未带 ?utm_source=，无法区分引流来源</div>'}
  </div>`
}

function gradeDelta(latest, prev) {
  const g = (run, k) => num(parseJson(run?.grades, {})[k])
  const rows = ['S', 'A', 'B', 'C', 'D'].map((k) => {
    const cur = g(latest, k)
    const d = prev ? cur - g(prev, k) : 0
    const tone = d > 0 ? 'text-emerald-600' : d < 0 ? 'text-red-500' : 'text-slate-400'
    return `<div class="rounded-lg border border-slate-200 bg-white p-3 text-center shadow-sm">
      <div class="text-xs text-slate-400">${k} 级</div>
      <div class="mt-0.5 text-xl font-bold text-slate-900">${cur.toLocaleString('en-US')}</div>
      <div class="text-xs font-semibold ${tone}">${d > 0 ? `+${d}` : d === 0 ? '±0' : d}</div>
    </div>`
  }).join('')
  return `<div class="grid grid-cols-2 gap-3 sm:grid-cols-5">${rows}</div>
    <p class="mt-2 text-xs text-slate-400">评分口径见 score_runs（${latest ? esc(fmtDay(latest.date)) : '—'}${prev ? ` vs ${esc(fmtDay(prev.date))}` : ''}）；插件总数见上方卡片</p>`
}

export async function onRequestGet(context) {
  const denied = guard(context)
  if (denied) return denied
  const { env } = context
  if (!env.DB9_TOKEN) return new Response('DB9_TOKEN not configured', { status: 503 })

  try {
    const [trafficRows, reportAgg, reportRecent, eventAgg, [pluginCount], scoreRuns, letterRows] = await Promise.all([
      // site_traffic 表很小：取最近若干行，JS 里按 hostname 分最新一行
      safe(sql(env, `SELECT hostname, date, visitors, sessions, daily, breakdowns FROM site_traffic
                     WHERE source = 'umami' ORDER BY date DESC LIMIT 12`)),
      safe(sql(env, `SELECT source, count(*), count(*) FILTER (WHERE created_at > now() - interval '7 days'), max(created_at)
                     FROM reports GROUP BY source`)),
      safe(sql(env, `SELECT id, sig, category, source, created_at FROM reports ORDER BY id DESC LIMIT 5`)),
      safe(sql(env, `SELECT type, count(*) FROM ecosystem_events
                     WHERE occurred_at > now() - interval '7 days' GROUP BY type ORDER BY count(*) DESC`)),
      safe(sql(env, 'SELECT count(*) FROM plugins')).then((r) => r[0] ?? [null]),
      safe(sql(env, 'SELECT date, total, avg, grades FROM score_runs ORDER BY date DESC LIMIT 2')),
      safe(sql(env, 'SELECT week, range, generated_at, model, usage FROM weekly_letters ORDER BY week DESC LIMIT 1')),
    ])

    // 流量：按 hostname 取最新一行（'' 排最前）
    const latestByHost = new Map()
    for (const r of trafficRows) {
      if (!latestByHost.has(r[0])) latestByHost.set(r[0], r)
    }
    const hosts = [...latestByHost.keys()].sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)))
    const asOf = hosts.length ? fmtDay(latestByHost.get(hosts[0])[1]) : null

    const reportBy = Object.fromEntries(reportAgg.map((r) => [r[0], r]))
    const organic = reportBy.organic ?? ['organic', 0, 0, null]
    const seed = reportBy.seed ?? ['seed', 0, 0, null]
    const lastReportAt = reportAgg.reduce((m, r) => {
      const t = String(r[3] ?? '')
      return t > m ? t : m
    }, '')

    const recentRows = reportRecent.map((r) => `<tr class="hover:bg-slate-50">
      <td class="px-4 py-2"><a class="text-indigo-600 hover:underline" href="/admin/reports?id=${r[0]}">#${r[0]}</a></td>
      <td class="px-4 py-2 font-mono text-xs"><a class="text-indigo-600 hover:underline" href="/admin/reports?sig=${encodeURIComponent(r[1])}">${esc(r[1])}</a></td>
      <td class="px-4 py-2">${badge(r[2])}</td>
      <td class="px-4 py-2">${badge(r[3], r[3] === 'organic' ? 'green' : 'slate')}</td>
      <td class="px-4 py-2 text-slate-400">${esc(String(r[4]).slice(0, 16))}</td></tr>`).join('')

    const eventBadges = eventAgg.map((r) =>
      `<div class="flex items-center justify-between rounded-lg border border-slate-200 bg-white px-3 py-2 shadow-sm">
        ${badge(r[0], TYPE_TONE[r[0]])}<span class="text-sm font-bold text-slate-900">${num(r[1]).toLocaleString('en-US')}</span>
      </div>`).join('')

    const letter = letterRows[0]
    const usage = letter ? parseJson(letter[4], {}) : {}

    const content = `
    <p class="mb-6 text-sm text-slate-500">数据截至 <b>${asOf ?? '—'}</b>（site_traffic 最新快照）· 每天 CI 自动刷新</p>

    <section class="mb-8">
      <h2 class="mb-3 font-semibold text-slate-900">流量周环比</h2>
      ${hosts.length
        ? `<div class="grid grid-cols-1 gap-4 lg:grid-cols-3">${hosts.map((h) => trafficCard(latestByHost.get(h))).join('')}</div>`
        : '<div class="rounded-xl border border-dashed border-slate-300 bg-white p-5 text-sm text-slate-400">暂无站点访问快照</div>'}
    </section>

    <section class="mb-8">
      <h2 class="mb-3 font-semibold text-slate-900">UTM 来源 <span class="text-xs font-normal text-slate-400">观察 dsh-why 引流效果</span></h2>
      ${hosts.length
        ? `<div class="grid grid-cols-1 gap-4 lg:grid-cols-3">${hosts.map((h) => utmBlock(h, latestByHost.get(h)[5])).join('')}</div>`
        : '<div class="rounded-xl border border-dashed border-slate-300 bg-white p-5 text-sm text-slate-400">暂无数据</div>'}
    </section>

    <section class="mb-8">
      <h2 class="mb-3 font-semibold text-slate-900">崩溃上报</h2>
      <div class="mb-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
        ${card('organic 总数', num(organic[1]), num(organic[1]) > 0 ? '已破零 🎉' : '尚未破零 —— 核心观察指标')}
        ${card('organic 近 7 天', num(organic[2]))}
        ${card('seed 总数', num(seed[1]), '冷启动种子，不计入真实使用')}
        ${card('seed 近 7 天', num(seed[2]))}
      </div>
      ${table(['id', 'sig', 'category', 'source', '时间'], recentRows, '暂无上报')}
      ${lastReportAt ? `<p class="mt-2 text-xs text-slate-400">最近上报 ${esc(lastReportAt.slice(0, 16))}（crash-corpus 新鲜度由此推断）</p>` : ''}
    </section>

    <section class="mb-8">
      <h2 class="mb-3 font-semibold text-slate-900">生态脉搏（近 7 天）</h2>
      <div class="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
        ${card('插件总数', pluginCount != null ? num(pluginCount).toLocaleString('en-US') : '—', 'dsh-insights 收录')}
        ${card('近 7 天新插件', num(eventAgg.find((r) => r[0] === 'plugin_created')?.[1]), 'plugin_created')}
        ${card('近 7 天首次上架', num(eventAgg.find((r) => r[0] === 'npm_first_publish')?.[1]), 'npm_first_publish')}
      </div>
      ${eventBadges ? `<div class="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">${eventBadges}</div>` : ''}
      ${scoreRuns.length ? gradeDelta(
        { date: scoreRuns[0][0], grades: scoreRuns[0][3] },
        scoreRuns[1] ? { date: scoreRuns[1][0], grades: scoreRuns[1][3] } : null,
      ) : ''}
    </section>

    <section class="mb-8">
      <h2 class="mb-3 font-semibold text-slate-900">内容产出</h2>
      ${letter
        ? `<div class="grid grid-cols-1 gap-4 sm:grid-cols-3">
            ${card('最新周报', esc(letter[0]), esc(letter[1] ?? ''))}
            ${card('生成时间', esc(String(letter[2]).slice(0, 16)), `模型 ${esc(letter[3] ?? '—')}`)}
            ${card('token 用量', num(usage.total_tokens).toLocaleString('en-US'), `入 ${num(usage.prompt_tokens).toLocaleString('en-US')} / 出 ${num(usage.completion_tokens).toLocaleString('en-US')}`)}
          </div>
          <p class="mt-2 text-xs text-slate-400"><a class="text-indigo-600 hover:underline" href="/admin/letters">全部周报 →</a></p>`
        : '<div class="rounded-xl border border-dashed border-slate-300 bg-white p-5 text-sm text-slate-400">暂无周报</div>'}
    </section>`

    return page(layout({ title: '运营速览', active: 'digest', content }))
  } catch (err) {
    return errorPage(err)
  }
}

export function onRequest() {
  return new Response('method not allowed', { status: 405 })
}
