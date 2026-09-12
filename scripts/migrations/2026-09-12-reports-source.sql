-- 2026-09-12 · reports.source —— 把「用户上报」与「冷启动种子」分开
--
-- 背景：/admin 显示 累计上报 151 = 去重签名 151。追查发现 151 条里 150 条是
-- scripts/seed-corpus.mjs 首跑灌的种子（2026-09-12 03:43–03:44 UTC 一次连发），
-- 只有 1 条（2026-09-11 14:34 UTC, plugin=dsh-workspace-kit）不是种子。
-- 种子与真实上报混在同一张表且无标记，导致：
--   1) dsh-why 诊断会把它渲染成「社区语料：已见 N 例上报」；
--   2) /v1/stats 与 /admin 的对外数字虚高，且去重率恒为 100%。
--
-- 幂等：可重复执行；只把默认 'organic' 的行改判为 'seed'，绝不覆盖已有判定。
--
-- 执行：db9 db sql toc6zdt4vd7j -f scripts/migrations/2026-09-12-reports-source.sql

ALTER TABLE reports ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'organic';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reports_source_check') THEN
    ALTER TABLE reports ADD CONSTRAINT reports_source_check CHECK (source IN ('organic', 'seed'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS reports_source_idx ON reports (source);

-- 回填：首跑种子批次的时间窗（2026-09-12 03:43:34–03:44:33 UTC，共 150 条）。
-- 窗口取到分钟级以外，避免边界抖动误伤；该窗口内不存在其它来源的写入。
UPDATE reports SET source = 'seed'
WHERE source = 'organic'
  AND created_at >= timestamptz '2026-09-12 03:40:00+00'
  AND created_at <  timestamptz '2026-09-12 03:50:00+00';
