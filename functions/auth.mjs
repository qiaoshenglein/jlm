// 口令与会话：PBKDF2-SHA256 加盐散列，会话只存令牌的 SHA-256 摘要。
// 只用 Web Crypto，保证 Deno 边缘运行时与本地 Node 走同一份代码。
const enc = new TextEncoder();
const ITERATIONS = 180_000;

function hex(bytes) {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function unHex(value) {
  const out = new Uint8Array(value.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function equal(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function derive(secret, saltBytes, iterations = ITERATIONS) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({
    name: 'PBKDF2', salt: saltBytes, iterations, hash: 'SHA-256',
  }, key, 256));
}

export async function hashPassword(secret) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const digest = await derive(secret, salt);
  return `pbkdf2-sha256$${ITERATIONS}$${hex(salt)}$${hex(digest)}`;
}

export async function verifyPassword(secret, stored) {
  const parts = String(stored ?? '').split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2-sha256') return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1_000) return false;
  const digest = await derive(secret, unHex(parts[2]), iterations);
  return equal(digest, unHex(parts[3]));
}

export function newToken() {
  return hex(crypto.getRandomValues(new Uint8Array(32)));
}

export async function digestToken(token) {
  const buffer = await crypto.subtle.digest('SHA-256', enc.encode(String(token)));
  return hex(buffer);
}

// ---- 个人 API 密钥 ----
// 明文只在生成那一次返回，库里只存 SHA-256 摘要；前缀 mk_live_ 便于日志里辨认与脱敏。
export const API_KEY_PREFIX = 'mk_live_';
const API_KEY_BODY = 32; // 16 字节随机数的 hex，够长且不会混进 base64 的 +/- 转义问题

export function newApiKey() {
  return API_KEY_PREFIX + hex(crypto.getRandomValues(new Uint8Array(API_KEY_BODY / 2)));
}

export const looksLikeApiKey = (text) => new RegExp(`^${API_KEY_PREFIX}[0-9a-f]{${API_KEY_BODY}}$`).test(String(text ?? ''));

// 列表里只显示头尾，足够用户分辨「哪把是我的脚本」，又不至于泄露可用片段
export const apiKeyHint = (key) => {
  const text = String(key ?? '');
  return text.length <= 16 ? text : `${text.slice(0, API_KEY_PREFIX.length + 4)}…${text.slice(-4)}`;
};

export function newId() {
  return crypto.randomUUID();
}

export function normalizeUsername(raw) {
  const value = String(raw ?? '').trim().toLowerCase();
  if (value.length < 2 || value.length > 24) return null;
  if (!/^[a-z0-9_\u4e00-\u9fa5.-]+$/.test(value)) return null;
  return value;
}

export function checkPassword(raw) {
  const value = String(raw ?? '');
  if (value.length < 8 || value.length > 64) return '口令至少 8 位，最多 64 位';
  if (!/[a-zA-Z]/.test(value) || !/[0-9]/.test(value)) return '口令需同时包含字母和数字';
  return null;
}

export function normalizeDisplay(raw, fallback) {
  const value = String(raw ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 20);
  return value || fallback;
}
