# 镜盘 · 对外接口说明（API v1）

一个账户可以生成多把 API 密钥，程序用密钥直接查行情、查账目、下单、撤单。
接口与网页交易台**共用同一套撮合、风控与账本实现**：不存在「API 走的规则不一样」这种第二套口径，
所有校验（整手数量、涨跌停、T+1、可用保证金、维持担保比例、熔断、冻结）都在服务端同一处发生。

- 应用内同样有一份说明：交易台顶栏「API」按钮（或按快捷键 `A`），里面直接带上你的真实密钥与可复制命令。
- 本文档与 `src/components/ApiDocs.tsx` 的端点表一一对应，改接口时两边要一起改。

---

## 1. 基础约定

| 项目 | 约定 |
| --- | --- |
| 基础地址 | 与网页端同源，例如 `http://127.0.0.1:8791` 或你的域名（自建部署见 `DEPLOY.md`） |
| 路径前缀 | `/api/v1/...`，全部 JSON |
| 鉴权 | 请求头 `x-api-key: mk_live_…`，或 `Authorization: Bearer mk_live_…`，或请求体字段 `apiKey` |
| 公开端点 | `/api/v1/markets`、`/api/v1/quote`、`/api/v1/quotes`、`/api/v1/search`、`/api/v1/chart`、`/api/v1/rules`、`/api/v1/leaderboard` 不带密钥也能取；带上密钥结果完全一致 |
| 时间 | ISO 8601 UTC（如 `2026-11-05T01:36:08.218Z`）。北京时间 = UTC + 8 |
| 金额 | **微元 / 微美元整数**：`1459800000` = ¥1459.80。除以 `1e6` 即为元/美元 |
| 价格 | 同上用微单位整数；最小报价单位 A 股股票 0.01 元、A 股 ETF 0.001 元、美股 0.01 美元 |
| 比例 | 浮点原值：`1.519` 即 151.9%；无负债时为 `null` |
| 市场 | 由标的决定：市场号 `1/0/2` 为沪深（人民币），`100/105/106/107` 为美股（美元）。请求里的 `market` 只影响查询视角，不改变归属 |
| 响应 | 成功 `{"ok":true, …}`；失败 `{"ok":false,"code":"…","message":"中文说明"}` + 合适的 HTTP 状态码 |

> 密钥请只放在请求头。URL query 会被 nginx / Caddy 的访问日志原样记下，本接口**不支持**用 query 传密钥。

### 标的写法

所有接受标的的地方（`symbol` / `secid` / `code`）三种写法都认，服务端统一解析：

| 写法 | 示例 | 解析结果 |
| --- | --- | --- |
| 完整 secid | `1.600519`、`105.AAPL`、`106.BRK.B` | 原样（美股代码自动转大写） |
| A 股 6 位代码 | `600519`、`510300`、`000725` | `5/6/9` 开头归沪市 `1.`，其余归深市/北交所 `0.` |
| 美股字母代码 | `AAPL`、`BRK.B` | 通过检索接口定位真实交易所，不猜 |

---

## 2. 快速开始

```bash
# 1) 在网页交易台登录后按 A 打开 API 面板，生成一把密钥（明文只显示这一次）
# 2) 查账户
curl -H "x-api-key: mk_live_你的密钥" http://127.0.0.1:8791/api/v1/account

# 3) 买 100 股贵州茅台（下单即撮合，响应里直接给成交结果）
curl -X POST http://127.0.0.1:8791/api/v1/order \
     -H "content-type: application/json" \
     -H "x-api-key: mk_live_你的密钥" \
     -d '{"symbol":"600519","side":"buy","qty":100,"type":"market"}'

# 4) 用 2 倍杠杆融资买入 20 股甲骨文，限价 200 美元
curl -X POST http://127.0.0.1:8791/api/v1/order \
     -H "content-type: application/json" \
     -H "x-api-key: mk_live_你的密钥" \
     -d '{"symbol":"ORCL","side":"margin_buy","qty":20,"type":"limit","price":200,"leverage":2}'
```

成交响应：

```json
{
  "ok": true,
  "market": "cn",
  "currency": "CNY",
  "status": "filled",
  "order": { "id": "…", "secid": "1.600519", "side": "buy", "qty": 100, "status": "filled", "day": "2026-11-05", "created_at": "…" },
  "fill": { "price": 1459800000, "qty": 100, "fee": 37954800, "amount": 145980000000 },
  "preview": { "amount": 145980000000, "fee": 37954800, "own": 145980000000, "borrow": 0, "cashAfter": 753020000000, "totalAssetsAfter": 899000000000, "totalDebtAfter": 0, "ratioAfter": null, "liquidationPrice": null },
  "account": { "cash": 753020000000, "netAssets": 899000000000, "positions": [ … ] },
  "queued": false
}
```

---

## 3. 行情查询

### `GET /api/v1/markets`
两市时段与熔断状态。程序在下单前先问这一步，能避免绝大多数「为什么没成交」。

```json
{ "ok": true,
  "clock": { "day": "2026-11-05", "hour": 9, "minute": 570, "second": 12, "weekend": false, "stamp": "2026-11-05 09:30:12" },
  "beijing": "2026-11-05 09:30:12", "et": "2026-11-04 20:30", "fx": 6668100,
  "markets": {
    "cn": { "market": "cn", "currency": "CNY", "day": "2026-11-05", "session": { "phase": "open", "stamp": "…" }, "matchable": true,  "paused": false },
    "us": { "market": "us", "currency": "USD", "day": "2026-11-04", "session": { "phase": "after", "stamp": "…" }, "matchable": false, "paused": false }
  } }
```

- `session.phase`：A 股 `auction | open | lunch | closed`；美股 `pre | open | after | closed`。
- `matchable`：该市场此刻是否参与撮合（时段 + 未被后台熔断 + 非周末）。
- `paused`：后台是否对该市场拉了撮合熔断。`matchable=false` 时挂单只会排队，不会成交。
- `fx`：美元兑离岸人民币（微单位，`6668100` = 6.6681）。

### `GET /api/v1/quote?symbol=…`
单标的实时行情。`limitUp` / `limitDown` 在美股为 `null`（没有每日涨跌停），不要当 0 用。

```json
{ "ok": true, "market": "us", "currency": "USD",
  "quote": { "secid": "105.AAPL", "code": "AAPL", "name": "苹果", "kind": "stock",
             "last": 353370000, "prevClose": 331900000, "open": 341580000, "high": 350810000, "low": 340990000,
             "change": 21470000, "pct": 6.47, "volume": 14226414, "amount": 4921552896,
             "turnover": 0.86, "marketCap": 852000000000,
             "limitUp": null, "limitDown": null, "limitRatio": 0, "tick": 10000,
             "ts": 1793803969, "sealedUp": false, "sealedDown": false } }
```

> `volume` 单位：A 股为「手」，美股为「股」；`amount` / `marketCap` 是**元/美元原值**（不是微单位），因为行情源就是这么给的。

### `GET /api/v1/quotes?market=cn`
行情池快照，字段与网页端左侧列表完全一致。

```json
{ "ok": true, "activeMarket": "cn", "day": "2026-11-05", "session": {…}, "matchable": true, "matchPaused": false, "stale": false,
  "market": { "market": "cn", "currency": "CNY",
              "indexes": [ … ], "etfs": [ … ], "stocks": [ … ], "gainers": [ … ], "losers": [ … ],
              "breadth": { "up": 2841, "down": 1902, "flat": 88, "limitUp": 37, "limitDown": 4 },
              "status": { "ok": true, "note": null } } }
```

- 美股池：`indexes` 为道琼斯/标普500/纳斯达克/纳斯达克100，`stocks` 是三个交易所按成交额排序的个股，`etfs` 单列。
- **`breadth` 在美股为 `null`**：上游没有对应接口，接口不编造数字。
- `stale: true` 表示行情不是当日的（休市、节假日或上游异常），此时不会撮合。

### `GET /api/v1/search?q=…&market=us`
代码 / 名称 / 拼音首字母检索。结果不跨市场：在美股页搜「英伟达」不会返回 A 股同名缩写。

```json
{ "ok": true, "market": "us", "currency": "USD",
  "rows": [ { "secid": "105.NVDA", "code": "NVDA", "name": "英伟达", "kind": "stock", "last": 203100000, "pct": -1.77, "tradable": true } ] }
```

### `GET /api/v1/chart?symbol=…&kind=trends|kline&count=120`
分时与日 K。`count` 范围 30–320，仅对 `kline` 生效。

```json
{ "ok": true, "secid": "105.AAPL", "symbol": "AAPL", "kind": "kline", "market": "us",
  "series": [ { "day": "2026-11-04", "open": 341580000, "close": 349815000, "high": 350810000, "low": 340990000, "volume": 14228157 } ] }
```

`kind=trends` 时返回 `{ name, preClose, points: [{ t, price, volume, avg }] }`，`t` 是该市场所在时区的 `HH:MM`。

### `GET /api/v1/rules`
两市规则与**当前挂牌参数**（后台可热改，这里读到的就是引擎正在用的值）。

```json
{ "ok": true, "rules": {
  "startCash": 1000000000000, "startCashUsd": 100000000000, "markets": ["cn","us"], "maxQty": 1000000, "leaves": [1,2,3,4,5],
  "cn": { "currency": "CNY", "lotSize": 100, "tPlus1": true,  "dailyLimit": true,  "session": "北京时间 09:15–15:00",
          "fees": { "stockCommission": 0.00025, "etfCommission": 0.0001, "commissionMin": 5000000, "stampTax": 0.0005, "transferFee": 0.00001 },
          "rates": { "margin": 0.0835, "short": 0.1035 },
          "lines": { "open": 1.5, "warn": 1.5, "call": 1.4, "liquid": 1.3, "withdraw": 3 } },
  "us": { "currency": "USD", "lotSize": 1, "tPlus1": false, "dailyLimit": false, "session": "美东 09:30–16:00（自动跟夏令/冬令）",
          "fees": { "commission": 0.0002, "commissionMin": 1000000, "secFee": 0.0000279, "activityPerShare": 166, "activityCap": 8300000 },
          "rates": { "margin": 0.065, "short": 0.095 },
          "lines": { "open": 2, "warn": 1.6, "call": 1.5, "liquid": 1.3, "withdraw": 3 } },
  "reasons": { "qty_invalid": "委托数量须为 100 的整数倍，且不超过 100 万股", "…": "…" },
  "sides": ["buy","sell","margin_buy","sell_repay","short_sell","cover_buy","capital_in","capital_out"],
  "labels": { "buy": "担保品买入", "…": "…" } } }
```

美股 `fees.activityPerShare` 单位是**微美元/股**（166 = $0.000166/股），`commissionMin` / `activityCap` 是微美元。

### `GET /api/v1/leaderboard`
当日盈亏榜，**合并人民币口径**（两市折人民币的日结快照）。

```json
{ "ok": true, "day": "2026-11-05", "fx": 6668100, "currency": "CNY",
  "rows": [ { "name": "某某", "netAssets": 1716734823440, "totalAssets": 1716734823440, "totalDebt": 0, "ratio": null, "ret": 0.0291 } ] }
```

`ret` 的分母是该账户开户时冻结的两笔本金之和（美元部分按当日汇率折算），所以后台改默认本金不会重写别人的历史成绩。

---

## 4. 账户查询（需要密钥）

### `GET /api/v1/account`
两个现金池的完整账目 + 合并值。**这是最常用的一个端点**，一次请求就能拿到全部风控数字。

```json
{ "ok": true, "day": "2026-11-05", "market": "cn", "currency": "CNY", "fx": 6668100,
  "accounts": {
    "cn": { "market": "cn", "currency": "CNY", "day": "2026-11-05",
            "cash": 753020000000, "longValue": 145980000000, "shortValue": 0, "collateral": 0,
            "totalAssets": 899000000000, "totalDebt": 0, "netAssets": 899000000000, "startCash": 1000000000000,
            "marginPrincipal": 0, "marginInterest": 0, "marginBalance": 0, "securityBalance": 0,
            "guaranteeRatio": null, "leverage": 1.0,
            "floatPnl": 0, "realized": 0, "todayPnl": 0, "feesPaid": 37954800, "tradeCount": 1,
            "positions": [ … ], "debtBySymbol": [] },
    "us": { "market": "us", "currency": "USD", "day": "2026-11-04", "cash": 100000000000, … }
  },
  "combined": { "netAssets": 1716734823440, "totalAssets": 1716734823440, "cash": 1716734823440, "totalDebt": 0, "startCash": 1666810000000 },
  "session": {…}, "matchable": true, "matchPaused": false, "stale": false, "markets": {…} }
```

字段口径：

| 字段 | 含义 |
| --- | --- |
| `cash` | 该市场的可用资金（微元/微美元） |
| `longValue` / `shortValue` | 多头持仓市值 / 融券空头市值 |
| `collateral` | 融券保证金 + 卖出所得冻结额 |
| `totalAssets` | `cash + longValue + collateral` |
| `totalDebt` | 融资本金 + 应计利息 + 融券市值 + 融券费用 |
| `netAssets` | `totalAssets − totalDebt` |
| `guaranteeRatio` | `totalAssets / totalDebt`，无负债为 `null` |
| `leverage` | `totalAssets / netAssets` |
| `startCash` | 该池开户时冻结的本金（收益率分母） |
| `combined` | 按 `fx` 把美元池折成人民币后与人民币池相加；`combined.startCash` 同理，是总收益率的分母 |

> **两个池子互不挪用**：美元现金买不了 A 股，人民币现金也买不了美股。`combined` 只用于展示与排名，不是可动用额度。

### `GET /api/v1/positions?market=cn|us`
持仓与负债。默认两个市场一起返回，每行带 `market` / `currency`。

```json
{ "ok": true,
  "positions": [ { "symbol": "1.600519", "code": "600519", "name": "贵州茅台", "kind": "stock", "side": "long",
                   "qty": 100, "avail": 0, "price": 1459800000, "avgCost": 1460179548, "value": 145980000000,
                   "pnl": -379548, "pnlPct": -0.26, "dayPnl": 0, "prevClose": 1459800000,
                   "limitUp": 1605800000, "limitDown": 1313800000, "liquidationPrice": null, "pct": 0,
                   "market": "cn", "currency": "CNY", "day": "2026-11-05" } ],
  "debts": [ { "symbol": "105.ORCL", "principal": 12673500000, "market": "us", "currency": "USD" } ] }
```

- `avail`：可卖数量。A 股已扣掉当日买入（T+1），美股等于 `qty`（T+0）。
- `liquidationPrice`：按**当前挂牌平仓线**算出的强平参考价，无负债时为 `null`。
- 融券空头行会带 `collateral`（冻结额）与 `side: "short"`。

### `GET /api/v1/orders?status=open&limit=50&offset=0`
委托。不带 `status` 时返回在途委托（`open` / `filling`）；带 `status` 时可查历史（`filled` / `canceled` / `rejected`）。

```json
{ "ok": true, "status": "filled", "limit": 50, "offset": 0,
  "orders": [ { "id": "…", "secid": "105.ORCL", "code": "ORCL", "name": "甲骨文", "kind": "stock",
                "side": "buy", "mode": "market", "qty": 5, "limitPrice": null, "leaf": 1,
                "status": "filled", "day": "2026-11-04", "reason": "", "source": "user",
                "created_at": "…", "market": "us", "currency": "USD" } ] }
```

`reason` 是中文说明：废单为拒绝原因，预埋单为「非交易时段挂单，YYYY-MM-DD 开盘后参与撮合」，系统强平单为强平理由。
`day` 是**该标的所属市场的交易日**（美股为美东日期），所以同一天的 A 股与美股委托 `day` 可能差一天。

### `GET /api/v1/trades?limit=50&offset=0`
成交流水，倒序。字段同上，另有 `price` / `amount` / `fee` / `leaf`。

### `POST /api/v1/sync`
手动推进一轮撮合（等价于网页端每 3 秒一轮），返回完整账户信封：
`account`（当前视角市场）、`side`（另一市场摘要）、`combined`、`curve`、`orders`、`trades`、`events`、`leader`、`fills`、`settled`（本轮成交笔数）、`canceled`（本轮过期撤单笔数）。

只下过限价单、想让它「到价就成交」时调这个；用 `POST /api/v1/order` 的即时撮合通常已经够了。

---

## 5. 交易（需要密钥）

### `POST /api/v1/order`

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `symbol` | 是 | 标的，三种写法见上。也接受 `secid` / `code` |
| `side` | 是 | `buy` 担保品买入 · `sell` 担保品卖出 · `margin_buy` 融资买入 · `sell_repay` 卖券还款 · `short_sell` 融券卖出 · `cover_buy` 买券还券 |
| `qty` | 是 | A 股须为 100 的整数倍；美股 1 股起；上限 100 万股 |
| `type` | 否 | `market`（默认）或 `limit`。也接受 `mode` |
| `price` | 限价必填 | 元或美元（十进制），需对齐最小报价单位；A 股还须落在当日涨跌停区间内 |
| `leverage` | 信用方向必填 | 2–5，仅 `margin_buy` / `short_sell` 可用；也接受 `leaf` |
| `immediate` | 否 | 默认 `true`：下单后立刻为该市场跑一轮撮合，响应里直接给成交结果。传 `false` 只受理，等下一轮 |
| `confirmDuplicate` | 否 | 15 秒内重复同一笔时需传 `true` 才会受理 |

行为要点：

- **市价单**按最新价一次性全额成交，不看盘口深度、不排队（与网页端一致）。
- **限价单**在最新价穿越委托价后成交；未穿越则挂在途。A 股涨停封板不可买入、跌停封板不可卖出；美股无每日涨跌停。
- 默认即时撮合会顺带跑完该市场**所有**在途委托与风控判定（含强制平仓），响应里的 `account` 就是这一轮之后的账目。
- 非交易时段下的委托成为该市场下一交易日的预埋单，响应带 `queued: true`，`status` 为 `open`。
- 委托当日有效：过了该市场交易日仍未成交的部分，在下一轮撮合时自动撤销。

响应：

```json
{ "ok": true, "market": "us", "currency": "USD",
  "status": "filled",
  "order": { "id": "…", "status": "filled", "qty": 5, "…" : "…" },
  "fill": { "price": 126735000, "qty": 5, "fee": 1000000, "amount": 633675000 },
  "preview": { "amount": 633675000, "fee": 1000000, "own": 633675000, "borrow": 0, "cashAfter": 99365325000, "…" : "…" },
  "account": { "cash": 99365325000, "positions": [ … ] },
  "queued": false }
```

`status` 取值 `filled | open | rejected | canceled`；未成交时 `fill` 为 `null`。

### `POST /api/v1/order/preview`
字段与 `order` 完全相同，只试算不落库、不改变账户，响应：

```json
{ "ok": true, "market": "us", "currency": "USD",
  "preview": { "amount": 633675000, "fee": 1000000, "own": 633675000, "borrow": 0, "leaf": 1, "price": 126735000,
               "cashAfter": 99365325000, "totalAssetsAfter": 100000000000, "totalDebtAfter": 0,
               "ratioAfter": null, "liquidationPrice": null, "side": "buy", "tradable": true } }
```

试算与真实结算走同一段代码，所以 `preview` 里的数字就是真下单后会得到的数字（行情未变动的前提下）。

### `POST /api/v1/cancel`
```json
{ "orderId": "委托 id" }
```
返回该市场当前在途委托列表。已成交或已撤销的委托会返回 `409 cancel_failed`。
被冻结的账户仍然可以撤单——这是有意的：不能把人困在已有持仓里。

---

## 6. 密钥管理

**只认网页会话令牌**：用 API 密钥调用这些端点会返回 `403 key_management_requires_session`。
否则一把泄露的密钥可以无限签发新密钥，等于永久接管账户。

| 端点 | 说明 |
| --- | --- |
| `GET /api/v1/keys` | 列表：`hint`（首尾片段）、`name`、`created_at`、`last_used_at`、`calls`、`revoked` |
| `POST /api/v1/keys` | `{name}` → 返回 `apiKey` 明文，**只给这一次** |
| `POST /api/v1/keys/revoke` | `{id}` → 立即失效 |

服务端只保存密钥的 SHA-256 摘要，明文不入库、不可找回；每账户最多 10 把有效密钥。
网页端的等价入口是顶栏「API」面板（快捷键 `A`），`?action=key_list | key_create | key_revoke`。

---

## 7. 错误码

失败响应一律是 `{ "ok": false, "code": "…", "message": "中文说明" }`，HTTP 状态码同步反映错误类别。

| HTTP | code | 说明 |
| --- | --- | --- |
| 400 | `symbol_invalid` | 标的代码格式不正确，或无法在沪深/美股中定位 |
| 400 | `qty_invalid` | 数量不合法（A 股需 100 的整数倍）或超过 100 万股 |
| 400 | `price_invalid` | 限价未对齐最小报价单位，或越出当日涨跌停区间（A 股） |
| 400 | `leaf_invalid` / `side_invalid` | 杠杆倍数或交易方向不合法 |
| 400 | `insufficient_cash` | 该市场现金不足。**不会跨池挪用** |
| 400 | `insufficient_avail` | 可卖数量不足（A 股 T+1） |
| 400 | `no_position` / `no_debt` / `no_short_position` | 没有对应持仓或负债，方向用错了 |
| 400 | `withdraw_limited` | 维持担保比例未超过提取线，担保品卖出受限，请改用卖券还款 |
| 400 | `ratio_too_low` | 成交后维持担保比例低于该市场开仓线（A 股 150%，美股 200%） |
| 400 | `liquidation_breach` | 成交后维持担保比例将低于平仓线 130%，委托被拒 |
| 400 | `limit_up` / `limit_down` | 涨停封板不可买入，跌停封板不可卖出（仅 A 股） |
| 400 | `index_not_tradable` | 指数本身不可交易，改选对应 ETF |
| 400 | `suspended` | 行情非当日数据（休市、节假日、停牌或上游异常），不撮合 |
| 400 | `duplicate_order` | 15 秒内完全相同的委托，需带 `confirmDuplicate: true` |
| 401 | `login_required` | 未提供凭证 |
| 401 | `key_invalid` | 密钥无效或已被撤销，需要重新生成 |
| 403 | `account_frozen` | 账户被后台冻结，不能开新仓（撤单与查询仍可用） |
| 403 | `match_paused` | 该市场撮合已被后台熔断（另一市场不受影响） |
| 403 | `key_management_requires_session` | 密钥管理需要网页会话令牌 |
| 404 | `unknown_symbol` | 找不到该标的的实时行情 |
| 404 | `not_found` | 接口不存在 |
| 405 | `method_not_allowed` | 该端点只接受 POST |
| 409 | `cancel_failed` | 该委托已成交或已撤销 |
| 409 | `key_limit` | 有效密钥已达 10 把上限 |
| 429 | `too_many_requests` | 超过频率限制 |
| 500 | `server_error` | 服务内部错误 |
| 503 | `quote_unavailable` / `chart_unavailable` / `write_failed` / `read_failed` | 行情源或数据层暂不可用，委托未落库，可安全重试 |

---

## 8. 频率与限制

| 项目 | 上限 |
| --- | --- |
| 每把密钥 | 240 次 / 分钟 |
| 每账户下单 | 30 次 / 分钟 |
| 同一笔委托重复提交 | 15 秒内需 `confirmDuplicate` |
| 每账户有效密钥 | 10 把 |
| 请求体 | 4 KB |
| 单次查询返回 | 委托 / 成交 ≤ 200 行，持仓与行情池按市场池上限截断 |

限制都是进程内的滑动窗口，服务重启后重新计数。

---

## 9. 各市场规则速查

| 项目 | 沪深（CNY） | 美股（USD） |
| --- | --- | --- |
| 交易时段 | 9:15–9:25 竞价、9:30–11:30、13:00–15:00（北京） | 9:30–16:00（美东，自动跟夏令/冬令）；盘前盘后有行情不撮合 |
| 交收 | T+1 | T+0 |
| 整手 | 100 股 | 1 股 |
| 每日涨跌停 | ±10% / ±20% / ±30% / ST ±5% | 无 |
| 费用 | 佣金万 2.5（ETF 万 1）最低 5 元 + 印花税卖出千 0.5 + 过户费万 0.1 | 佣金万 2 最低 1 美元 + SEC 费卖出万 0.279 + 活动费 $0.000166/股（上限 $8.30） |
| 融资 / 融券利率 | 8.35% / 10.35% | 6.5% / 9.5% |
| 担保线 开仓/预警/追保/平仓 | 150% / 150% / 140% / 130% | 200% / 160% / 150% / 130% |

以上都是**默认挂牌值**，后台可热改（分市场两组），当前实际值以 `GET /api/v1/rules` 为准。

---

## 10. 完整示例

```python
import requests

BASE = "http://127.0.0.1:8791"
H = {"x-api-key": "mk_live_你的密钥"}

markets = requests.get(f"{BASE}/api/v1/markets", timeout=5).json()
if not markets["markets"]["cn"]["matchable"]:
    print("A 股此刻不撮合，先看看美股")

account = requests.get(f"{BASE}/api/v1/account", headers=H, timeout=5).json()
usd = account["accounts"]["us"]
print("美元可用", usd["cash"] / 1e6, "担保比例", usd["guaranteeRatio"])

order = requests.post(f"{BASE}/api/v1/order", headers=H, json={
    "symbol": "AAPL", "side": "buy", "qty": 10, "type": "limit", "price": 300,
}, timeout=5).json()
print(order["status"], order.get("fill"))
```

```js
const base = 'http://127.0.0.1:8791';
const headers = { 'content-type': 'application/json', 'x-api-key': process.env.MIRROR_API_KEY };

const quote = await fetch(`${base}/api/v1/quote?symbol=600519`).then((r) => r.json());
const buy = await fetch(`${base}/api/v1/order`, {
  method: 'POST', headers,
  body: JSON.stringify({ symbol: '600519', side: 'margin_buy', qty: 100, type: 'market', leverage: 2 }),
}).then((r) => r.json());
if (!buy.ok) console.warn(buy.code, buy.message);
```

---

平台是仿真器：资金、持仓、盈亏、强平、排行都不是真实资产，不构成投资建议。
