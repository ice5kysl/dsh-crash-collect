// GET /admin/traffic — 站点访问分析台（Umami → db9 site_traffic，数据只存这里，不进公开仓库）
//
// 一行 = 某天某来源某域名的一份滚动窗口快照（PK date+source+hostname，
// hostname='' 为两站合计，非空为单域名行；2026-09-13 起分域名采集）。
// 顶部域名 tab（?domain=）在合计与各 hostname 之间切换；旧日期只有合计行。
// 除总体/按天/页面/来源/国家外，还展示 18 个维度的 breakdowns、近 1/7 天窗口、
// 实时在线、快照历史，以及一屏「洞察」——把数据里能直接读出来的事实写成句子。

import { badge, card, esc, errorPage, guard, layout, page, sql, table } from './_layout.js'

const SOURCE = 'umami'
const COLS = `date, window_days, visitors, pageviews, sessions, bounces, avg_duration,
  daily, top_paths, referrers, countries, hostnames, windows, active, breakdowns, collected_at`

// 维度展示顺序与标题（单位优先取快照里存的 unit，缺省用这里的兜底）
const DIMS = [
  ['hostname', '域名', '访客'],
  ['path', '页面', '浏览'],
  ['entry', '入口页', '访客'],
  ['exit', '出口页', '访客'],
  ['referrer', '来源', '会话'],
  ['utmSource', 'UTM 来源', '会话'],
  ['utmMedium', 'UTM 媒介', '会话'],
  ['utmCampaign', 'UTM 活动', '会话'],
  ['country', '国家', '访客'],
  ['region', '地区', '访客'],
  ['city', '城市', '访客'],
  ['browser', '浏览器', '访客'],
  ['os', '系统', '访客'],
  ['device', '设备', '访客'],
  ['language', '语言', '访客'],
  ['screen', '屏幕', '访客'],
  ['title', '页面标题', '浏览'],
  ['event', '事件', '访客'],
]

const UNIT_LABEL = { visitors: '访客', pageviews: '浏览', visits: '会话' }

const SETUP_CMD = 'DB9_TOKEN=… UMAMI_SHARE=<share-url> node bin/traffic-sync.mjs'

// db9 报「表不存在 / 关系未定义」时走友好空状态，而不是把错误信息当堆栈抛给用户
const MISSING_RE = /does not exist|doesn't exist|no such table|undefined table|unknown relation|unknown table/i

const fmtInt = (v) => {
  if (v == null || v === '') return '<span class="text-slate-300">—</span>'
  return Number.isFinite(Number(v)) ? Number(v).toLocaleString('en-US') : esc(v)
}

const num = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

const fmtDuration = (sec) => {
  if (sec == null || sec === '') return '<span class="text-slate-300">—</span>'
  const n = Number(sec)
  if (!Number.isFinite(n) || n < 0) return esc(sec)
  const s = Math.round(n)
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`
}

// 跳出率：bounces/sessions
const fmtBounce = (bounces, sessions) => {
  const b = Number(bounces)
  const s = Number(sessions)
  if (bounces == null || sessions == null || !Number.isFinite(b) || !Number.isFinite(s) || s <= 0) {
    return '<span class="text-slate-300">—</span>'
  }
  return `${((b / s) * 100).toFixed(1)}%`
}

const bouncePct = (bounces, sessions) => (num(sessions) > 0 ? (num(bounces) / num(sessions)) * 100 : null)

// 时间戳统一成 YYYY-MM-DD HH:MM
const fmtStamp = (ts) => (ts == null ? '—' : esc(String(ts).replace('T', ' ').slice(0, 16)))
const fmtDay = (d) => (d == null ? '—' : esc(String(d).slice(0, 10)))

// JSONB 经 db9 HTTP API 回来是字符串（少数情况已解码），坏值一律退化为默认值
function parseJson(v, fallback) {
  if (v == null) return fallback
  if (typeof v === 'object') return v
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v)
      return parsed ?? fallback
    } catch {
      return fallback
    }
  }
  return fallback
}
const parseList = (v) => {
  const parsed = parseJson(v, [])
  return Array.isArray(parsed) ? parsed : []
}
const parseObj = (v) => {
  const parsed = parseJson(v, {})
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
}

const truncate = (s, n = 44) => {
  const t = String(s ?? '')
  return t.length > n ? `${t.slice(0, n)}…` : t
}

const pct = (part, total) => (num(total) > 0 ? `${((num(part) / num(total)) * 100).toFixed(1)}%` : '—')
const sumBy = (rows, key) => rows.reduce((a, r) => a + num(r?.[key]), 0)

// 无快照 / 表缺失时的引导卡片：告诉运维在 dsh-insights 仓库跑同步脚本
function setupCard(reason = '') {
  return `
  <div class="rounded-xl border border-dashed border-slate-300 bg-white p-6 shadow-sm">
    <div class="text-sm font-semibold text-slate-900">暂无站点访问数据</div>
    <p class="mt-2 text-sm text-slate-500">db9 的 <code class="rounded bg-slate-100 px-1 font-mono text-xs">site_traffic</code> 表还没有可用快照。该表由 dsh-insights 仓库的同步脚本写入，每天一行滚动窗口（hourly 管线每小时刷新当天那行）。</p>
    <p class="mt-4 text-sm text-slate-500">在 dsh-insights 仓库运行：</p>
    <pre class="mt-2 overflow-x-auto rounded-lg bg-slate-900 p-3 font-mono text-xs leading-relaxed text-slate-100">${esc(SETUP_CMD)}</pre>
    <p class="mt-3 text-xs text-slate-400">同步完成后刷新本页。${reason ? `（${esc(reason)}）` : ''}</p>
  </div>`
}

// 按天柱状：纯 inline style 宽度，不依赖任何 JS 库
function dailyBars(daily) {
  const items = parseList(daily)
    .filter((d) => d && typeof d === 'object')
    .map((d) => ({ date: String(d.date ?? ''), pageviews: num(d.pageviews) }))
    .sort((a, b) => a.date.localeCompare(b.date))
  if (!items.length) return '<div class="px-1 py-6 text-center text-sm text-slate-400">暂无数据</div>'

  const max = items.reduce((m, d) => Math.max(m, d.pageviews), 0)
  const total = items.reduce((a, d) => a + d.pageviews, 0)
  const rows = items.map((d) => {
    const p = max > 0 ? Math.round((d.pageviews / max) * 100) : 0
    const width = d.pageviews > 0 ? Math.max(p, 1) : 0
    return `<div class="flex items-center gap-3">
      <span class="w-20 shrink-0 font-mono text-xs text-slate-500">${esc(d.date.slice(0, 10))}</span>
      <div class="h-2 min-w-0 flex-1 rounded-full bg-slate-100"><div class="h-2 rounded-full bg-indigo-500" style="width:${width}%"></div></div>
      <span class="w-16 shrink-0 text-right text-xs font-semibold text-slate-700">${d.pageviews.toLocaleString('en-US')}</span>
    </div>`
  }).join('')
  return `<div class="mb-3 text-xs text-slate-400">共 ${items.length} 天 · 合计 ${total.toLocaleString('en-US')} 浏览 · 峰值 ${max.toLocaleString('en-US')} 次/天</div>
    <div class="space-y-1.5">${rows}</div>`
}

// 单个维度的表：值 / 计数 / 占比条（占比 = 该维度全部行的占比）
// 每张表默认只展示前 10 行（path/title 在库里是全量，用于按前缀聚合），截断时给出行数提示
const ROWS_SHOWN = 10

function breakdownTable(key, rows, unitLabel) {
  const all = parseList(rows).filter((r) => r && typeof r === 'object')
  if (!all.length) return table([key, unitLabel], '', `${key}：暂无数据`)
  const total = sumBy(all, 'count')
  const list = all.slice(0, ROWS_SHOWN)
  const body = list.map((r) => {
    const p = total > 0 ? Math.round((num(r.count) / total) * 100) : 0
    return `<tr class="hover:bg-slate-50">
      <td class="px-4 py-2.5 font-mono text-xs" title="${esc(r.value ?? '')}">${esc(truncate(r.value ?? '—', 40))}</td>
      <td class="px-4 py-2.5 text-right font-semibold">${fmtInt(r.count)}</td>
      <td class="w-28 px-4 py-2.5">
        <div class="flex items-center gap-2">
          <div class="h-1.5 min-w-0 flex-1 rounded-full bg-slate-100"><div class="h-1.5 rounded-full bg-indigo-400" style="width:${p}%"></div></div>
          <span class="w-9 shrink-0 text-right text-xs text-slate-400">${p}%</span>
        </div>
      </td></tr>`
  }).join('')
  const more = all.length > list.length
    ? `<p class="mt-2 px-1 text-xs text-slate-400">显示前 ${list.length} / 共 ${all.length} 行（占比按全部 ${fmtInt(total)} 计）</p>`
    : ''
  return table([key, unitLabel, '占比'], body) + more
}

/**
 * 一屏洞察：只写数据里能直接读出来的事实（path/title 为全量，其余维度为该维度全部行）。
 * 返回 HTML 列表；数据不足以支撑的句子不出现。
 */
function insightsHtml(row, dims, hostnames) {
  const items = []
  const visitors = num(row[2])
  const pageviews = num(row[3])
  const sessions = num(row[4])

  // 域名构成 / 自流量
  const hosts = hostnames.filter((h) => h && typeof h === 'object')
  const selfV = sumBy(hosts.filter((h) => /^(localhost|127\.0\.0\.1|\[::1\])$/.test(String(h.host))), 'visitors')
  const ext = hosts.filter((h) => !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(String(h.host)))
  if (ext.length) {
    items.push(`域名构成：${ext.map((h) => `${esc(h.host)} ${fmtInt(h.visitors)}`).join(' · ')}`)
  }
  if (selfV) items.push(`自流量（localhost）：${fmtInt(selfV)} 访客，占全部 ${pct(selfV, visitors)}`)

  // 来源构成：搜索 / GitHub / 其余（无 referrer 的直接访问不在 referrer 维度里）
  const refs = parseList(dims.referrer?.rows)
  const search = refs.filter((r) => /google|bing|baidu|duckduckgo|yahoo|yandex|ecosia|sogou|so\.com/i.test(String(r.value)))
  const github = refs.filter((r) => /github/i.test(String(r.value)))
  if (refs.length) {
    const described = sumBy(refs, 'count')
    items.push(`有来源会话 ${fmtInt(described)}/${fmtInt(sessions)}（${pct(described, sessions)}）：搜索 ${fmtInt(sumBy(search, 'count'))} · GitHub ${fmtInt(sumBy(github, 'count'))} · 其余为无 referrer 的直接访问`)
  }

  // 内容结构：插件详情页 / 周报 / 专题 / 徽章
  const paths = parseList(dims.path?.rows)
  if (paths.length) {
    const pTotal = sumBy(paths, 'count')
    const plugin = paths.filter((r) => String(r.value).startsWith('/p/'))
    const weekly = paths.filter((r) => String(r.value).startsWith('/weekly'))
    const insights = paths.filter((r) => String(r.value).startsWith('/insights'))
    const badgeP = paths.filter((r) => String(r.value).startsWith('/badge'))
    items.push(`内容结构（全部路径）：插件详情页 /p/* ${fmtInt(sumBy(plugin, 'count'))}（${pct(sumBy(plugin, 'count'), pTotal)}）· 周报 ${fmtInt(sumBy(weekly, 'count'))} · 专题 ${fmtInt(sumBy(insights, 'count'))} · 徽章页 ${fmtInt(sumBy(badgeP, 'count'))}`)
  }

  // 语言与设备
  const lang = parseList(dims.language?.rows)
  if (lang.length) {
    const zh = lang.filter((r) => /^zh/i.test(String(r.value)))
    const en = lang.filter((r) => /^en/i.test(String(r.value)))
    items.push(`语言：zh ${fmtInt(sumBy(zh, 'count'))} · en ${fmtInt(sumBy(en, 'count'))}`)
  }
  const device = parseList(dims.device?.rows)
  if (device.length) {
    items.push(`设备：${device.map((d) => `${esc(d.value)} ${fmtInt(d.count)}`).join(' · ')}`)
  }

  // 数据质量：可疑分辨率 + 跳出/停留
  const screens = parseList(dims.screen?.rows)
  const odd = screens.filter((r) => ['800x600', '1024x1024'].includes(String(r.value)))
  const oddN = sumBy(odd, 'count')
  if (oddN) items.push(`⚠️ 可疑分辨率（800x600 / 1024x1024 多为无头浏览器或内嵌 webview）：${fmtInt(oddN)} 访客，占屏幕维度 ${pct(oddN, sumBy(screens, 'count'))} —— 访客数宜按上界读`)
  const br = bouncePct(row[5], sessions)
  if (br != null) items.push(`跳出率 ${br.toFixed(1)}%${br > 70 ? '（偏高，符合"查一个插件就走"的工具型站点）' : ''} · 人均 ${visitors > 0 ? (pageviews / visitors).toFixed(2) : '—'} 页`)

  // 埋点缺口：事件 / UTM
  if (!parseList(dims.event?.rows).length) items.push('事件维度为空：尚未埋点（复制徽章、点上报、订阅等转化事件）')
  const utmKeys = ['utmSource', 'utmMedium', 'utmCampaign'].filter((k) => parseList(dims[k]?.rows).length)
  if (!utmKeys.length) items.push('UTM 维度为空：站点内部跳转未带 ?utm_source=，无法把"shell/插件跳转"与"直接访问"分开')

  if (!items.length) return ''
  return `<section class="mb-8 rounded-xl border border-indigo-100 bg-indigo-50/40 p-5">
    <h3 class="mb-2 font-semibold text-slate-900">洞察</h3>
    <ul class="list-disc space-y-1 pl-5 text-sm text-slate-600">${items.map((t) => `<li>${t}</li>`).join('')}</ul>
  </section>`
}

// 快照历史：同一口径（滚动窗口）逐日对比，看趋势而不是看单点
function historyTable(rows) {
  const list = rows.filter((r) => Array.isArray(r) && r[0])
  if (!list.length) return ''
  const body = list.map((r) => {
    const [date, visitors, pageviews, sessions, bounces, avgDuration] = r
    return `<tr class="hover:bg-slate-50">
      <td class="px-4 py-2.5 font-mono text-xs">${fmtDay(date)}</td>
      <td class="px-4 py-2.5 text-right font-semibold">${fmtInt(visitors)}</td>
      <td class="px-4 py-2.5 text-right">${fmtInt(pageviews)}</td>
      <td class="px-4 py-2.5 text-right">${fmtInt(sessions)}</td>
      <td class="px-4 py-2.5 text-right">${fmtBounce(bounces, sessions)}</td>
      <td class="px-4 py-2.5 text-right">${fmtDuration(avgDuration)}</td></tr>`
  }).join('')
  return table(['快照日', '访客', '浏览', '会话', '跳出率', '平均停留'], body)
}

export async function onRequestGet(context) {
  const denied = guard(context)
  if (denied) return denied
  const { request, env } = context
  if (!env.DB9_TOKEN) return new Response('DB9_TOKEN not configured', { status: 503 })

  const friendly = (reason) => page(layout({ title: '站点访问', active: 'traffic', content: setupCard(reason) }))

  // 域名 tab：?domain=<hostname>（空 = 全部，即 hostname='' 的合计行）。
  // 表未迁移（无 hostname 列）时自动退回旧口径（只能看合计）。
  const url = new URL(request.url)
  const wantDomain = (url.searchParams.get('domain') ?? '').slice(0, 128)

  try {
    const settled = await Promise.allSettled([
      sql(env, `SELECT DISTINCT hostname FROM site_traffic WHERE source = '${SOURCE}' AND hostname <> '' ORDER BY 1`),
      sql(env, `SELECT min(date) FROM site_traffic WHERE source = '${SOURCE}' AND hostname <> ''`),
    ])
    const hasHostname = settled[0].status === 'fulfilled'
    const domains = hasHostname ? settled[0].value.map((r) => String(r[0])) : []
    const splitStart = settled[1].status === 'fulfilled' ? settled[1].value[0]?.[0] : null
    const domain = hasHostname && domains.includes(wantDomain) ? wantDomain : ''
    // 指定了域名但库里没有它的行（未开始分域名采集或域名不存在）→ 明确提示，不静默回落
    const unknownDomain = hasHostname && wantDomain && !domain
    const hostCond = hasHostname ? ` AND hostname = '${domain.replace(/'/g, "''")}'` : ''

    const tabBar = hasHostname ? `
      <div class="mb-5 flex items-center gap-1 border-b border-slate-200">${['', ...domains].map((h) => {
        const on = h === domain && !unknownDomain
        const label = h === '' ? '全部' : h
        const href = h === '' ? '/admin/traffic' : `/admin/traffic?domain=${encodeURIComponent(h)}`
        return `<a href="${href}" class="-mb-px border-b-2 px-4 py-2 text-sm font-medium ${on ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-700'}">${esc(label)}</a>`
      }).join('')}</div>` : ''

    if (unknownDomain) {
      return page(layout({
        title: '站点访问', active: 'traffic',
        content: `${tabBar}
        <div class="rounded-xl border border-dashed border-slate-300 bg-white p-6 text-sm text-slate-500 shadow-sm">
          <span class="font-mono">${esc(wantDomain)}</span> 暂无快照：该日期无分域名数据（分域名采集${splitStart ? `自 ${fmtDay(splitStart)} 起拆分` : '尚未开始，等待下一次 traffic-sync'}，更早日期只有两站合计）。
          <a class="ml-2 text-indigo-600 hover:underline" href="/admin/traffic">查看两站合计 →</a>
        </div>`,
      }))
    }

    const settled2 = await Promise.allSettled([
      sql(env, `SELECT ${COLS} FROM site_traffic WHERE source = '${SOURCE}'${hostCond} ORDER BY date DESC LIMIT 1`),
      sql(env, `SELECT date, visitors, pageviews, sessions, bounces, avg_duration FROM site_traffic
                WHERE source = '${SOURCE}'${hostCond} ORDER BY date DESC LIMIT 14`),
      sql(env, `SELECT date, visitors, pageviews, sessions FROM site_traffic WHERE source = 'ga4' ORDER BY date DESC LIMIT 1`),
    ])
    const errors = settled2.filter((s) => s.status === 'rejected').map((s) => s.reason)
    const latest = settled2[0].status === 'fulfilled' ? settled2[0].value : []
    const historyRows = settled2[1].status === 'fulfilled' ? settled2[1].value : []
    const ga4Rows = settled2[2].status === 'fulfilled' ? settled2[2].value : []

    if (errors.some((e) => MISSING_RE.test(String(e?.message ?? e)))) return friendly('site_traffic 表不存在')
    if (!Array.isArray(latest) || !latest.length) {
      if (errors.length) return errorPage(errors[0])
      if (domain) {
        return page(layout({
          title: '站点访问', active: 'traffic',
          content: `${tabBar}
          <div class="rounded-xl border border-dashed border-slate-300 bg-white p-6 text-sm text-slate-500 shadow-sm">
            <span class="font-mono">${esc(domain)}</span> 暂无快照：该日期无分域名数据（分域名采集${splitStart ? `自 ${fmtDay(splitStart)} 起拆分` : '尚未开始，等待下一次 traffic-sync'}，更早日期只有两站合计）。
            <a class="ml-2 text-indigo-600 hover:underline" href="/admin/traffic">查看两站合计 →</a>
          </div>`,
        }))
      }
      return friendly()
    }

    const row = latest[0]
    const [date, windowDays, visitors, pageviews, sessions, bounces, avgDuration, daily, topPaths, referrers, countries, hostnamesRaw, windowsRaw, active, breakdownsRaw, collectedAt] = row
    const hostnames = parseList(hostnamesRaw)
    const windows = parseObj(windowsRaw)
    const rawBreakdowns = parseObj(breakdownsRaw)
    const d1 = windows.d1 || null
    const d7 = windows.d7 || null

    // 新快照用 breakdowns；老快照（本列上线前）回退到 four 粗粒度列
    const dims = Object.keys(rawBreakdowns).length
      ? rawBreakdowns
      : {
          path: { unit: 'pageviews', rows: parseList(topPaths).map((x) => ({ value: x.path, count: x.pageviews })) },
          referrer: { unit: 'visits', rows: parseList(referrers).map((x) => ({ value: x.referrer, count: x.sessions })) },
          country: { unit: 'visitors', rows: parseList(countries).map((x) => ({ value: x.country, count: x.sessions })) },
          hostname: { unit: 'visitors', rows: hostnames.map((x) => ({ value: x.host, count: x.visitors })) },
        }

    const unitLabel = (key, fallback) => UNIT_LABEL[String(dims[key]?.unit)] ?? fallback
    const dimCards = DIMS.map(([key, label, fallbackUnit]) => {
      if (!dims[key]) return ''
      const rowsHtml = breakdownTable(label, dims[key].rows, unitLabel(key, fallbackUnit))
      return `<div class="min-w-0"><h3 class="mb-3 font-semibold text-slate-900">${esc(label)}</h3>${rowsHtml}</div>`
    }).join('')

    const ga4Row = ga4Rows[0] ?? null
    const ga4Block = domain === '' && ga4Row
      ? `<section class="mt-10 border-t border-slate-200 pt-6">
          <div class="mb-2 flex items-center gap-2"><h2 class="text-lg font-semibold text-slate-900">GA4（历史来源）</h2>${badge('ga4', 'sky')}</div>
          <p class="text-sm text-slate-500">dsh-why.com 自 2026-09-13 起改用 Umami（并入上面的 umami 快照，按域名拆），此处只保留最后一次 GA4 快照：${fmtDay(ga4Row[0])} · ${fmtInt(ga4Row[1])} 访客 · ${fmtInt(ga4Row[2])} 浏览 · ${fmtInt(ga4Row[3])} 会话。</p>
        </section>`
      : ''

    const content = `
      ${tabBar}
      <div class="mb-1 flex flex-wrap items-center gap-2">
        <h2 class="text-lg font-semibold text-slate-900">Umami（${domain ? esc(domain) : '两站合计'}）</h2>
        ${badge('umami', 'green')}
        ${active != null ? badge(`实时在线 ${Number(active)}`, 'indigo') : ''}
      </div>
      <p class="mb-5 text-sm text-slate-500">快照 ${fmtDay(date)} · 主窗口 ${fmtInt(windowDays)} 天 · 采集于 ${fmtStamp(collectedAt)}</p>

      <div class="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        ${card('实时在线', active == null ? '—' : fmtInt(active), '采集瞬间')}
        ${card('近 24 小时访客', d1 ? fmtInt(d1.visitors) : '—', d1 ? `${fmtInt(d1.pageviews)} 浏览` : '窗口缺失')}
        ${card('近 7 天访客', d7 ? fmtInt(d7.visitors) : '—', d7 ? `${fmtInt(d7.pageviews)} 浏览` : '窗口缺失')}
        ${card(`近 ${fmtInt(windowDays)} 天访客`, fmtInt(visitors), '窗口内去重')}
        ${card('浏览量', fmtInt(pageviews), `人均 ${num(visitors) > 0 ? (num(pageviews) / num(visitors)).toFixed(2) : '—'} 页`)}
        ${card('会话', fmtInt(sessions), 'sessions')}
        ${card('跳出率', fmtBounce(bounces, sessions), 'bounces / sessions')}
        ${card('平均停留', fmtDuration(avgDuration), '每次会话')}
        ${card('域名数', fmtInt(hostnames.length), '含 localhost 自流量')}
      </div>

      ${insightsHtml(row, dims, hostnames)}

      <section class="mb-8">
        <h3 class="mb-3 font-semibold text-slate-900">按天浏览</h3>
        <div class="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">${dailyBars(daily)}</div>
      </section>

      <section class="mb-8">
        <h3 class="mb-3 font-semibold text-slate-900">维度明细</h3>
        <div class="grid grid-cols-1 gap-4 lg:grid-cols-2 2xl:grid-cols-3">${dimCards}</div>
      </section>

      <section class="mb-8">
        <h3 class="mb-3 font-semibold text-slate-900">快照历史（同一口径逐日）</h3>
        ${historyTable(historyRows)}
      </section>

      ${ga4Block}

      <p class="mt-8 text-xs text-slate-400">数据来自 Umami 公开分享链接（只读），仅存 db9 的 <code class="rounded bg-slate-100 px-1 font-mono">site_traffic</code>，不写入公开仓库 —— 本页是唯一展示入口。每天一行滚动窗口（hourly 管线每小时刷新当天那行）；维度表默认只展示前 10 行，「占比」按该维度全部行计算；path/title 存的是全量行（供按前缀聚合）。</p>`

    return page(layout({ title: '站点访问', active: 'traffic', content }))
  } catch (err) {
    if (MISSING_RE.test(String(err?.message ?? err))) return friendly('site_traffic 表不存在')
    return errorPage(err)
  }
}

export function onRequest() {
  return new Response('method not allowed', { status: 405 })
}
