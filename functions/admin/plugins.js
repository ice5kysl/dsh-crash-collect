// GET /admin/plugins — 插件库：搜索/过滤/排序/分页；?plugin=<full_name> 右侧抽屉
// 抽屉内容：完整信息 + 近 30 天分数历史 + 周下载 + LLM 标注 + 兼容观察

import { badge, drawer, esc, errorPage, field, guard, layout, page, sql, table } from './_layout.js'

const PAGE_SIZE = 30
const SCORE_DAYS = 30

const SORTS = {
  stars: ['stars', 'p.stars DESC'],
  score: ['score', 'p.score DESC NULLS LAST'],
  downloads: ['下载量', 'dl DESC NULLS LAST'],
}

const GRADE_TONE = { S: 'green', A: 'green', B: 'indigo', C: 'amber', D: 'red' }

// 值入库前统一转义单引号；grade/category/sort 再与库内实际取值比对（双保险）
const sqlStr = (v) => `'${String(v).replace(/'/g, "''")}'`

async function pluginDrawer(env, fullName, backQs) {
  const [plugin, scores, downloads, tags] = await Promise.all([
    sql(env, `SELECT full_name, owner, repo, kind, pkg_name, version, description, license, stars, forks, score, grade, category, in_awesome, covered, pushed_at, html_url
              FROM plugins WHERE full_name = ${sqlStr(fullName)} LIMIT 1`).then((r) => r[0]),
    sql(env, `SELECT date, score, grade FROM plugin_scores
              WHERE full_name = ${sqlStr(fullName)} AND date > current_date - interval '${SCORE_DAYS} days'
              ORDER BY date DESC LIMIT 15`),
    sql(env, `SELECT week_start, downloads FROM plugin_downloads
              WHERE pkg_name = (SELECT pkg_name FROM plugins WHERE full_name = ${sqlStr(fullName)})
              ORDER BY week_start DESC LIMIT 8`),
    sql(env, `SELECT category, capability_tags, summary_zh, confidence, model, tagged_at
              FROM plugin_llm_tags WHERE full_name = ${sqlStr(fullName)} LIMIT 1`).then((r) => r[0]),
  ])
  if (!plugin) return `<div class="w-[42rem] max-w-[90vw] shrink-0 rounded-xl border border-slate-200 bg-white p-5 text-sm text-slate-500 shadow-sm">插件 ${esc(fullName)} 不存在。</div>`

  const compat = plugin[4]
    ? await sql(env, `SELECT version, client, observed_at FROM compat_observations
                      WHERE pkg_name = ${sqlStr(plugin[4])} ORDER BY observed_at DESC LIMIT 5`)
    : []

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
    <td class="px-3 py-1.5 font-mono text-xs">${esc(String(s[0]).slice(0, 10))}</td>
    <td class="px-3 py-1.5 text-right font-semibold">${s[1]}</td>
    <td class="px-3 py-1.5">${badge(s[2], GRADE_TONE[s[2]])}</td></tr>`).join('')

  const dlRows = downloads.map((d) => `<tr>
    <td class="px-3 py-1.5 font-mono text-xs">${esc(String(d[0]).slice(0, 10))}</td>
    <td class="px-3 py-1.5 text-right font-semibold">${d[1]}</td></tr>`).join('')

  const llm = tags
    ? field('LLM 分类 / 置信度', `${esc(tags[0] ?? '—')} · ${tags[3] ?? '—'}`) +
      field('能力标签', esc(tags[1] ?? '—')) +
      field('摘要（中）', esc(tags[2] ?? '—')) +
      field('标注模型 / 时间', `${esc(tags[4] ?? '—')} · ${esc(String(tags[5] ?? '').slice(0, 19))}`)
    : '<div class="px-4 py-3 text-xs text-slate-400">暂无 LLM 标注</div>'

  const compatRows = compat.map((c) => `<tr>
    <td class="px-3 py-1.5 font-mono text-xs">${esc(c[0] ?? '')}</td>
    <td class="px-3 py-1.5 font-mono text-xs">${esc(c[1] ?? '')}</td>
    <td class="px-3 py-1.5 text-xs text-slate-400">${esc(String(c[2]).slice(0, 10))}</td></tr>`).join('')

  const section = (title, inner) => `
    <div class="border-b border-slate-100 p-4">
      <div class="mb-2 text-xs font-semibold text-slate-500">${title}</div>
      ${inner}
    </div>`

  return drawer(
    `插件 · ${esc(fullName)}`,
    `/admin/plugins?${backQs}`,
    info +
    section(`分数历史（近 ${SCORE_DAYS} 天）`, scoreRows
      ? `<table class="min-w-full text-sm"><tbody class="divide-y divide-slate-100">${scoreRows}</tbody></table>`
      : '<div class="text-xs text-slate-400">暂无记录</div>') +
    section('周下载（最近 8 周）', dlRows
      ? `<table class="min-w-full text-sm"><tbody class="divide-y divide-slate-100">${dlRows}</tbody></table>`
      : '<div class="text-xs text-slate-400">暂无记录</div>') +
    section('LLM 标注', `<div class="-mx-4">${llm}</div>`) +
    section(`兼容观察（按 pkg_name 关联，最近 5 条）`, compatRows
      ? `<table class="min-w-full text-sm"><tbody class="divide-y divide-slate-100">${compatRows}</tbody></table>`
      : '<div class="text-xs text-slate-400">暂无记录</div>'),
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
