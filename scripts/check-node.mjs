// Match the starter's supported engine before copying, installing or building.
export function checkNode(version = process.versions.node) {
  const [major, minor] = version.split('.').map(Number);
  // Qoder Sites 模板原本锁 22.x；自建部署只要求 Vite 8 支持的 Node（>=22.12），
  // 否则服务器上装两个 Node 版本才有意义。
  if (major < 22 || (major === 22 && minor < 12)) {
    throw new Error(`需要 Node 22.12 或更高版本；当前是 ${version}。`);
  }
}
checkNode();
