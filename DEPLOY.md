# 镜盘 · 自建服务器部署说明

一个进程同时提供前端静态文件与后端接口，不需要 Node 框架、不需要单独的反向代理服务，也不依赖 Qoder 云端。

```
浏览器 ── http(s)://你的域名
            │
            ├─ /                     → dist/ 静态文件（React 打包产物）
            └─ /functions/v1/app     → 撮合与账户接口（同进程）
                                          │
                                          ├─ SQLite / PostgreSQL（账户、委托、成交、快照）
                                          └─ 东方财富行情接口（每 3 秒一轮）
```

## 1. 环境要求

| 项目 | 要求 |
| --- | --- |
| Node.js | **22.12 及以上**（低于会被 `npm ci`/`npm run build` 的版本闸门拒绝）。构建与运行都已在 Node 24.22 上实测通过，不必为部署单独装 Node 22。 |
| 数据库 | 默认 SQLite，**无需安装任何数据库服务**（Node 22 内置 `node:sqlite`）。想用 PostgreSQL 见第 4 节。 |
| npm 依赖 | 构建前端需要（`npm ci`）；**运行时零依赖**（SQLite 模式下不装任何包）。 |
| 出网 | 服务器要能访问 `push2.eastmoney.com` 与 `push2his.eastmoney.com`；行情源是公开接口，无需密钥。 |

启动 SQLite 时终端会打印一行 `ExperimentalWarning: SQLite is an experimental feature`，这是 Node 的提示，不影响运行；不想到场可以加 `--no-warnings`。

## 2. 部署（SQLite，推荐先跑这个）

```bash
# 1) 取代码后安装并构建前端
npm ci
npm run build          # 产出 dist/

# 2) 起服务（自动建表，数据库文件在 data/mirror.db）
PORT=8791 HOST=0.0.0.0 node server/index.mjs
#   Windows PowerShell 写法：
#   $env:PORT=8791; $env:HOST='0.0.0.0'; node server/index.mjs
```

看到 `镜盘已启动：http://0.0.0.0:8791 数据驱动=sqlite 已应用 schema.sqlite.sql` 即成功。浏览器打开该地址，注册一个账户即可交易。

只想在本机试跑（前后端分离、带热更新）：

```bash
npm run dev:function   # 127.0.0.1:8000，用内存样本库（重启清空），仅调试用
npm run dev            # 127.0.0.1:5173，Vite 已把 /functions/v1/app 代理到 8000
```

## 3. 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | 监听地址。要用 nginx/Caddy 反代就保持 `127.0.0.1`；直接对外才写 `0.0.0.0` |
| `PORT` | `8787` | 监听端口。**先确认没被别的服务占用**（本机上 8787 就撞了一个 RssHub 控制台，用 `PORT` 换掉即可） |
| `WEB_DIR` | `dist` | 静态目录，必须已执行过 `npm run build` |
| `DB_DRIVER` | `sqlite` | `sqlite` 或 `postgres` |
| `DB_PATH` | `data/mirror.db` | SQLite 文件路径，目录会自动创建 |
| `DB_AUTO_MIGRATE` | 开 | 设成 `0` 可禁止启动时自动建表 |
| `DATABASE_URL` | — | PostgreSQL 连接串，`DB_DRIVER=postgres` 时必填 |
| `DB_SCHEMA` | `app` | PostgreSQL 的 schema 名（SQLite 忽略） |
| `DB_POOL_MAX` | `8` | PostgreSQL 连接池上限 |

## 4. 改用 PostgreSQL

```bash
npm install pg                                   # 运行时唯一需要的额外依赖
psql "$DATABASE_URL" -f server/schema.postgres.sql   # 建 app schema 与六张表
DB_DRIVER=postgres DATABASE_URL=postgres://用户:密码@127.0.0.1:5432/库名 node server/index.mjs
```

要点：
- 金额列是 `BIGINT`，单位是**微元**（1 元 = 1,000,000），代码里已把 int8 统一解析成 Number，量级远小于 2^53，不会溢出也不会变成字符串。
- 建表脚本是幂等的（`CREATE ... IF NOT EXISTS`），可随时用 `npm run migrate` 补表。
- 建议给应用账号只授予这六张表的权限，不要给建表或超级用户权限。
- ⚠️ 这条路径我在本机**没有连过真实 PostgreSQL 验证**（没有可用实例）。SQL 全部参数化、方言差异只集中在占位符与 int8 解析两处；首次上线请先用一个测试库跑一遍注册→下单→成交→重启再登录。

## 5. 反向代理与 HTTPS（必须做）

会话令牌走请求体，口令走 POST，**没有 TLS 就是明文传输**。二选一：

**Caddy**（自动签发证书）
```
your.domain {
    reverse_proxy 127.0.0.1:8791
}
```

**nginx**
```nginx
server {
    listen 443 ssl http2;
    server_name your.domain;
    # ssl_certificate ...; ssl_certificate_key ...;
    client_max_body_size 32k;              # 接口请求体上限很小，超了直接挡掉

    location / {
        proxy_pass http://127.0.0.1:8791;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 30s;
    }
}
```
`server/index.mjs` 已自带 CSP、`X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、`Referrer-Policy`，`/assets/` 下带哈希的文件是 `immutable` 长缓存，`index.html` 是 `no-cache`。

## 6. 常驻与备份

**systemd**
```ini
[Unit]
Description=mirror-desk
After=network-online.target

[Service]
WorkingDirectory=/opt/mirror-desk
Environment=PORT=8791
Environment=HOST=127.0.0.1
ExecStart=/usr/bin/node server/index.mjs
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=full
ReadWritePaths=/opt/mirror-desk/data

[Install]
WantedBy=multi-user.target
```

**PM2**：`pm2 start server/index.mjs --name mirror-desk`。

**只用一个实例，不要 cluster 多开。** 撮合与行情快照缓存在进程内存里，多实例会各自去打行情源；每轮的委托领取靠数据库唯一约束与条件更新保证不重复成交，所以多开不会算错账，但没有收益。

备份：
- SQLite：`sqlite3 data/mirror.db "VACUUM INTO '/backup/mirror-$(date +%F).db'"`（在线备份，不用停服）。直接 `cp` 要先停服或连 `-wal` 一起拷。
- PostgreSQL：`pg_dump -n app -Fc 库名 > mirror.dump`。
- 想清空重来：删掉 `data/mirror.db*` 重启即可（会自动重建空表）。

## 7. 验证与自检

```bash
npm run selftest           # 41 项端到端检查，内存样本库
DB_DRIVER=sqlite npm run selftest   # 同一套检查改跑真实 SQL 数据层
npm run check:function     # 后端脚本语法检查
```

`npm run selftest` 覆盖：注册与口令校验、登录失败与锁定、行情可用性、涨跌停与最小报价单位、100 股整数倍、T+1 可用、现金买入与融资买入的费用/保证金/负债、融券做空与担保物、超额下单拒绝、限价挂单与撤单、日结快照与排行榜，以及一个合成的强平情景（2 倍杠杆跌 40% → 维持担保比例 119.8% → 自动生成卖券还款 → 回到 149.9%）。

## 8. 交易规则口径（用户可见，改动请同步 `src/components/rulesText.ts`）

- 初始虚拟本金 100 万元。
- 时段：9:15–9:25 集合竞价、9:30–11:30、13:00–15:00 连续竞价；非交易时段的委托成为下一交易日预埋单，当日有效、收盘未成交自动撤销。是否撮合用行情自身的时间戳判定当日，因此周末与法定休市日自然不产生成交。
- 市价单按最新价一次性全额成交，不看盘口深度；限价单价格穿越后成交。
- 涨停封板不可买、跌停封板不可卖；创业板/科创板 ±20%，北交所 ±30%，ST ±5%，主板 ±10%。
- 费用：股票佣金万 2.5、ETF 万 1（单笔最低 5 元），印花税卖出单边千 0.5（仅股票），过户费万 0.1 双向（仅股票）。
- 杠杆 1×–5×：自付保证金 = 成交金额 ÷ 杠杆，其余形成负债；融券卖出的保证金与卖出所得一起冻结为担保物。国内券商融资保证金比例不低于 100%（约 1×），这里的 5× 是压缩风险训练周期的模拟参数，不对应真实授信。
- 融资年利率 8.35%、融券年费率 10.35%，按自然日计提；卖券还款先结利息再冲本金。
- 维持担保比例 = 担保物总市值 ÷ 负债总额：≥150% 才能新开杠杆仓，<150% 预警，<140% 追保通知，**<130% 自动生成强制平仓委托**，>300% 才允许「担保品卖出」提取资金。

## 9. 已知边界

- 行情为公开接口，有数秒延迟，个别字段可能为空；上游异常时界面会显示「行情源异常」并继续用最后一次有效快照，休市时显示「行情非当日数据」。
- 当日买入的仓位受 T+1 限制不可卖，极端行情下强平可能无法足额执行，这一点与实盘一致。
- 登录失败 5 次锁定 15 分钟；注册/登录与下单各有进程内频率限制（重启后重新计数）。
- 平台是仿真器：资金、盈亏、强平、排行都不是真实资产，不构成投资建议。
