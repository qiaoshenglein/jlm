// 备份文件的落盘与轮换：自建入口与命令行脚本共用同一份实现，
// 免得两边各写一遍、保留份数还数错。
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

// 文件名里不能出现 : 和 .（Windows 会拒绝），时间戳统一换成 -
const fileStamp = (date) => date.toISOString().replace(/[:.]/g, '-').slice(0, 19);

export function createBackupFiles({ dir, keep = 10 }) {
  const nameOf = (prefix) => `${prefix}-${fileStamp(new Date())}-${randomUUID().slice(0, 6)}.json`;
  const list = async (prefix) => {
    const entries = await readdir(dir).catch(() => []);
    const stamped = [];
    for (const file of entries.filter((name) => name.startsWith(prefix) && name.endsWith('.json'))) {
      try {
        stamped.push({ file, mtime: (await stat(join(dir, file))).mtimeMs });
      } catch { /* 刚被别的进程删掉，跳过 */ }
    }
    return stamped.sort((a, b) => b.mtime - a.mtime);
  };

  return {
    dir,
    keep,
    /** 写一份快照并轮换掉超额的旧文件；返回路径与字节数，供响应与日志引用 */
    async save(text, prefix = 'pre-import') {
      await mkdir(dir, { recursive: true });
      const path = join(dir, nameOf(prefix));
      await writeFile(path, text, 'utf8');
      const stamped = await list(prefix);
      let removed = 0;
      for (const item of stamped.slice(keep)) {
        try {
          await unlink(join(dir, item.file));
          removed += 1;
        } catch { /* 删不掉就留着，不影响本次导入 */ }
      }
      return { path, bytes: Buffer.byteLength(text), kept: stamped.length - removed, removed };
    },
    async latest(prefix = 'pre-import') {
      const [newest] = await list(prefix);
      return newest ? join(dir, newest.file) : null;
    },
  };
}
