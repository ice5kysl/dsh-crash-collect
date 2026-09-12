# dsh-crash-collect

dsh-why 崩溃案例上报的收集端点，部署在 **EdgeOne Pages Functions**（免费版：每月 300 万次边缘函数请求），存储用 **db9**（serverless Postgres，库 `dsh-data`）。

## 端点

| 路由 | 方法 | 说明 |
|---|---|---|
| `/v1/report` | POST | 上报一条失败案例；白名单校验，含白名单外字段的请求一律拒绝 |
| `/v1/stats` | GET | 公开统计（用户上报数 / 去重签名数；冷启动种子单列，绝不混入） |
| `/v1/export?key=…` | GET | pipeline 拉取明细（JSONL，需 `EXPORT_KEY`）；pipeline 也可直接 psql 查库 |

## 上报协议（v1）

```json
{
  "v": 1,
  "sig": "r1_a1b2c3d4e5f60708",
  "category": "module-missing",
  "shell": "0.1.5-rc.1",
  "plugin": "dsh-foo",
  "plugin_ver": "1.2.0",
  "code": "R1",
  "turns": 12
}
```

- `v`、`sig`、`shell` 必填；其余可选
- 隐私红线：只接受上述结构化字段，不接收消息文本、工具参数、文件路径、IP
- 全局限流：20,000 条/24h

### 来源标记（source）

`source` 列由服务端判定，**不是可上报的 payload 字段**（`v1/report.js` 的 `reportSource()`）：

| source | 含义 | 判定 |
|---|---|---|
| `organic` | 真实用户 `--share` 上报（默认） | 任何普通请求 |
| `seed` | 冷启动种子（机器实测语料，非用户上报） | 请求头 `x-seed-key` === 环境变量 `SEED_KEY` |

未配置 `SEED_KEY` 时该头被忽略，一切都算 `organic`——种子永远不会冒充用户上报。统计、后台与下游语料一律按此列分开口径。

## 存储（db9）

库 `dsh-data`（id `toc6zdt4vd7j`，与 dsh-insights 生态表同库；2026-09 自旧库 `dsh-crash` 迁入），表 `reports`：

```sql
id BIGSERIAL PK · sig TEXT · category TEXT · shell TEXT ·
plugin TEXT · plugin_ver TEXT · code TEXT · turns INT ·
source TEXT NOT NULL DEFAULT 'organic' · created_at TIMESTAMPTZ
```

`source`（`organic` / `seed`）由 2026-09-12 的迁移加上：
`db9 db sql toc6zdt4vd7j -f scripts/migrations/2026-09-12-reports-source.sql`
（幂等；同时把首跑种子的 150 条回填为 `seed`）。

**为什么要有这一列**：首跑种子 150 条进了生产表却没标记，导致
`/admin` 的「累计上报 151 = 去重签名 151」看起来像 151 个用户上报，实际只有 1 条
不是种子；`dsh-why` 诊断还会把它渲染成「社区语料：已见 1 例上报」。现在
`count` 类指标一律只算 `organic`，种子单列。

聚合不再由端点维护——直接 `GROUP BY sig` 查询（精确计数，无 KV 时代的
read-modify-write 竞态）。统计口径按 `source` 分开：

```sql
-- 用户上报（对外数字）
SELECT count(*) FILTER (WHERE source = 'organic'),
       count(DISTINCT sig) FILTER (WHERE source = 'organic') FROM reports;

-- 语料聚合（pipeline 每日跑；count 只算 organic，种子单列 seededCount）
SELECT sig, category,
       count(*) FILTER (WHERE source = 'organic') AS organic,
       count(*) FILTER (WHERE source = 'seed')    AS seeded,
       min(created_at), max(created_at),
       count(DISTINCT shell), count(DISTINCT plugin)
FROM reports GROUP BY sig, category ORDER BY organic DESC, seeded DESC;
```

`/v1/stats` 返回 `total_reports` / `distinct_signatures`（= 用户上报）、
`seeded_reports` / `seeded_signatures`（= 种子）与 `corpus_reports` /
`corpus_signatures`（= 全表）。

## 环境变量（Pages 项目设置）

| 变量 | 用途 |
|---|---|
| `DB9_TOKEN` | db9 named API token（scoped 到本用途，可独立吊销） |
| `DB9_SQL_URL` | 可选，覆盖 SQL API 地址（默认库 `dsh-data`） |
| `EXPORT_KEY` | `/v1/export` 的访问密钥 |
| `SEED_KEY` | 可选；配置后，带同名 `x-seed-key` 头的上报才记为 `source='seed'`（种子脚本用） |

## 部署

1. 推送本仓库到 GitHub，EdgeOne Pages 项目关联仓库（构建命令留空，输出目录 `public`），push 即自动部署。
2. 配好上面四个环境变量（`SEED_KEY` 不配也能跑，只是种子通道关闭）。
3. 本地调试（可选）：`npm i -g edgeone && edgeone pages dev`。

## 验证

```bash
# 上报（普通请求 → source=organic）
curl -X POST https://api.dsh-why.com/v1/report \
  -H 'content-type: application/json' \
  -d '{"v":1,"sig":"test_sig_0001","category":"other","shell":"0.1.5-rc.1"}'

# 统计
curl https://api.dsh-why.com/v1/stats

# 导出（pipeline 用）
curl 'https://api.dsh-why.com/v1/export?key=<EXPORT_KEY>&limit=100'
```

## 下游

dsh-insights pipeline 每日查库（或调 `/v1/export`），按 `sig` 聚合进
`data/crash-corpus.json`：`count` 只算用户上报，种子进 `seededCount`，种子-only
的签名带 `seeded: true`；dsh-why 诊断时经 `lib/net.mjs` 拉取，命中用户上报才说
「社区语料：已见 N 例上报」，只有种子时说「已知崩溃模式：上游实测语料命中」。
拉不到就静默不显示（读路径与 compat-observed 同构，绝不阻塞诊断）。

## 冷启动种子（scripts/seed-corpus.mjs）

一次性运维工具：用 db9 `compat_observations` 表里的**实测**观察（真实发布包里
未守护的 require）给语料库灌种子，解决"收集端刚上线、语料为空"的冷启动。

- 每个 (插件, spec) 都交给 dsh-why 自己的诊断管线审判（构造加载器报错文本走
  `--error` 离线诊断），只有真的产出 R1 error finding 的案例才入库——判不出会崩
  的一律跳过，不灌虚构数据。
- sig 一律由 dsh-why `lib/share.mjs` 的 `findingSig` 产出、payload 一律过
  `buildSharePayloads`，脚本不重新实现签名逻辑。
- **必须带 `SEED_KEY`**：上报时用 `x-seed-key` 头声明身份，落库为 `source='seed'`。
  没有 `SEED_KEY` 直接退出——种子绝不允许以 `organic`（用户上报）身份入库。
- **幂等**：开跑前 `SELECT sig FROM reports` 取已存在签名集合，同 sig 跳过
  （批次内同样去重，1 案例 = 1 计数）；只 INSERT，永不改动已有行。重跑安全。
- 默认 cap 150 条，按"同 spec 的插件数"排序优先常见的雷。

```bash
DB9_TOKEN=<readonly token> SEED_KEY=<收集端 SEED_KEY> \
  node scripts/seed-corpus.mjs [--dry-run] [--cap=150]
# 可选：DSH_WHY_REPO（dsh-why 仓库路径，默认 ../../dsh-why）
# 可选：DSH_WHY_NPM_ROOT（dsh 全局安装的 npm root，判定基准 shell 取自它）
# 可选：SEED_ENDPOINT（覆盖上报端点，默认 https://api.dsh-why.com/v1/report）
```

### 首跑遗留（2026-09-12）

首跑 150 条是在 `source` 列存在之前用普通请求灌进去的，已由迁移
`scripts/migrations/2026-09-12-reports-source.sql` 按时间窗回填为 `seed`；
非种子的只有 1 条（id=3，`dsh-workspace-kit`，2026-09-11 14:34 UTC）。
