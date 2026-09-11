# dsh-crash-collect

dsh-why 崩溃案例上报的收集端点，部署在 **EdgeOne Pages Functions + KV**（免费版：每月 300 万次边缘函数请求，KV 1GB）。

## 端点

| 路由 | 方法 | 说明 |
|---|---|---|
| `/v1/report` | POST | 上报一条失败案例；白名单校验，不合规字段一律拒绝 |
| `/v1/stats` | GET | 公开统计（累计上报数 / 去重签名数） |
| `/v1/export?key=…` | GET | pipeline 拉取明细（JSONL，需 `EXPORT_KEY`） |

## 上报协议（v1）

```json
{
  "v": 1,
  "sig": "module_missing_a1b2c3",
  "category": "module-missing",
  "shell": "0.1.5-rc.1",
  "plugin": "dsh-foo",
  "plugin_ver": "1.2.0",
  "code": "ERR_MODULE_NOT_FOUND",
  "turns": 12
}
```

- `v`、`sig`、`shell` 必填；其余可选
- 隐私红线：只接受上述结构化字段，不接收消息文本、工具参数、文件路径、IP
- 全局限流：20,000 条/天（软上限，KV 近似计数）

## KV 结构

| key | value |
|---|---|
| `r_YYYYMMDD_<rand>` | 单条上报 JSON |
| `agg_<sig>` | 签名聚合 `{n, first, last, shells{}, plugins{}, categories{}}` |
| `meta_total` | 累计计数 |
| `cap_YYYYMMDD` | 当日限流计数 |

## 部署

1. 推送本仓库到 GitHub。
2. [EdgeOne Pages 控制台](https://pages.edgeone.ai/) → 创建项目 → 关联 GitHub 仓库：
   - 构建命令：留空；输出目录：`public`
3. 控制台 → 存储 → KV：**开通账户** → 创建命名空间（如 `crash_reports`）→
   绑定到本项目，**变量名必须是 `crash_kv`**。
4. 项目设置 → 环境变量：添加 `EXPORT_KEY`（随机长字符串，供 `/v1/export` 使用）。
5. 本地调试（可选）：`npm i -g edgeone && edgeone pages dev`。

## 验证

```bash
# 上报
curl -X POST https://<项目域名>/v1/report \
  -H 'content-type: application/json' \
  -d '{"v":1,"sig":"test_sig_0001","category":"other","shell":"0.1.5-rc.1"}'

# 统计
curl https://<项目域名>/v1/stats

# 导出（pipeline 用）
curl 'https://<项目域名>/v1/export?key=<EXPORT_KEY>&limit=100'
```

## 下游

dsh-insights pipeline 每日调用 `/v1/export`，按 `sig` 聚合进
`data/crash-corpus.json`；dsh-why 诊断时经 `lib/net.mjs` 拉取，
失败回落包内快照（读路径与 compat-observed 同构）。
