// 本地开发服务器：零依赖，把 functions/ 里的 EdgeOne Pages Functions 跑在本地。
//
//   DB9_TOKEN=xxx EXPORT_KEY=dsh ADMIN_KEY=dsh SEED_KEY=dsh-seed node scripts/dev.mjs [port]
//
// 然后访问 http://localhost:8787/admin （Basic Auth: 任意用户名 / $ADMIN_KEY）
// SEED_KEY 用于本地验证 x-seed-key → source=seed 的种子通道。

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PORT = Number(process.argv[2]) || 8787

// 路由表：[前缀, 模块路径]。/admin/* 与 /v1/* 走函数，其余走 public/ 静态。
const ROUTES = [
  ['/admin/reports', 'functions/admin/reports.js'],
  ['/admin/signatures', 'functions/admin/signatures.js'],
  ['/admin/traffic', 'functions/admin/traffic.js'],
  ['/admin/digest', 'functions/admin/digest.js'],
  ['/admin/tables', 'functions/admin/tables.js'],
  ['/admin/plugins', 'functions/admin/plugins.js'],
  ['/admin/events', 'functions/admin/events.js'],
  ['/admin/letters', 'functions/admin/letters.js'],
  ['/admin/llm', 'functions/admin/llm.js'],
  ['/admin', 'functions/admin/index.js'],
  ['/v1/report', 'functions/v1/report.js'],
  ['/v1/stats', 'functions/v1/stats.js'],
  ['/v1/export', 'functions/v1/export.js'],
  ['/v1/llm', 'functions/v1/llm.js'],
]

const MIME = { '.html': 'text/html; charset=UTF-8', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml' }

const env = {
  DB9_TOKEN: process.env.DB9_TOKEN,
  DB9_SQL_URL: process.env.DB9_SQL_URL,
  EXPORT_KEY: process.env.EXPORT_KEY,
  ADMIN_KEY: process.env.ADMIN_KEY,
  SEED_KEY: process.env.SEED_KEY,
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`)
    const route = ROUTES.find(([prefix]) => url.pathname === prefix || url.pathname === prefix + '/')

    if (route) {
      const mod = await import(join(ROOT, route[1]))
      const handler = mod[`onRequest${req.method[0]}${req.method.slice(1).toLowerCase()}`] ?? mod.onRequest
      if (!handler) {
        res.writeHead(405).end('method not allowed')
        return
      }
      const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await buffer(req) : undefined
      const request = new Request(url, { method: req.method, headers: req.headers, body })
      const response = await handler({ request, env, params: {} })
      res.writeHead(response.status, Object.fromEntries(response.headers))
      res.end(Buffer.from(await response.arrayBuffer()))
      return
    }

    // 静态文件（public/）
    const path = join(ROOT, 'public', url.pathname === '/' ? 'index.html' : url.pathname)
    if (!path.startsWith(join(ROOT, 'public'))) { res.writeHead(403).end(); return }
    try {
      const data = await readFile(path)
      res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' })
      res.end(data)
    } catch {
      res.writeHead(404).end('not found')
    }
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=UTF-8' })
    res.end(`dev server error: ${err?.stack ?? err}`)
  }
}).listen(PORT, () => {
  console.log(`dev server: http://localhost:${PORT}`)
  console.log(`admin:      http://localhost:${PORT}/admin  (用户任意 / 密码 $ADMIN_KEY)`)
  if (!env.DB9_TOKEN) console.warn('⚠ 未设 DB9_TOKEN，存储相关页面会报 503')
})

function buffer(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}
