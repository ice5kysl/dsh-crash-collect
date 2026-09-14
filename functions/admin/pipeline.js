// GET /admin/pipeline — dsh-insights 定时 pipeline 运行监控。
// 数据来自 db9 pipeline_runs 表：refresh.yml 每次运行（schedule/dispatch）由
// bin/run-report.mjs 落一条记录（dsh-insights 仓库），含模式、状态、耗时。
// 本页回答一个问题：定时器到底跑没跑、什么时候断的。

import { badge, card, esc, errorPage, guard, layout, page, sql, table } from './_layout.js'

const MODE_BADGE = { hourly: ['hourly', 'slate'], daily: ['daily', 'indigo'], monday: ['monday', 'amber'], full: ['full', 'sky'] }
const STATUS_BADGE = { success: ['成功', 'green'], failure: ['失败', 'red'], cancelled: ['取消', 'slate'] }

export async function onRequestGet(context) {
  const denied = guard(context)
  if (denied) return denied
  const { env } = context
  if (!env.DB9_TOKEN) return new Response('DB9_TOKEN not configured', { status: 503 })

  try {
    await sql(env, `CREATE TABLE IF NOT EXISTS pipeline_runs (
      id BIGSERIAL PRIMARY KEY, run_id BIGINT NOT NULL, event TEXT NOT NULL DEFAULT '',
      mode TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT '',
      started_at TIMESTAMPTZ, finished_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      duration_ms INT, run_url TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`)

    const [totals, lastSuccess, lastDaily, runs] = await Promise.all([
      sql(env, `SELECT
                  count(*) FILTER (WHERE started_at > now() - interval '24 hours') AS day,
                  count(*) FILTER (WHERE status = 'failure' AND started_at > now() - interval '7 days') AS fail7d
                FROM pipeline_runs`).then((r) => r[0]),
      sql(env, "SELECT started_at FROM pipeline_runs WHERE status = 'success' ORDER BY started_at DESC LIMIT 1").then((r) => r[0] ?? [null]),
      sql(env, "SELECT started_at FROM pipeline_runs WHERE status = 'success' AND mode IN ('daily','monday') ORDER BY started_at DESC LIMIT 1").then((r) => r[0] ?? [null]),
      sql(env, `SELECT run_id, event, mode, status, started_at, duration_ms, run_url
                FROM pipeline_runs ORDER BY id DESC LIMIT 30`),
    ])

    const now = Date.now()
    const hoursSince = (t) => (t ? ((now - Date.parse(t)) / 3600000).toFixed(1) : null)
    const lastSuccessH = hoursSince(lastSuccess?.[0])
    const utcToday = new Date().toISOString().slice(0, 10)
    const dailyToday = lastDaily?.[0] && String(lastDaily[0]).slice(0, 10) === utcToday
    const utcHour = new Date().getUTCHours()
    const dailyLate = !dailyToday && utcHour >= 14

    const alerts = []
    if (lastSuccessH != null && Number(lastSuccessH) > 6) alerts.push(`距上次成功运行已 ${lastSuccessH} 小时（阈值 6h）——schedule 投递可能丢失`)
    if (dailyLate) alerts.push(`今日（UTC ${utcToday}）daily/monday 尚未运行，已过 UTC 14 点——日更数据在漏跑`)

    const runRows = runs.map((r) => {
      const [mb, mt] = MODE_BADGE[r[2]] ?? [r[2], 'slate']
      const [sb, st] = STATUS_BADGE[r[3]] ?? [r[3], 'slate']
      return `<tr class="hover:bg-slate-50">
        <td class="px-4 py-2.5 text-slate-400">${esc(String(r[4]).slice(0, 19).replace('T', ' '))}</td>
        <td class="px-4 py-2.5">${badge(mb, mt)}</td>
        <td class="px-4 py-2.5 text-slate-500">${esc(r[1])}</td>
        <td class="px-4 py-2.5">${badge(sb, st)}</td>
        <td class="px-4 py-2.5 text-right">${r[5] != null ? `${(r[5] / 1000).toFixed(0)}s` : '—'}</td>
        <td class="px-4 py-2.5"><a class="text-indigo-600 hover:underline" href="${esc(r[6] || '#')}">#${r[0]}</a></td></tr>`
    }).join('')

    return page(layout({
      title: 'Pipeline 监控',
      active: 'pipeline',
      content: `
        ${alerts.length ? `<div class="mb-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          <div class="mb-1 font-semibold">⚠️ 定时器异常</div>${alerts.map((a) => `<div>· ${esc(a)}</div>`).join('')}
          <div class="mt-1 text-xs">GitHub 仓库会自动开 ops-timer issue 告警（refresh.yml 的 run-report 步骤）。</div>
        </div>` : `<div class="mb-6 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">定时器运行正常。</div>`}
        <div class="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          ${card('今日 daily（UTC）', dailyToday ? badge('已跑', 'green') : badge('未跑', dailyLate ? 'red' : 'amber'), `UTC 今天 ${utcHour} 点 · 上次 daily ${lastDaily?.[0] ? esc(String(lastDaily[0]).slice(5, 16)).replace('T', ' ') : '—'}`)}
          ${card('距上次成功', lastSuccessH != null ? `${lastSuccessH} h` : '—', '任何模式')}
          ${card('近 24h 运行', totals[0] ?? 0, 'schedule + 手动')}
          ${card('近 7 天失败', totals[1] ?? 0, 'failure 计数')}
        </div>
        <section>
          <h2 class="mb-3 font-semibold text-slate-900">最近 30 次运行</h2>
          ${table(['开始时间 (UTC)', '模式', '触发', '状态', '耗时', 'run'], runRows, '暂无记录——等 refresh workflow 下次运行后自动出现', ['left', 'left', 'left', 'left', 'right', 'left'])}
        </section>
        <p class="mt-4 text-xs text-slate-400">记录由 dsh-insights 仓库 refresh.yml 的运行上报步骤写入（bin/run-report.mjs）：每次 schedule/dispatch 运行一条，失败也记录。缺口自检（&gt;6h 无成功 / UTC 14 点后 daily 缺席）命中时自动开 ops-timer issue。</p>`,
    }))
  } catch (err) {
    return errorPage(err)
  }
}

export function onRequest() {
  return new Response('method not allowed', { status: 405 })
}
