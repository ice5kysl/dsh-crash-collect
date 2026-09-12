#!/usr/bin/env node
/**
 * scripts/seed-corpus.mjs — 崩溃语料冷启动种子（一次性运维工具，幂等可重跑）。
 *
 * 数据源是 db9 compat_observations 表里的**实测**观察：真实发布包里未守护的
 * require（requires_v2 中 guard === 'unguarded' 的条目，每个包取最新 version）。
 * 每一个 (pkg, spec) 都交给 dsh-why 自己的诊断管线审判——构造一条该插件的加载器
 * 报错文本走 --error 离线诊断，只有真的产出 R1 error finding（当前 shell 模块表
 * 确实缺它、且不是内置图行）的案例才会入库；判不出会崩的一律跳过（宁缺毋滥）。
 *
 * 纪律（不可破坏）：
 *   - sig 一律由 dsh-why lib/share.mjs 的 findingSig 产出（经 buildSharePayloads），
 *     本脚本绝不重新实现签名逻辑；
 *   - payload 一律过 buildSharePayloads（收集端协议 v1 白名单）；
 *   - 只 POST，绝不改动已有行（包括 id=3 的第一条真实上报）；
 *   - 必须带 SEED_KEY：请求头 x-seed-key 与收集端环境变量 SEED_KEY 一致时才落库
 *     为 source='seed'。没有 SEED_KEY 就直接退出——种子绝不允许以 organic（用户
 *     上报）身份入库，那是 2026-09 首跑污染 151 条统计的根因。
 *
 * 幂等：开跑前 SELECT sig FROM reports 取出已存在的签名集合，同 sig 跳过；
 * 批次内同样按 sig 去重（1 案例 = 1 计数）。重跑只会补上新增的案例。
 *
 * 用法：
 *   DB9_TOKEN=<readonly token> SEED_KEY=<收集端 SEED_KEY> node scripts/seed-corpus.mjs [--dry-run] [--cap=150]
 *
 * 环境变量：
 *   DB9_TOKEN        必填，db9 只读 token（读 compat_observations 与现有 sig 集合）
 *   SEED_KEY         必填，与收集端 Pages 环境变量 SEED_KEY 一致，用于标记 source=seed
 *   DB9_SQL_URL      可选，覆盖 db9 SQL API 地址
 *   SEED_ENDPOINT    可选，覆盖上报端点（默认 https://api.dsh-why.com/v1/report）
 *   DSH_WHY_REPO     可选，dsh-why 仓库路径（默认 ../../dsh-why，即并排克隆）
 *   DSH_WHY_NPM_ROOT 可选，指向 dsh 全局安装的 npm root（默认按 dsh-why 自己的解析）
 */

import { pathToFileURL } from 'node:url'

const CAP_DEFAULT = 150
const DB9_SQL_URL = process.env.DB9_SQL_URL ?? 'https://api.db9.ai/customer/databases/toc6zdt4vd7j/sql'
const ENDPOINT = process.env.SEED_ENDPOINT ?? 'https://api.dsh-why.com/v1/report'
const TOKEN = process.env.DB9_TOKEN
const SEED_KEY = process.env.SEED_KEY

const args = new Set(process.argv.slice(2))
const DRY_RUN = args.has('--dry-run')
const capArg = [...args].find((a) => a.startsWith('--cap='))
const CAP = capArg ? Number(capArg.slice('--cap='.length)) : CAP_DEFAULT

// 与收集端 functions/v1/report.js 的白名单正则保持一致——发之前先在本地拦下
// 必被拒的 payload，省一轮 400。
const RE_NPM_NAME = /^(@[a-z0-9._-]+\/)?[a-z0-9._-]{1,100}$/
const RE_SEMVER = /^[0-9a-z.+-]{1,32}$/i

function die(msg) {
  console.error(`seed-corpus: ${msg}`)
  process.exit(2)
}

if (!TOKEN) die('DB9_TOKEN 未配置（只读 token 即可，用于读 compat_observations 与现有 sig 集合）')
if (!SEED_KEY) die('SEED_KEY 未配置——种子必须以 source=seed 入库；缺少它宁可不上报，也不污染用户上报口径')
if (!Number.isInteger(CAP) || CAP < 1) die(`--cap 非法：${capArg}`)

const dshWhyRepo = process.env.DSH_WHY_REPO ?? new URL('../../dsh-why', import.meta.url).pathname
const { runDiagnosis } = await import(pathToFileURL(`${dshWhyRepo}/lib/diagnose.mjs`).href)
const { buildSharePayloads } = await import(pathToFileURL(`${dshWhyRepo}/lib/share.mjs`).href)

async function sql(query) {
  const res = await fetch(DB9_SQL_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(30_000),
  })
  const body = await res.json().catch(() => null)
  if (!res.ok || body?.error || body?.message) {
    throw new Error(body?.error ?? body?.message ?? `HTTP ${res.status}`)
  }
  return body
}

/** 构造一条该插件的加载器报错文本，走 dsh-why --error 离线诊断管线。 */
async function diagnoseCase(env, plugin, spec) {
  const errorText = `HARNESS Failed to load plugins: failed to import loader entry 00000000 (${plugin}): client-modules: require("${spec}") missed the module table`
  return runDiagnosis({ env, offline: true, errorText })
}

/** 该案例的 R1 error finding；判不出会崩（resolved/conditional/unknown）→ null。 */
function crashFinding(report, spec) {
  return (report.findings ?? []).find(
    (f) => f.rule === 'R1' && f.severity === 'error' && (f.missing ?? []).includes(spec),
  ) ?? null
}

async function main() {
  console.log(`[seed] endpoint: ${ENDPOINT} · cap: ${CAP} · source=seed（x-seed-key 标记）${DRY_RUN ? ' · DRY-RUN（不发请求）' : ''}`)

  // 1) 实测观察：每个包最新 version 里的未守护 require
  const obs = await sql(
    `SELECT DISTINCT ON (pkg_name) pkg_name, version, requires_v2
     FROM compat_observations
     WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(requires_v2) e WHERE e->>'guard' = 'unguarded')
     ORDER BY pkg_name, observed_at DESC`,
  )
  const specPlugins = new Map() // spec → [{ pkg, version }]
  for (const [pkg, version, requiresV2] of obs.rows) {
    let entries
    try {
      entries = JSON.parse(requiresV2)
    } catch {
      continue
    }
    if (!Array.isArray(entries)) continue
    for (const e of entries) {
      if (e?.guard !== 'unguarded' || typeof e?.spec !== 'string' || !e.spec) continue
      if (e.spec.includes('"') || e.spec.includes("'")) continue // 进不了报错文本的 spec 无法诊断
      if (!specPlugins.has(e.spec)) specPlugins.set(e.spec, [])
      specPlugins.get(e.spec).push({ pkg, version })
    }
  }
  const ranked = [...specPlugins.entries()]
    .map(([spec, plugins]) => ({ spec, plugins }))
    .sort((a, b) => b.plugins.length - a.plugins.length || a.spec.localeCompare(b.spec))
  console.log(`[seed] ${obs.row_count} 个包有未守护 require，涉及 ${ranked.length} 个 spec`)

  // 2) 幂等：已入库的 sig 集合
  const existing = await sql('SELECT sig FROM reports')
  const seen = new Set(existing.rows.map(([sig]) => sig))
  console.log(`[seed] reports 表现有 ${seen.size} 个 sig（含真实上报，永不动它）`)

  // 3) 诊断环境：复用本机 dsh 安装（shell 版本即判定基准，也写进 payload.shell）
  const env = { ...process.env }
  const probe0 = await diagnoseCase(env, 'seed-probe', '__seed_probe_never_seeded__')
  const shell = probe0?.install?.shellVersion
  if (!shell) die('找不到 dsh 安装——用 DSH_WHY_NPM_ROOT 指向 dsh 全局安装的 npm root')
  console.log(`[seed] 判定基准 shell：${shell}（离线模式，包内模块表 + 本机图行）`)

  // 4) 逐 spec 审判：先探一次该 spec 在此 shell 上是否构成 R1 error（分类只取决于
  //    spec 与模块表/图行，与插件名无关），不构成则整个 spec 跳过。
  const payloads = []
  const skipped = { notCrash: [], noFinding: [], dup: [], invalid: [] }
  for (const { spec, plugins } of ranked) {
    if (payloads.length >= CAP) break
    const probe = await diagnoseCase(env, 'seed-probe', spec)
    if (!crashFinding(probe, spec)) {
      skipped.notCrash.push({ spec, plugins: plugins.length })
      continue
    }
    for (const { pkg, version } of [...plugins].sort((a, b) => a.pkg.localeCompare(b.pkg))) {
      if (payloads.length >= CAP) break
      if (!RE_NPM_NAME.test(pkg)) {
        skipped.invalid.push({ pkg, spec, why: 'plugin name rejected by collector whitelist' })
        continue
      }
      // 每个案例都跑完整诊断管线：finding 由 dsh-why 的规则引擎产出。
      const report = await diagnoseCase(env, pkg, spec)
      const finding = crashFinding(report, spec)
      if (!finding) {
        skipped.noFinding.push({ pkg, spec })
        continue
      }
      finding.version = version // 实测观察到的插件版本（可选白名单字段）
      const built = buildSharePayloads(report)
      if (built.length !== 1) {
        skipped.noFinding.push({ pkg, spec, why: `expected 1 payload, got ${built.length}` })
        continue
      }
      const [payload] = built
      if (payload.plugin_ver && !RE_SEMVER.test(payload.plugin_ver)) delete payload.plugin_ver
      if (seen.has(payload.sig)) {
        skipped.dup.push({ pkg, spec })
        continue
      }
      seen.add(payload.sig)
      payloads.push({ payload, spec })
    }
  }

  console.log(`[seed] spec 审判：${ranked.length} 个中 ${skipped.notCrash.length} 个在此 shell 上不构成 R1 崩溃（跳过）`)
  for (const { spec, plugins: n } of skipped.notCrash.slice(0, 10)) {
    console.log(`  - ${spec}（${n} 个插件）→ 可解析/条件可解析，不灌`)
  }
  console.log(`[seed] 待上报 ${payloads.length} 条（按同 spec 插件数排序，cap ${CAP}）；跳过：判不出崩溃 ${skipped.noFinding.length} · sig 重复 ${skipped.dup.length} · 白名单 ${skipped.invalid.length}`)

  // 5) 真实 POST（顺带压测收集端；限流 20000/24h 远不会触发）。
  //    x-seed-key 头让收集端把来源判为 seed，与用户上报彻底分开。
  let ok = 0
  let failed = 0
  for (const { payload, spec } of payloads) {
    if (DRY_RUN) {
      ok++
      console.log(`  [dry-run] ${payload.sig} ${payload.plugin}@${payload.plugin_ver ?? '?'} require("${spec}") shell=${payload.shell}`)
      continue
    }
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'dsh-crash-collect seed-corpus',
          'x-seed-key': SEED_KEY,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      })
      const body = await res.json().catch(() => null)
      if (res.ok && body?.ok) {
        ok++
        console.log(`  ✓ ${payload.sig} ${payload.plugin} (${body.id ?? 'ok'})`)
      } else {
        failed++
        console.log(`  ✗ ${payload.sig} ${payload.plugin} → ${body?.error ?? `HTTP ${res.status}`}`)
      }
    } catch (err) {
      failed++
      console.log(`  ✗ ${payload.sig} ${payload.plugin} → ${err?.message ?? err}`)
    }
  }
  console.log(`[seed] 完成：${ok} 条${DRY_RUN ? '（dry-run，未发送）' : '上报成功'}${failed ? `，${failed} 条失败` : ''}`)
  if (failed) process.exitCode = 1
}

main().catch((err) => die(err?.stack ?? String(err)))
