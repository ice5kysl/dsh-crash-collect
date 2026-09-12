# dsh-crash-collect

dsh-why 崩溃案例上报的收集端点，部署在 **EdgeOne Pages Functions**（免费版：每月 300 万次边缘函数请求），存储用 **db9**（serverless Postgres，库 `dsh-data`）。

## 端点

| 路由 | 方法 | 说明 |
|---|---|---|
| `/v1/report` | POST | 上报一条失败案例；白名单校验，含白名单外字段的请求一律拒绝 |
| `/v1/stats` | GET | 公开统计（累计上报数 / 去重签名数） |
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

## 存储（db9）

库 `dsh-data`（id `toc6zdt4vd7j`，与 dsh-insights 生态表同库；2026-09 自旧库 `dsh-crash` 迁入），表 `reports`：

```sql
id BIGSERIAL PK · sig TEXT · category TEXT · shell TEXT ·
plugin TEXT · plugin_ver TEXT · code TEXT · turns INT · created_at TIMESTAMPTZ
```

聚合不再由端点维护——直接 `GROUP BY sig` 查询（精确计数，无 KV 时代的
read-modify-write 竞态）。pipeline 每日跑：

```sql
SELECT sig, category, count(*), min(created_at), max(created_at),
       count(DISTINCT shell), count(DISTINCT plugin)
FROM reports GROUP BY sig, category ORDER BY count(*) DESC;
```

## 环境变量（Pages 项目设置）

| 变量 | 用途 |
|---|---|
| `DB9_TOKEN` | db9 named API token（scoped 到本用途，可独立吊销） |
| `DB9_SQL_URL` | 可选，覆盖 SQL API 地址（默认库 `dsh-data`） |
| `EXPORT_KEY` | `/v1/export` 的访问密钥 |

## 部署

1. 推送本仓库到 GitHub，EdgeOne Pages 项目关联仓库（构建命令留空，输出目录 `public`），push 即自动部署。
2. 配好上面三个环境变量。
3. 本地调试（可选）：`npm i -g edgeone && edgeone pages dev`。

## 验证

```bash
# 上报
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
`data/crash-corpus.json`；dsh-why 诊断时经 `lib/net.mjs` 拉取，
拉不到就静默不显示（读路径与 compat-observed 同构，绝不阻塞诊断）。

## 冷启动种子（scripts/seed-corpus.mjs）

一次性运维工具：用 db9 `compat_observations` 表里的**实测**观察（真实发布包里
未守护的 require）给语料库灌种子，解决"收集端刚上线、语料为空"的冷启动。

- 每个 (插件, spec) 都交给 dsh-why 自己的诊断管线审判（构造加载器报错文本走
  `--error` 离线诊断），只有真的产出 R1 error finding 的案例才入库——判不出会崩
  的一律跳过，不灌虚构数据。
- sig 一律由 dsh-why `lib/share.mjs` 的 `findingSig` 产出、payload 一律过
  `buildSharePayloads`，脚本不重新实现签名逻辑。
- **幂等**：开跑前 `SELECT sig FROM reports` 取已存在签名集合，同 sig 跳过
  （批次内同样去重，1 案例 = 1 计数）；只 INSERT，永不改动已有行。重跑安全。
- 默认 cap 150 条，按"同 spec 的插件数"排序优先常见的雷。

```bash
DB9_TOKEN=<readonly token> node scripts/seed-corpus.mjs [--dry-run] [--cap=150]
# 可选：DSH_WHY_REPO（dsh-why 仓库路径，默认 ../../dsh-why）
# 可选：DSH_WHY_NPM_ROOT（dsh 全局安装的 npm root，判定基准 shell 取自它）
# 可选：SEED_ENDPOINT（覆盖上报端点，默认 https://api.dsh-why.com/v1/report）
```
