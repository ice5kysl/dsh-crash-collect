// GET/POST /admin/llm — LLM 转发配置：DeepSeek key / 模型 / 调用方 client_key，
// 外加「发送测试请求」验证配置可用。配置存 db9 llm_config 表，见 functions/_lib/llm.js。

import { badge, card, esc, errorPage, guard, layout, page, sql, table } from './_layout.js'
import { DEFAULT_MODEL, ensureCallsTable, loadConfig, postChat, saveConfig } from '../_lib/llm.js'

const RE_MODEL = /^[a-z0-9._:-]{1,128}$/i
const fmtNum = (n) => (n == null ? '—' : Number(n).toLocaleString('en-US'))

// 调用统计：总览卡片 + 按天（14 天）+ 按模型 + 最近 50 条。只读统计字段，不碰消息内容。
async function renderStats(env) {
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
  } catch {
    return '' // 存储挂了不拖垮配置页
  }

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

  const okRate = totals[0] ? `${Math.round((totals[1] / totals[0]) * 100)}%` : '—'
  return `
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
    <p class="mb-8 text-xs text-slate-400">只记录统计字段（模型 / token 数 / 延迟 / 状态码 / 错误签名），不存消息内容；90 天滚动清理。</p>`
}

const input = (name, value, type = 'text', placeholder = '') => `
  <input name="${name}" type="${type}" value="${esc(value)}" placeholder="${esc(placeholder)}"
    class="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm focus:border-indigo-500 focus:outline-none">`

const label = (text, hint = '') => `
  <label class="block">
    <div class="mb-1 text-sm font-medium text-slate-700">${text}${hint ? ` <span class="font-normal text-slate-400">— ${hint}</span>` : ''}</div>`

async function render(context, { saved = false, testResult = null, form = null } = {}) {
  const { env } = context
  const config = await loadConfig(env)
  if (!config) return errorPage(new Error('DB9_TOKEN 未配置或存储不可用'))

  const apiKey = form?.apiKey ?? config.api_key?.value ?? ''
  const model = form?.model ?? config.model?.value ?? ''
  const clientKey = form?.clientKey ?? config.client_key?.value ?? ''
  const configured = Boolean(config.api_key?.value)
  const updatedAt = config.api_key?.updatedAt || config.model?.updatedAt || config.client_key?.updatedAt

  const callExample = `curl -X POST https://api.dsh-why.com/v1/llm \\
  -H 'content-type: application/json' \\
  -H 'x-llm-key: ${clientKey || '<client_key>'}' \\
  -d '{"prompt":"你好"}'`

  const statsHtml = await renderStats(env)

  return page(layout({
    title: 'LLM 转发',
    active: 'llm',
    content: `
      ${statsHtml}
      <div class="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        ${card('状态', configured ? badge('已配置', 'green') : badge('未配置', 'amber'), configured ? '服务端已持有 DeepSeek key' : '保存 api_key 后 /v1/llm 才可用')}
        ${card('模型', esc(config.model?.value || DEFAULT_MODEL), '请求可带 model 覆盖')}
        ${card('最近更新', updatedAt ? esc(String(updatedAt).slice(0, 19)) : '—', '保存后 30s 内生效')}
      </div>
      ${saved ? `<div class="mb-6 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">已保存。</div>` : ''}
      ${testResult ? renderTestResult(testResult) : ''}
      <div class="max-w-2xl space-y-8">
        <section class="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 class="mb-1 font-semibold text-slate-900">配置</h2>
          <p class="mb-5 text-sm text-slate-500">存在 db9 <code class="text-xs">llm_config</code> 表。留空的字段保持原值不变。</p>
          <form method="post" class="space-y-4">
            <input type="hidden" name="action" value="save">
            ${label('DeepSeek API Key', 'sk-…，只存服务端，绝不回传给调用方')}
              ${input('api_key', apiKey, 'password', 'sk-...')}
            </label>
            ${label('模型名', `缺省 ${DEFAULT_MODEL}`)}
              ${input('model', model, 'text', DEFAULT_MODEL)}
            </label>
            ${label('Client Key', '应用调用 /v1/llm 必须带的 x-llm-key')}
              ${input('client_key', clientKey, 'text', '随机长字符串')}
            </label>
            <div class="flex gap-3 pt-2">
              <button class="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700">保存</button>
            </div>
          </form>
        </section>
        <section class="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 class="mb-1 font-semibold text-slate-900">测试</h2>
          <p class="mb-4 text-sm text-slate-500">用<strong>已保存</strong>的配置向 DeepSeek 发一条 1-token 的 ping，验证 key 和模型名可用。改了配置请先保存再测。</p>
          <form method="post">
            <input type="hidden" name="action" value="test">
            <button class="rounded-lg border border-indigo-300 px-4 py-2 text-sm font-medium text-indigo-700 hover:bg-indigo-50">发送测试请求</button>
          </form>
        </section>
        <section class="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 class="mb-1 font-semibold text-slate-900">应用调用方式</h2>
          <p class="mb-3 text-sm text-slate-500">OpenAI chat completion 格式（非流式）。<code class="text-xs">messages</code> 或简写 <code class="text-xs">prompt</code> 二选一：</p>
          <pre class="overflow-x-auto rounded-lg bg-slate-900 p-3 font-mono text-xs leading-relaxed text-slate-100">${esc(callExample)}</pre>
          <pre class="mt-3 overflow-x-auto rounded-lg bg-slate-900 p-3 font-mono text-xs leading-relaxed text-slate-100">${esc(`// 或完整 messages 形式，可选 temperature(0-2) / max_tokens(≤8192) / model
{
  "messages": [
    {"role": "system", "content": "你是简洁的助手"},
    {"role": "user", "content": "你好"}
  ],
  "temperature": 0.7
}`)}</pre>
        </section>
      </div>`,
  }))
}

function renderTestResult(r) {
  if (!r.ok) {
    return `<div class="mb-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
      <div class="font-semibold">测试失败（${r.latencyMs}ms）</div>
      <pre class="mt-2 whitespace-pre-wrap break-all font-mono text-xs">${esc(r.error)}</pre></div>`
  }
  return `<div class="mb-6 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
    <div class="font-semibold">测试成功 · ${r.latencyMs}ms · ${esc(r.model)}</div>
    <pre class="mt-2 whitespace-pre-wrap break-all font-mono text-xs">${esc(r.reply)}</pre></div>`
}

export async function onRequestGet(context) {
  const denied = guard(context)
  if (denied) return denied
  try {
    const saved = new URL(context.request.url).searchParams.get('saved') === '1'
    return await render(context, { saved })
  } catch (err) {
    return errorPage(err)
  }
}

export async function onRequestPost(context) {
  const denied = guard(context)
  if (denied) return denied
  const { request, env } = context

  let fd
  try {
    fd = await request.formData()
  } catch {
    return new Response('invalid form', { status: 400 })
  }
  const action = String(fd.get('action') || 'save')

  if (action === 'test') {
    try {
      const config = await loadConfig(env)
      const apiKey = config?.api_key?.value
      if (!apiKey) return await render(context, { testResult: { ok: false, latencyMs: 0, error: '尚未保存 api_key' } })
      const model = config.model?.value || DEFAULT_MODEL
      const started = Date.now()
      const upstream = await postChat(apiKey, {
        model,
        messages: [{ role: 'user', content: 'ping，请只回复: ok' }],
        max_tokens: 16,
      }, 60000)
      const latencyMs = Date.now() - started
      const text = await upstream.text()
      if (!upstream.ok) {
        return await render(context, { testResult: { ok: false, latencyMs, error: `DeepSeek HTTP ${upstream.status}: ${text.slice(0, 500)}` } })
      }
      let reply = text
      try {
        reply = JSON.parse(text)?.choices?.[0]?.message?.content ?? text
      } catch { /* 非 JSON 时回显原文 */ }
      return await render(context, { testResult: { ok: true, latencyMs, model, reply: String(reply).slice(0, 500) } })
    } catch (err) {
      return await render(context, { testResult: { ok: false, latencyMs: 0, error: err?.message ?? String(err) } })
    }
  }

  // action=save
  const apiKey = String(fd.get('api_key') || '').trim()
  const model = String(fd.get('model') || '').trim()
  const clientKey = String(fd.get('client_key') || '').trim()

  const form = { apiKey, model, clientKey }
  if (apiKey.length > 256 || clientKey.length > 256) {
    return await render(context, { form, testResult: { ok: false, latencyMs: 0, error: 'api_key / client_key 不能超过 256 字符' } })
  }
  if (model && !RE_MODEL.test(model)) {
    return await render(context, { form, testResult: { ok: false, latencyMs: 0, error: '模型名只能含字母数字和 . _ : -' } })
  }

  try {
    await saveConfig(env, {
      api_key: apiKey || null,
      model: model || null,
      client_key: clientKey || null,
    })
    return new Response(null, { status: 303, headers: { location: '/admin/llm?saved=1' } })
  } catch (err) {
    return errorPage(err)
  }
}

export function onRequest() {
  return new Response('method not allowed', { status: 405 })
}
