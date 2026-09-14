// GET /admin/llm-stats — LLM 转发调用统计：总览卡片 + 按天（14 天）+ 按模型 + 最近 50 条。
// 数据来自 db9 llm_calls 表（/v1/llm 写入，见 functions/_lib/llm.js）：
// 只存统计字段（模型/token 数/延迟/状态码/错误签名），绝不存消息内容。

import { badge, card, esc, errorPage, guard, layout, page, sql, table } from './_layout.js'
import { ensureCallsTable } from '../_lib/llm.js'

const fmtNum = (n) => (n == null ? '—' : Number(n).toLocaleString('en-US'))

export async function onRequestGet(context) {
  const denied = guard(context)
  if (denied) return denied
  const { env } = context
  if (!env.DB9_TOKEN) return new Response('DB9_TOKEN not configured', { status: 503 })

  let totals = [0, 0, 0, null]
  let byDay = []
  let byModel = []
  let recent = []
  try {
    await ensureCallsTable(env)
    ;[totals, byDay, byModel, recent] = await Promise.all([
      sql(env, `SELECT count(*), count(*) FILTER (WHERE ok), coalesce(sum(total_tokens),0),
                       round(avg(latency_ms) FILTER (WHERE ok)) FROM llm_calls`).then((r) => r[0]),
      sql(env, `SELECT to_char(d, 'MM-DD'), count(*), count(*) FILTER (WHERE NOT ok),
                       coalesce(sum(prompt_tokens),0), coalesce(sum(completion_tokens),0), round(avg(latency_ms))
                FROM (SELECT date_trunc('day', created_at) AS d, ok, prompt_tokens, completion_tokens, latency_ms
                      FROM llm_calls WHERE created_at > now() - interval '14 days') t
                GROUP BY d ORDER BY d DESC`),
      sql(env, `SELECT model, count(*), coalesce(sum(total_tokens),0), round(avg(latency_ms))
                FROM llm_calls GROUP BY model ORDER BY count(*) DESC LIMIT 10`),
      sql(env, `SELECT created_at, model, upstream_status, ok, prompt_tokens, completion_tokens, latency_ms, error
                FROM llm_calls ORDER BY id DESC LIMIT 50`),
    ])
  } catch (err) {
    return errorPage(err)
  }

  const okRate = totals[0] ? `${Math.round((totals[1] / totals[0]) * 100)}%` : '—'

  const dayRows = byDay.map((r) => `<tr class="hover:bg-slate-50">
    <td class="px-4 py-2.5 font-mono text-xs">${esc(r[0])}</td>
    <td class="px-4 py-2.5 text-right font-semibold">${r[1]}</td>
    <td class="px-4 py-2.5 text-right ${r[2] ? 'text-red-600' : 'text-slate-300'}">${r[2]}</td>
    <td class="px-4 py-2.5 text-right">${fmtNum(r[3])}</td>
    <td class="px-4 py-2.5 text-right">${fmtNum(r[4])}</td>
    <td class="px-4 py-2.5 text-right">${r[5] ?? '—'}ms</td></tr>`).join('')

  const modelRows = byModel.map((r) => `<tr class="hover:bg-slate-50">
    <td class="px-4 py-2.5 font-mono text-xs">${esc(r[0])}</td>
    <td class="px-4 py-2.5 text-right font-semibold">${r[1]}</td>
    <td class="px-4 py-2.5 text-right">${fmtNum(r[2])}</td>
    <td class="px-4 py-2.5 text-right">${r[3] ?? '—'}ms</td></tr>`).join('')

  const recentRows = recent.map((r) => `<tr class="hover:bg-slate-50">
    <td class="px-4 py-2.5 text-slate-400">${esc(String(r[0]).slice(5, 19).replace('T', ' '))}</td>
    <td class="px-4 py-2.5 font-mono text-xs">${esc(r[1])}</td>
    <td class="px-4 py-2.5">${r[3] ? badge(String(r[2]), 'green') : badge(String(r[2]) || 'err', 'red')}</td>
    <td class="px-4 py-2.5 text-right">${r[4] ?? '—'}</td>
    <td class="px-4 py-2.5 text-right">${r[5] ?? '—'}</td>
    <td class="px-4 py-2.5 text-right">${r[6]}ms</td>
    <td class="px-4 py-2.5 text-xs text-red-600">${esc(r[7] ?? '')}</td></tr>`).join('')

  return page(layout({
    title: 'LLM 统计',
    active: 'llm-stats',
    content: `
      <div class="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        ${card('总调用', fmtNum(totals[0]), '全部时间累计')}
        ${card('成功率', okRate, `失败 ${fmtNum(totals[0] - (totals[1] ?? 0))} 次`)}
        ${card('总 tokens', fmtNum(totals[2]), 'DeepSeek 计费口径（入+出）')}
        ${card('平均延迟', totals[3] != null ? `${fmtNum(totals[3])} ms` : '—', '仅成功调用')}
      </div>
      <div class="mb-8 grid grid-cols-1 gap-8 2xl:grid-cols-2">
        <section>
          <h2 class="mb-3 font-semibold text-slate-900">按天（近 14 天）</h2>
          ${table(['日期', '调用', '失败', '入 tokens', '出 tokens', '平均延迟'], dayRows)}
        </section>
        <section>
          <h2 class="mb-3 font-semibold text-slate-900">按模型</h2>
          ${table(['模型', '调用', 'tokens', '平均延迟'], modelRows)}
        </section>
      </div>
      <section class="mb-4">
        <h2 class="mb-3 font-semibold text-slate-900">最近 50 次调用</h2>
        ${table(['时间', '模型', '状态', '入', '出', '延迟', '错误'], recentRows)}
      </section>
      <p class="text-xs text-slate-400">只记录统计字段（模型 / token 数 / 延迟 / 状态码 / 错误签名），不存消息内容；90 天滚动清理。测试按钮产生的 ping 调用也计入。</p>`,
  }))
}

export function onRequest() {
  return new Response('method not allowed', { status: 405 })
}
