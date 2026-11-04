-- 镜盘自建部署 · SQLite 表结构（Node 22+ 内置 node:sqlite）
-- 金额一律用 INTEGER 存「微元」(1e-6 元)，避免浮点误差；数量为股数 INTEGER。
-- 撮合的可复现性依赖 trades 只追加不修改；snapshots 与 events 用唯一索引保证重复写入幂等。

CREATE TABLE IF NOT EXISTS users (
  id           TEXT PRIMARY KEY,
  username     TEXT NOT NULL UNIQUE,
  display      TEXT NOT NULL,
  pass_hash    TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  last_login   TEXT,
  fail_count   INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);

CREATE TABLE IF NOT EXISTS orders (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  secid       TEXT NOT NULL,
  code        TEXT,
  name        TEXT,
  kind        TEXT,
  side        TEXT NOT NULL,
  mode        TEXT NOT NULL,
  qty         INTEGER NOT NULL,
  limit_price INTEGER,
  leaf        INTEGER NOT NULL,
  status      TEXT NOT NULL,
  day         TEXT NOT NULL,
  reason      TEXT,
  source      TEXT,
  fill_price  INTEGER,
  fill_qty    INTEGER,
  fill_fee    INTEGER,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS orders_user_status_idx ON orders (user_id, status);
CREATE INDEX IF NOT EXISTS orders_day_idx ON orders (day);

CREATE TABLE IF NOT EXISTS trades (
  id         TEXT PRIMARY KEY,
  order_id   TEXT UNIQUE,
  user_id    TEXT NOT NULL,
  symbol     TEXT NOT NULL,
  code       TEXT,
  name       TEXT,
  kind       TEXT,
  side       TEXT NOT NULL,
  qty        INTEGER NOT NULL,
  price      INTEGER NOT NULL,
  amount     INTEGER NOT NULL,
  fee        INTEGER NOT NULL,
  leaf       INTEGER NOT NULL,
  day        TEXT NOT NULL,
  source     TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS trades_user_created_idx ON trades (user_id, created_at);

CREATE TABLE IF NOT EXISTS events (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  kind       TEXT NOT NULL,
  message    TEXT NOT NULL,
  dedup      TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (user_id, dedup)
);

CREATE TABLE IF NOT EXISTS snapshots (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  day          TEXT NOT NULL,
  net_assets   INTEGER NOT NULL,
  total_assets INTEGER NOT NULL,
  cash         INTEGER,
  total_debt   INTEGER,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  UNIQUE (user_id, day)
);

CREATE TABLE IF NOT EXISTS watchlists (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  secid      TEXT NOT NULL,
  code       TEXT,
  name       TEXT,
  kind       TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (user_id, secid)
);
