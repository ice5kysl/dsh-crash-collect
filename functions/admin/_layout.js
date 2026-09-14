// /admin 共享模块：鉴权、SQL、布局（Tailwind Play CDN + 侧边栏）
// 本文件以 _ 开头，仅被其他 admin 路由 import，不作为页面使用。

// db9 库已从 dsh-crash(wqxvoyf8yu05) 迁到 dsh-data(toc6zdt4vd7j)，reports 与生态表同库
export const DEFAULT_SQL_URL = 'https://api.db9.ai/customer/databases/toc6zdt4vd7j/sql'

export function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// Basic Auth：通过返回 null；未通过返回 401 Response。密码取 ADMIN_KEY，缺省回落 EXPORT_KEY。
export function guard({ request, env }) {
  const key = (env && (env.ADMIN_KEY || env.EXPORT_KEY)) || null
  if (!key) return new Response('admin not configured', { status: 503 })
  const auth = request.headers.get('authorization') || ''
  const pass = auth.startsWith('Basic ') ? atob(auth.slice(6)).split(':').slice(1).join(':') : ''
  if (pass !== key) {
    return new Response('401', {
      status: 401,
      headers: { 'www-authenticate': 'Basic realm="dsh-crash-admin"' },
    })
  }
  return null
}

export async function sql(env, query) {
  const res = await fetch((env && env.DB9_SQL_URL) || DEFAULT_SQL_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${env.DB9_TOKEN}` },
    body: JSON.stringify({ query }),
  })
  const body = await res.json().catch(() => null)
  if (!res.ok || body?.rows === undefined) throw new Error(body?.message ?? `HTTP ${res.status}`)
  return body.rows
}

export const RE_FILTER = /^[a-z0-9@/._+-]{1,128}$/i

const NAV = [
  { href: '/admin', key: 'overview', label: '总览', icon: 'M3 12l9-9 9 9M5 10v10h5v-6h4v6h5V10' },
  { href: '/admin/digest', key: 'digest', label: '运营速览', icon: 'M9 17v-6m4 6V7m4 10v-3M5 21h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v14a2 2 0 002 2z' },
  { group: '崩溃收集' },
  { href: '/admin/reports', key: 'reports', label: '上报明细', icon: 'M4 6h16M4 12h16M4 18h10' },
  { href: '/admin/signatures', key: 'signatures', label: '签名分析', icon: 'M4 19V5m0 14h16M8 15v-4m4 4V8m4 7v-6' },
  { group: '站点访问' },
  { href: '/admin/traffic', key: 'traffic', label: '流量分析', icon: 'M3 17l6-6 4 4 8-8M21 7v5h-5' },
  { group: '生态数据' },
  { href: '/admin/plugins', key: 'plugins', label: '插件', icon: 'M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4' },
  { href: '/admin/events', key: 'events', label: '事件', icon: 'M13 10V3L4 14h7v7l9-11h-7z' },
  { href: '/admin/letters', key: 'letters', label: '周报', icon: 'M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z' },
  { group: '数据库' },
  { href: '/admin/tables', key: 'tables', label: '表浏览', icon: 'M12 3c-4.4 0-8 1.3-8 3v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6c0-1.7-3.6-3-8-3zM4 12c0 1.7 3.6 3 8 3s8-1.3 8-3M4 6c0 1.7 3.6 3 8 3s8-1.3 8-3' },
]

export function layout({ title, active, content }) {
  const nav = NAV.map((n) => {
    if (n.group) {
      return `<div class="mt-5 px-3 pb-1 text-xs font-semibold uppercase tracking-wider text-slate-500 first:mt-0">${n.group}</div>`
    }
    const on = n.key === active
    return `<a href="${n.href}" class="ml-2 flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition ${
      on ? 'bg-indigo-600 text-white' : 'text-slate-300 hover:bg-slate-800 hover:text-white'
    }"><svg class="h-4 w-4 shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="${n.icon}"/></svg>${n.label}</a>`
  }).join('')

  return `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · dsh-data admin</title>
<script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-100 text-slate-800 antialiased">
<div class="flex min-h-screen">
  <aside class="fixed inset-y-0 left-0 flex w-60 flex-col bg-slate-900 px-4 py-6">
    <div class="mb-8 px-2">
      <div class="text-lg font-bold text-white">dsh-data</div>
      <div class="text-xs text-slate-400">生态数据管理后台</div>
    </div>
    <nav class="flex flex-col gap-1">${nav}</nav>
    <div class="mt-auto space-y-2 px-2 text-xs text-slate-500">
      <a href="/v1/stats" class="block hover:text-slate-300">公开统计 /v1/stats ↗</a>
      <a href="https://github.com/ice5kysl/dsh-crash-collect" class="block hover:text-slate-300">dsh-crash-collect ↗</a>
      <div>只收集白名单结构化字段</div>
    </div>
  </aside>
  <main class="ml-60 flex-1 p-8">
    <h1 class="mb-6 text-xl font-bold text-slate-900">${title}</h1>
    ${content}
  </main>
</div>
</body></html>`
}

export function page(html, status = 200) {
  return new Response(html, { status, headers: { 'content-type': 'text/html; charset=UTF-8' } })
}

export function errorPage(err) {
  return page(`<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;padding:40px">
    <h1>存储不可用</h1><p>${esc(err?.message ?? err)}</p></body>`, 502)
}

export const card = (label, value, sub = '') => `
  <div class="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
    <div class="text-sm text-slate-500">${label}</div>
    <div class="mt-1 text-3xl font-bold text-slate-900">${value}</div>
    ${sub ? `<div class="mt-1 text-xs text-slate-400">${sub}</div>` : ''}
  </div>`

export const table = (heads, rows, empty = '暂无数据') => `
  <div class="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
    <table class="min-w-full divide-y divide-slate-200 text-sm">
      <thead class="bg-slate-50"><tr>${heads.map((h) => `<th class="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">${h}</th>`).join('')}</tr></thead>
      <tbody class="divide-y divide-slate-100">${rows || `<tr><td colspan="${heads.length}" class="px-4 py-8 text-center text-slate-400">${empty}</td></tr>`}</tbody>
    </table>
  </div>`

export const badge = (text, tone = 'slate') => {
  const tones = {
    slate: 'bg-slate-100 text-slate-700',
    indigo: 'bg-indigo-100 text-indigo-700',
    red: 'bg-red-100 text-red-700',
    amber: 'bg-amber-100 text-amber-700',
    green: 'bg-emerald-100 text-emerald-700',
    sky: 'bg-sky-100 text-sky-700',
  }
  return `<span class="inline-block rounded-full px-2 py-0.5 text-xs font-medium ${tones[tone] ?? tones.slate}">${esc(text)}</span>`
}

// 来源徽章：organic = 真实用户上报（绿），seed = 冷启动种子（琥珀，机器灌入）
export const sourceBadge = (source) =>
  source === 'seed' ? badge('种子', 'amber') : badge('用户', 'green')

// 右侧抽屉（sticky aside）：全站详情统一走这里。width 按内容定（默认 w-[42rem]），
// max-w-[90vw] 保证窄屏不溢出
export const drawer = (title, closeHref, bodyHtml, width = 'w-[42rem]') => `
  <aside class="sticky top-8 max-h-[calc(100vh-6rem)] ${width} max-w-[90vw] shrink-0 overflow-y-auto rounded-xl border border-indigo-200 bg-white shadow-lg">
    <div class="flex items-center justify-between gap-2 border-b border-slate-200 px-4 py-3">
      <span class="break-all text-sm font-semibold">${title}</span>
      <a href="${closeHref}" class="shrink-0 rounded-lg px-2 py-1 text-sm text-slate-400 hover:bg-slate-100 hover:text-slate-700">✕</a>
    </div>
    ${bodyHtml}
  </aside>`

export const field = (label, valueHtml) => `
    <div class="border-b border-slate-100 px-4 py-2">
      <div class="text-xs text-slate-400">${label}</div>
      <div class="break-all font-mono text-xs text-slate-800">${valueHtml}</div>
    </div>`

// pre-wrap + break-all：宽抽屉里 JSON 自动换行，不出现横向滚动条
export const jsonBlock = (obj) => `
    <pre class="whitespace-pre-wrap break-all rounded-lg bg-slate-900 p-3 font-mono text-xs leading-relaxed text-slate-100">${esc(JSON.stringify(obj, null, 2))}</pre>`
