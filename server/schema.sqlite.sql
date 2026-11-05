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
  locked_until TEXT,
  role         TEXT NOT NULL DEFAULT 'user',    -- user | admin
  status       TEXT NOT NULL DEFAULT 'active',  -- active | frozen（冻结后只读，不能下单撤单）
  start_cash   INTEGER,                         -- 开户时冻结的人民币本金；NULL 表示按当期默认值
  start_cash_usd INTEGER                        -- 美股子账户的美元本金，与人民币池相互独立
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
  sort       INTEGER,
  created_at TEXT NOT NULL,
  UNIQUE (user_id, secid)
);

-- 后台可调参数。只允许「改了只影响未来」的键（费率、担保线、撮合熔断、注册开关等）；
-- 开户本金这类会重写历史账本的值不在此表，见 users.start_cash。
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT NOT NULL
);

-- 后台写操作留痕：只追加，不提供修改或删除。detail 里只放参数快照，绝不落口令与令牌。
CREATE TABLE IF NOT EXISTS audit (
  id         TEXT PRIMARY KEY,
  actor_id   TEXT,
  actor      TEXT,
  action     TEXT NOT NULL,
  target     TEXT,
  detail     TEXT,
  ip         TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_created_idx ON audit (created_at);
