# dsh-crash-collect

dsh-why 崩溃案例上报的收集端点，部署在 **EdgeOne Pages Functions**（免费版：每月 300 万次边缘函数请求），存储用 **db9**（serverless Postgres，库 `dsh-crash`）。

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

库 `dsh-crash`（id `wqxvoyf8yu05`），表 `reports`：

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
| `DB9_SQL_URL` | 可选，覆盖 SQL API 地址（默认库 `dsh-crash`） |
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
失败回落包内快照（读路径与 compat-observed 同构）。
