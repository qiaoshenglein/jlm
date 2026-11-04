// 手工建表/补表：幂等脚本，重复执行安全（全部 CREATE ... IF NOT EXISTS）。
// 用法：DB_DRIVER=sqlite node scripts/migrate.mjs
import { createDb } from '../server/db.mjs';

const db = await createDb();
const file = await db.migrate(db.driver);
console.log(`已应用 ${file}（驱动 ${db.driver}）`);
await db.close?.();
