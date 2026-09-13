// GET /admin/plugins — 插件库：搜索/过滤/排序/分页；?plugin=<full_name> 右侧抽屉
// 抽屉内容：完整信息 + 分数趋势图（近 30 天，涨跌指示）+ 下载趋势图（近 12 周）+
// 事件时间线 + 崩溃上报 + LLM 标注 + 兼容观察。图表为纯 CSS 柱状图，无 JS 依赖。

import { badge, drawer, esc, errorPage, field, guard, layout, page, sql, table } from './_layout.js'
import { TYPE_TONE, parsePayload, summary as eventSummary } from './events.js'

const PAGE_SIZE = 30
const SCORE_DAYS = 30
const DL_WEEKS = 12

const SORTS = {
  stars: ['stars', 'p.stars DESC'],
  score: ['score', 'p.score DESC NULLS LAST'],
  downloads: ['下载量', 'dl DESC NULLS LAST'],
}

const GRADE_TONE = { S: 'green', A: 'green', B: 'indigo', C: 'amber', D: 'red' }
const GRADE_BAR = { S: 'bg-emerald-500', A: 'bg-emerald-400', B: 'bg-indigo-500', C: 'bg-amber-400', D: 'bg-red-400' }

// 值入库前统一转义单引号；grade/category/sort 再与库内实际取值比对（双保险）
const sqlStr = (v) => `'${String(v).replace(/'/g, "''")}'`
const likeStr = (v) => sqlStr(String(v).replace(/[%_\\]/g, (m) => `\\${m}`))

// 单个查询失败/空结果 → 空数组（该区块显示空态，不拖垮整个抽屉）
const safe = (p) => p.catch(() => [])

const fmtDay = (d) => String(d ?? '').slice(0, 10)

// 分数趋势：每天一根柱（高=score，色=grade 分档），柱下 ↑↓ 为相对前一天涨跌
function scoreChart(scores) {
  const rows = [...scores].reverse() // DESC → ASC
  const bars = rows.map((r, i) => {
    const cur = Number(r[1])
    const prev = i > 0 ? Number(rows[i - 1][1]) : null
    const delta = prev == null ? '' : cur > prev ? '↑' : cur < prev ? '↓' : '·'
    const tone = prev == null || cur === prev ? 'text-slate-300' : cur > prev ? 'text-emerald-500' : 'text-red-400'
    const h = Math.max(2, Math.round((cur / 100) * 88))
    return `<div class="flex min-w-0 flex-1 flex-col items-center justify-end gap-0.5"
      title="${esc(fmtDay(r[0]))} · ${cur} 分 ${esc(r[2] ?? '')}${prev == null ? '' : `（较前一天 ${delta === '↑' ? '+' : delta === '↓' ? '−' : '±'}${Math.abs(cur - prev)}）`}">
      <div class="w-full rounded-sm ${GRADE_BAR[r[2]] ?? 'bg-slate-300'}" style="height:${h}px"></div>
      <div class="text-[10px] leading-none ${tone}">${delta}</div>
    </div>`
  }).join('')
  return `<div class="flex h-28 items-end gap-px">${bars}</div>
    <div class="mt-1 flex justify-between text-[10px] text-slate-400">
      <span>${esc(fmtDay(rows[0][0]))}</span><span>${rows.length} 天</span><span>${esc(fmtDay(rows[rows.length - 1][0]))}</span>
    </div>`
}

// 下载趋势：每周一根柱（高按窗口内最大值归一），柱上标值、柱下标周起始
function dlChart(downloads) {
  const rows = [...downloads].reverse()
  const max = rows.reduce((m, r) => Math.max(m, Number(r[1]) || 0), 0)
  const bars = rows.map((r) => {
    const v = Number(r[1]) || 0
    const h = max > 0 ? Math.max(2, Math.round((v / max) * 88)) : 2
    return `<div class="flex min-w-0 flex-1 flex-col items-center justify-end gap-0.5" title="${esc(fmtDay(r[0]))} 起一周 · ${v.toLocaleString('en-US')} 下载">
      <div class="text-[10px] font-semibold leading-none text-slate-600">${v.toLocaleString('en-US')}</div>
      <div class="w-full rounded-sm bg-indigo-400" style="height:${h}px"></div>
      <div class="text-[10px] leading-none text-slate-400">${esc(fmtDay(r[0]).slice(5))}</div>
    </div>`
  }).join('')
  return `<div class="flex h-28 items-end gap-1">${bars}</div>`
}

async function pluginDrawer(env, fullName, backQs) {
  const fn = sqlStr(fullName)
  const fnLike = likeStr(`${fullName}@%`)
  const pkgSub = `(SELECT pkg_name FROM plugins WHERE full_name = ${fn})`
  // 8 条查询全部并行；除插件本身外都过 safe()，单点失败只影响对应区块
  const [plugin, scores, downloads, tags, events, [reportCount], reports, compat] = await Promise.all([
    sql(env, `SELECT full_name, owner, repo, kind, pkg_name, version, description, license, stars, forks, score, grade, category, in_awesome, covered, pushed_at, html_url
              FROM plugins WHERE full_name = ${fn} LIMIT 1`).then((r) => r[0]),
    safe(sql(env, `SELECT date, score, grade FROM plugin_scores
              WHERE full_name = ${fn} AND date > current_date - interval '${SCORE_DAYS} days'
              ORDER BY date DESC LIMIT ${SCORE_DAYS}`)),
    safe(sql(env, `SELECT week_start, downloads FROM plugin_downloads
              WHERE pkg_name = ${pkgSub} ORDER BY week_start DESC LIMIT ${DL_WEEKS}`)),
    safe(sql(env, `SELECT category, capability_tags, summary_zh, confidence, model, tagged_at
              FROM plugin_llm_tags WHERE full_name = ${fn} LIMIT 1`)).then((r) => r[0]),
    // 插件级事件：key = full_name / full_name@*（plugin_created/release/archived），
    // 加上 key = pkg_name 的 npm_first_publish
    safe(sql(env, `SELECT type, key, occurred_at, payload FROM ecosystem_events
              WHERE key = ${fn} OR key LIKE ${fnLike} ESCAPE '\\' OR (type = 'npm_first_publish' AND key = ${pkgSub})
              ORDER BY occurred_at DESC LIMIT 20`)),
    safe(sql(env, `SELECT count(*) FROM reports WHERE plugin = ${pkgSub}`)).then((r) => r[0] ?? [0]),
    safe(sql(env, `SELECT sig, category, created_at FROM reports WHERE plugin = ${pkgSub} ORDER BY id DESC LIMIT 5`)),
    safe(sql(env, `SELECT version, client, observed_at FROM compat_observations
              WHERE pkg_name = ${pkgSub} ORDER BY observed_at DESC LIMIT 5`)),
  ])
  if (!plugin) return `<div class="w-[42rem] max-w-[90vw] shrink-0 rounded-xl border border-slate-200 bg-white p-5 text-sm text-slate-500 shadow-sm">插件 ${esc(fullName)} 不存在。</div>`

  const yn = (v) => (v ? badge('是', 'green') : '<span class="text-slate-300">—</span>')
  const info = [
    ['full_name', esc(plugin[0])],
    ['pkg_name', plugin[4] ? esc(plugin[4]) : '<span class="text-slate-300">—</span>'],
    ['kind / version', `${esc(plugin[3] ?? '')} ${esc(plugin[5] ?? '')}`],
    ['description', esc(plugin[6] ?? '')],
    ['license', esc(plugin[7] ?? '—')],
    ['stars / forks', `${plugin[8]} / ${plugin[9]}`],
    ['score / grade', `${plugin[10] ?? '—'} ${plugin[11] ? badge(plugin[11], GRADE_TONE[plugin[11]]) : ''}`],
    ['category', esc(plugin[12] ?? '—')],
    ['in_awesome / covered', `${yn(plugin[13])} / ${yn(plugin[14])}`],
    ['pushed_at', esc(String(plugin[15] ?? '—').slice(0, 19))],
    ['repo', `<a class="text-indigo-600 hover:underline" href="${esc(plugin[16])}">${esc(plugin[16])}</a>`],
  ].map(([k, v]) => field(k, v)).join('')

  const scoreRows = scores.map((s) => `<tr>
    <td class="px-3 py-1.5 font-mono text-xs">${esc(fmtDay(s[0]))}</td>
    <td class="px-3 py-1.5 text-right font-semibold">${s[1]}</td>
    <td class="px-3 py-1.5">${badge(s[2], GRADE_TONE[s[2]])}</td></tr>`).join('')

  const dlRows = downloads.map((d) => `<tr>
    <td class="px-3 py-1.5 font-mono text-xs">${esc(fmtDay(d[0]))}</td>
    <td class="px-3 py-1.5 text-right font-semibold">${d[1]}</td></tr>`).join('')

  const eventRows = events.map((e) => `<div class="flex items-baseline gap-2 py-1">
    <span class="w-16 shrink-0 font-mono text-xs text-slate-400">${esc(fmtDay(e[2]))}</span>
    <span class="shrink-0">${badge(e[0], TYPE_TONE[e[0]])}</span>
    <span class="min-w-0 truncate text-xs text-slate-600">${eventSummary(e[0], parsePayload(e[3]))}</span>
  </div>`).join('')

  const reportRows = reports.map((r) => `<div class="flex items-baseline gap-2 py-1">
    <span class="w-16 shrink-0 font-mono text-xs text-slate-400">${esc(String(r[2]).slice(5, 16))}</span>
    <a class="min-w-0 truncate font-mono text-xs text-indigo-600 hover:underline" href="/admin/reports?sig=${encodeURIComponent(r[0])}">${esc(r[0])}</a>
    <span class="shrink-0">${badge(r[1])}</span>
  </div>`).join('')

  const llm = tags
    ? field('LLM 分类 / 置信度', `${esc(tags[0] ?? '—')} · ${tags[3] ?? '—'}`) +
      field('能力标签', esc(tags[1] ?? '—')) +
      field('摘要（中）', esc(tags[2] ?? '—')) +
      field('标注模型 / 时间', `${esc(tags[4] ?? '—')} · ${esc(String(tags[5] ?? '').slice(0, 19))}`)
    : '<div class="px-4 py-3 text-xs text-slate-400">暂无 LLM 标注</div>'

  const compatRows = compat.map((c) => `<tr>
    <td class="px-3 py-1.5 font-mono text-xs">${esc(c[0] ?? '')}</td>
    <td class="px-3 py-1.5 font-mono text-xs">${esc(c[1] ?? '')}</td>
    <td class="px-3 py-1.5 text-xs text-slate-400">${esc(fmtDay(c[2]))}</td></tr>`).join('')

  const empty = (t) => `<div class="text-xs text-slate-400">${t}</div>`
  const section = (title, inner) => `
    <div class="border-b border-slate-100 p-4">
      <div class="mb-2 text-xs font-semibold text-slate-500">${title}</div>
      ${inner}
    </div>`
  const detailTable = (label, rowsHtml) => `<details class="mt-2">
      <summary class="cursor-pointer text-xs text-slate-400 hover:text-slate-600">${label}</summary>
      <table class="mt-1 min-w-full text-sm"><tbody class="divide-y divide-slate-100">${rowsHtml}</tbody></table>
    </details>`

  return drawer(
    `插件 · ${esc(fullName)}`,
    `/admin/plugins?${backQs}`,
    info +
    section(`分数趋势（近 ${SCORE_DAYS} 天）`, scores.length
      ? scoreChart(scores) + detailTable('明细表格', scoreRows)
      : empty('暂无分数历史')) +
    section(`下载趋势（近 ${DL_WEEKS} 周）`, downloads.length
      ? dlChart(downloads) + detailTable('明细表格', dlRows)
      : empty('暂无下载数据')) +
    section('事件时间线', eventRows || empty('暂无插件级事件')) +
    section(`崩溃上报（共 ${reportCount ?? 0} 条）`, reportRows || empty('暂无崩溃上报')) +
    section('LLM 标注', `<div class="-mx-4">${llm}</div>`) +
    section('兼容观察（按 pkg_name 关联，最近 5 条）', compatRows
      ? `<table class="min-w-full text-sm"><tbody class="divide-y divide-slate-100">${compatRows}</tbody></table>`
      : empty('暂无记录')),
  )
}

export async function onRequestGet(context) {
  const denied = guard(context)
  if (denied) return denied
  const { request, env } = context
  if (!env.DB9_TOKEN) return new Response('DB9_TOKEN not configured', { status: 503 })

  const url = new URL(request.url)
  const q = (url.searchParams.get('q') ?? '').trim().slice(0, 80)
  const sortKey = SORTS[url.searchParams.get('sort')] ? url.searchParams.get('sort') : 'stars'
  const pageNum = Math.max(1, Number(url.searchParams.get('page')) || 1)
  const drawerName = url.searchParams.get('plugin') ?? ''

  try {
    const [gradeRows, catRows] = await Promise.all([
      sql(env, 'SELECT DISTINCT grade FROM plugins WHERE grade IS NOT NULL ORDER BY 1'),
      sql(env, 'SELECT DISTINCT category FROM plugins WHERE category IS NOT NULL ORDER BY 1'),
    ])
    const grades = gradeRows.map((r) => r[0])
    const categories = catRows.map((r) => r[0])
    const grade = grades.includes(url.searchParams.get('grade')) ? url.searchParams.get('grade') : ''
    const category = categories.includes(url.searchParams.get('category')) ? url.searchParams.get('category') : ''

    const conds = []
    if (q) {
      const like = sqlStr(`%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`)
      conds.push(`(p.full_name ILIKE ${like} ESCAPE '\\' OR p.description ILIKE ${like} ESCAPE '\\' OR p.pkg_name ILIKE ${like} ESCAPE '\\')`)
    }
    if (grade) conds.push(`p.grade = ${sqlStr(grade)}`)
    if (category) conds.push(`p.category = ${sqlStr(category)}`)
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''

    const from = `FROM plugins p
      LEFT JOIN (SELECT pkg_name, sum(downloads) AS dl FROM plugin_downloads GROUP BY pkg_name) d ON d.pkg_name = p.pkg_name
      ${where}`
    const [[count], rows] = await Promise.all([
      sql(env, `SELECT count(*) ${from}`).then((r) => r[0]),
      sql(env, `SELECT p.full_name, p.description, p.grade, p.category, p.stars, p.score, d.dl, p.version
                ${from} ORDER BY ${SORTS[sortKey][1]} LIMIT ${PAGE_SIZE} OFFSET ${(pageNum - 1) * PAGE_SIZE}`),
    ])
    const pages = Math.max(1, Math.ceil(count / PAGE_SIZE))

    const qs = new URLSearchParams()
    if (q) qs.set('q', q)
    if (grade) qs.set('grade', grade)
    if (category) qs.set('category', category)
    if (sortKey !== 'stars') qs.set('sort', sortKey)

    const bodyRows = rows.map((r) => `<tr class="hover:bg-indigo-50 ${drawerName === r[0] ? 'bg-indigo-50' : ''}">
      <td class="max-w-72 px-4 py-2.5">
        <a class="font-mono text-xs font-semibold text-indigo-600 hover:underline" href="/admin/plugins?${qs}&plugin=${encodeURIComponent(r[0])}">${esc(r[0])}</a>
        <div class="mt-0.5 truncate text-xs text-slate-400">${esc((r[1] ?? '').slice(0, 80))}</div>
      </td>
      <td class="px-4 py-2.5">${r[2] ? badge(r[2], GRADE_TONE[r[2]]) : ''}</td>
      <td class="px-4 py-2.5 text-xs">${esc(r[3] ?? '—')}</td>
      <td class="px-4 py-2.5 text-right font-semibold">${r[4] ?? '—'}</td>
      <td class="px-4 py-2.5 text-right">${r[5] ?? '—'}</td>
      <td class="px-4 py-2.5 text-right">${r[6] ?? '—'}</td>
      <td class="px-4 py-2.5 font-mono text-xs text-slate-400">${esc(r[7] ?? '')}</td></tr>`).join('')

    const opts = (list, cur) =>
      `<option value="">全部</option>` +
      list.map((v) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(v)}</option>`).join('')
    const sortOpts = Object.entries(SORTS).map(([k, [, label]]) =>
      `<option value="${k}" ${k === sortKey ? 'selected' : ''}>${k === 'stars' ? 'stars' : label}</option>`).join('')

    const pageLink = (p, label, enabled) => enabled
      ? `<a href="/admin/plugins?${qs}&page=${p}" class="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm hover:bg-slate-50">${label}</a>`
      : `<span class="rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-300">${label}</span>`

    const panel = drawerName ? await pluginDrawer(env, drawerName, qs.toString()) : ''

    return page(layout({
      title: '插件',
      active: 'plugins',
      content: `
      <form method="get" action="/admin/plugins" class="mb-5 flex flex-wrap items-center gap-2">
        <input name="q" value="${esc(q)}" placeholder="搜索 full_name / description / pkg_name" size="32"
          class="rounded-lg border border-slate-300 px-3 py-1.5 text-sm focus:border-indigo-500 focus:outline-none">
        <select name="grade" class="rounded-lg border border-slate-300 px-2 py-1.5 text-sm">${opts(grades, grade)}</select>
        <select name="category" class="max-w-48 rounded-lg border border-slate-300 px-2 py-1.5 text-sm">${opts(categories, category)}</select>
        <select name="sort" class="rounded-lg border border-slate-300 px-2 py-1.5 text-sm">${sortOpts}</select>
        <button class="rounded-lg bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-700">过滤</button>
        <a href="/admin/plugins" class="px-2 text-sm text-slate-500 hover:underline">重置</a>
        <span class="ml-auto text-sm text-slate-400">共 ${count} 个插件</span>
      </form>
      <div class="flex items-start gap-6">
        <div class="min-w-0 flex-1">
          ${table(['插件', 'grade', 'category', 'stars', 'score', '下载量', '版本'], bodyRows)}
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
