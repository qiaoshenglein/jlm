// 语法检查：逐个用 `node --check` 解析后端与本地脚本。
// 部署入口 functions/index.ts 依赖 Deno 运行时，本机无法校验，只能在准备发布包时由平台编译。
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// server/ 与 scripts/ 同样是运行时执行的代码，纳入同一道语法闸门
const files = ['functions', 'server', 'scripts', 'dev'].flatMap((dir) => readdirSync(join(root, dir))
  .filter((name) => /\.(mjs|js)$/.test(name))
  .map((name) => join(root, dir, name)));

let failed = 0;
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    failed += 1;
    console.error(`SYNTAX FAIL ${file}\n${result.stderr}`);
  }
}
console.log(failed ? `${failed}/${files.length} 个脚本语法未通过` : `语法检查通过：${files.length} 个脚本`);
process.exit(failed ? 1 : 0);
