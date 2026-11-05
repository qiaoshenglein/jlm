-- 镜盘自建部署 · PostgreSQL 表结构（DB_DRIVER=postgres 时使用）
-- 与应用代码约定：表放在 app schema（可用 DB_SCHEMA 改），金额 BIGINT 存「微元」，时间 TIMESTAMPTZ。
-- 前置：CREATE ROLE 与 GRANT 由你的 DBA 决定；建议给应用账号只授予这张图里的表权限。

CREATE SCHEMA IF NOT EXISTS app;

CREATE TABLE IF NOT EXISTS app.users (
  id           TEXT PRIMARY KEY,
  username     TEXT NOT NULL UNIQUE,
  display      TEXT NOT NULL,
  pass_hash    TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL,
  last_login   TIMESTAMPTZ,
  fail_count   INTEGER NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  role         TEXT NOT NULL DEFAULT 'user',
  status       TEXT NOT NULL DEFAULT 'active',
  start_cash   BIGINT,
  start_cash_usd BIGINT
);

CREATE TABLE IF NOT EXISTS app.sessions (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON app.sessions (user_id);

CREATE TABLE IF NOT EXISTS app.orders (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  secid       TEXT NOT NULL,
  code        TEXT,
  name        TEXT,
  kind        TEXT,
  side        TEXT NOT NULL,
  mode        TEXT NOT NULL,
  qty         BIGINT NOT NULL,
  limit_price BIGINT,
  leaf        INTEGER NOT NULL,
  status      TEXT NOT NULL,
  day         TEXT NOT NULL,
  reason      TEXT,
  source      TEXT,
  fill_price  BIGINT,
  fill_qty    BIGINT,
  fill_fee    BIGINT,
  created_at  TIMESTAMPTZ NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS orders_user_status_idx ON app.orders (user_id, status);
CREATE INDEX IF NOT EXISTS orders_day_idx ON app.orders (day);

CREATE TABLE IF NOT EXISTS app.trades (
  id         TEXT PRIMARY KEY,
  order_id   TEXT UNIQUE,
  user_id    TEXT NOT NULL,
  symbol     TEXT NOT NULL,
  code       TEXT,
  name       TEXT,
  kind       TEXT,
  side       TEXT NOT NULL,
  qty        BIGINT NOT NULL,
  price      BIGINT NOT NULL,
  amount     BIGINT NOT NULL,
  fee        BIGINT NOT NULL,
  leaf       INTEGER NOT NULL,
  day        TEXT NOT NULL,
  source     TEXT,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS trades_user_created_idx ON app.trades (user_id, created_at);

CREATE TABLE IF NOT EXISTS app.events (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  kind       TEXT NOT NULL,
  message    TEXT NOT NULL,
  dedup      TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (user_id, dedup)
);

CREATE TABLE IF NOT EXISTS app.snapshots (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  day          TEXT NOT NULL,
  net_assets   BIGINT NOT NULL,
  total_assets BIGINT NOT NULL,
  cash         BIGINT,
  total_debt   BIGINT,
  created_at   TIMESTAMPTZ NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL,
  UNIQUE (user_id, day)
);

CREATE TABLE IF NOT EXISTS app.watchlists (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  secid      TEXT NOT NULL,
  code       TEXT,
  name       TEXT,
  kind       TEXT,
  sort       BIGINT,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (user_id, secid)
);

CREATE TABLE IF NOT EXISTS app.settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS app.audit (
  id         TEXT PRIMARY KEY,
  actor_id   TEXT,
  actor      TEXT,
  action     TEXT NOT NULL,
  target     TEXT,
  detail     TEXT,
  ip         TEXT,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_created_idx ON app.audit (created_at);
