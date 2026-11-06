/**
 * 写接口鉴权（P1-A）：TON Connect ton_proof 本地验签 + 一次性 nonce 防重放。
 *
 * 消息按 TON Connect ton_proof v2 规范构造：
 *   message = "ton-proof-item-v2/" || workchain(int32 BE) || addressHash(32B) || domainLen(int32 BE)
 *             || domain(utf8) || timestamp(int64 BE) || payload(utf8)
 *   signature = ed25519_sign(sha256(message))
 *
 * FIX-6：必须提交钱包 StateInit（BOC base64），服务端离线验证：
 *   - address.hash == hash(StateInit cell)（即证明 StateInit 对应目标地址）；
 *   - code cell hash ∈ {v3r2, v4r2, v5r1} 白名单；
 *   - 从 data cell 指定 bit offset 解出 public_key，必须等于签名公钥。
 *   这样攻击者无法用自造密钥对抢注任意地址；D1 wallet_bindings 首次绑定也带 code_hash/verified_at。
 * 会话：GET /api/auth/challenge 下发不绑定地址的一次性 payload；POST /api/auth/session 用同一套校验换取
 *   7 天 HMAC 会话 token（SESSION_SECRET 签名）。写接口优先接受 Authorization: Bearer，失败则回落逐请求 proof。
 * 说明：
 *  - 演示模式（DATA_SOURCE=demo 且 DEMO_ALLOW_UNSIGNED_WRITES=true）允许无签名写接口；
 *    生产/chain 模式必须带签名，且 chain 模式的写接口本身返回 501（请直接与合约交互）。
 */
import type { Env } from './env';
import type { TonProof } from '@shared/types';
import * as store from './store';
import { ApiError, badRequest, parseAddress, readJsonBody, unauthorized } from './http';

const DEFAULT_PROOF_DOMAINS = 'a9.lat,www.a9.lat,localhost,127.0.0.1';
const MAX_SKEW_SECONDS = 300;
const NONCE_TTL_MS = 5 * 60 * 1000;
/** 登录挑战（GET /api/auth/challenge）：不绑定地址，10 分钟内一次性有效。 */
export const AUTH_CHALLENGE_TTL_MS = 10 * 60 * 1000;
/** 会话 token 有效期：7 天。 */
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const SESSION_TOKEN_VERSION = 1;

/* ----------------------------- 编解码 ----------------------------- */

function base64ToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

function hexToBytes(hex: string): Uint8Array | null {
  const clean = hex.trim().replace(/^0x/i, '');
  if (clean.length === 0 || clean.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(clean)) return null;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function decodePublicKey(publicKey: string): Uint8Array | null {
  const hex = hexToBytes(publicKey);
  if (hex && hex.length === 32) return hex;
  try {
    const raw = base64ToBytes(publicKey);
    return raw.length === 32 ? raw : null;
  } catch {
    return null;
  }
}

function i32be(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setInt32(0, value, false);
  return out;
}

function i64be(value: number): Uint8Array {
  const out = new Uint8Array(8);
  const view = new DataView(out.buffer);
  const big = BigInt(Math.trunc(value));
  view.setUint32(0, Number((big >> 32n) & 0xffffffffn), false);
  view.setUint32(4, Number(big & 0xffffffffn), false);
  return out;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/* ------------------- FIX-6：StateInit 解析与地址所有权证明 ------------------- */

/** 已知钱包版本 code cell hash → data 布局中的 public_key 起始 bit。 */
const WALLET_CODE_LAYOUTS: Record<string, { version: string; publicKeyOffsetBits: number }> = {
  // WalletV3R2
  '84dafa449f98a6987789ba232358072bc0f76dc4524002a5d0918b9a75d2d599': { version: 'v3r2', publicKeyOffsetBits: 64 },
  // WalletV4R2
  feb5ff6820e2ff0d9483e7e0d62c817d846789fb4ae580c878866d959dabd5c0: { version: 'v4r2', publicKeyOffsetBits: 64 },
  // WalletV5R1（is_signature_allowed 1 bit + seqno 32 + wallet_id 32）
  '20834b7b72b112147e1b2fb457b84e74d1a30f04f737d4f62a668e9552d2b72f': { version: 'v5r1', publicKeyOffsetBits: 65 },
};

interface ParsedCell {
  data: Uint8Array;
  bitsLen: number;
  refs: ParsedCell[];
  hash: Uint8Array;
  depth: number;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** BOC 里非整字节 cell 的 padding：最后一个非零字节的最低置位为 padding 标记。 */
function paddedBufferBitLength(data: Uint8Array): number {
  for (let i = data.length - 1; i >= 0; i--) {
    if (data[i] !== 0) {
      const testByte = data[i];
      let bitPos = testByte & -testByte;
      if ((bitPos & 1) === 0) bitPos = Math.log2(bitPos) + 1;
      const base = i > 0 ? i << 3 : 0;
      return base + 8 - bitPos;
    }
  }
  return 0;
}

function readUintBE(bytes: Uint8Array, offset: number, length: number): number {
  let value = 0;
  for (let i = 0; i < length; i++) value = value * 256 + (bytes[offset + i] ?? 0);
  return value;
}

/**
 * 解析 TON BOC（标准 magic 0xB5EE9C72，支持 has_idx / has_crc32c），返回 root cell。
 * 仅接受普通 level0 cell（钱包 StateInit 即此类；exotic/带缓存 hash 的直接拒绝）。
 */
async function parseBocRoot(bytes: Uint8Array): Promise<ParsedCell> {
  if (bytes.length < 6) throw unauthorized();
  if (readUintBE(bytes, 0, 4) !== 0xb5ee9c72) throw unauthorized();
  let p = 4;
  const flags = bytes[p++];
  const hasIdx = (flags & 0x80) !== 0;
  const hasCrc = (flags & 0x40) !== 0;
  const sizeBytes = flags & 0x07;
  if (sizeBytes < 1 || sizeBytes > 4) throw unauthorized();
  const offBytes = bytes[p++];
  const cellsCount = readUintBE(bytes, p, sizeBytes); p += sizeBytes;
  const rootsCount = readUintBE(bytes, p, sizeBytes); p += sizeBytes;
  p += sizeBytes; // absent count
  const totalSize = readUintBE(bytes, p, offBytes); p += offBytes;
  const roots: number[] = [];
  for (let i = 0; i < rootsCount; i++) { roots.push(readUintBE(bytes, p, sizeBytes)); p += sizeBytes; }
  if (hasIdx) p += cellsCount * offBytes;
  const cellData = bytes.subarray(p, p + totalSize);
  if (cellData.length !== totalSize) throw unauthorized();
  if (hasCrc && bytes.length < p + totalSize + 4) throw unauthorized();

  interface RawCell { d1: number; d2: number; data: Uint8Array; bitsLen: number; refs: number[] }
  const raws: RawCell[] = [];
  let q = 0;
  for (let i = 0; i < cellsCount; i++) {
    const d1 = cellData[q++];
    const d2 = cellData[q++];
    const refsCount = d1 & 7;
    if (d1 & 8) throw unauthorized();
    if (d1 & 16) throw unauthorized();
    const dataBytes = Math.ceil(d2 / 2);
    const paddingAdded = d2 % 2 === 1;
    const data = cellData.subarray(q, q + dataBytes); q += dataBytes;
    if (data.length !== dataBytes) throw unauthorized();
    const bitsLen = paddingAdded ? paddedBufferBitLength(data) : dataBytes * 8;
    const refs: number[] = [];
    for (let r = 0; r < refsCount; r++) { refs.push(readUintBE(cellData, q, sizeBytes)); q += sizeBytes; }
    raws.push({ d1, d2, data, bitsLen, refs });
  }

  const cache = new Map<number, ParsedCell>();
  const visiting = new Set<number>();
  const build = async (index: number): Promise<ParsedCell> => {
    const cached = cache.get(index);
    if (cached) return cached;
    if (visiting.has(index)) throw unauthorized();
    visiting.add(index);
    const raw = raws[index];
    if (!raw) throw unauthorized();
    const children: ParsedCell[] = [];
    for (const refIndex of raw.refs) children.push(await build(refIndex));
    let maxDepth = 0;
    for (const child of children) maxDepth = Math.max(maxDepth, child.depth);
    const depth = children.length ? maxDepth + 1 : 0;
    const repr = new Uint8Array(2 + raw.data.length + children.length * 34);
    repr[0] = raw.d1;
    repr[1] = raw.d2;
    repr.set(raw.data, 2);
    let offset = 2 + raw.data.length;
    for (const child of children) {
      repr[offset++] = Math.floor(child.depth / 256);
      repr[offset++] = child.depth % 256;
    }
    for (const child of children) {
      repr.set(child.hash, offset);
      offset += 32;
    }
    const cell: ParsedCell = { data: raw.data, bitsLen: raw.bitsLen, refs: children, hash: await sha256(repr), depth };
    cache.set(index, cell);
    visiting.delete(index);
    return cell;
  };

  const rootIndex = roots[0];
  if (rootIndex === undefined) throw unauthorized();
  return build(rootIndex);
}

/** 从 cell 的 bit offset 读出 length 位 → 字节（大端对齐）。 */
function readBitsAsBytes(cell: ParsedCell, offsetBits: number, lengthBits: number): Uint8Array {
  const out = new Uint8Array(Math.ceil(lengthBits / 8));
  for (let i = 0; i < lengthBits; i++) {
    const pos = offsetBits + i;
    const byte = cell.data[pos >> 3] ?? 0;
    const bit = (byte >> (7 - (pos & 7))) & 1;
    if (bit) out[i >> 3] |= 0x80 >> (i & 7);
  }
  return out;
}

/**
 * FIX-6 核心：验证 ton_proof.state_init 确实是 address 对应的钱包合约状态，
 * 且 data 中的 public_key 与签名公钥一致。
 * StateInit = split_depth(None 0) | special(None 0) | code:^Cell | data:^Cell | library(empty 0)
 */
async function verifyWalletStateInit(
  proof: TonProof,
  address: string,
): Promise<{ codeHash: string; publicKeyHex: string; version: string }> {
  if (typeof proof.stateInit !== 'string' || !proof.stateInit) throw unauthorized();
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(proof.stateInit);
  } catch {
    throw unauthorized();
  }
  const root = await parseBocRoot(bytes);
  // StateInit 由 split_depth / special / code / data / library 组成；这里只要求恰好 code+data 两个 ref。
  // 根 cell 的 bit 内容不参与语义判断（address.hash == hash(StateInit) 已把全部内容绑定）。
  if (root.refs.length !== 2 || root.bitsLen > 64) throw unauthorized();

  const parsedAddress = decodeTonAddress(address);
  if (!parsedAddress) throw unauthorized();
  if (!bytesEqual(root.hash, parsedAddress.hash)) throw unauthorized();

  const codeHash = bytesToHex(root.refs[0].hash);
  const layout = WALLET_CODE_LAYOUTS[codeHash];
  if (!layout) throw unauthorized();

  const dataCell = root.refs[1];
  const publicKeyHex = bytesToHex(readBitsAsBytes(dataCell, layout.publicKeyOffsetBits, 256));
  return { codeHash, publicKeyHex, version: layout.version };
}

/** 解析 TON 用户友好地址（UQ/EQ, 48 chars base64url）→ workchain + 32 字节 hash。 */
export function decodeTonAddress(address: string): { workchain: number; hash: Uint8Array } | null {
  try {
    const raw = base64ToBytes(address);
    if (raw.length < 36) return null;
    let workchain = raw[1];
    if (workchain > 127) workchain -= 256;
    const hash = raw.slice(2, 34);
    if (hash.length !== 32) return null;
    return { workchain, hash };
  } catch {
    return null;
  }
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return new Uint8Array(digest);
}

/** TON Connect ton_proof v2 的待签名摘要（sha256 后由 ed25519 签名）。 */
export async function buildTonProofDigest(input: {
  address: string;
  domain: string;
  domainLengthBytes: number;
  timestamp: number;
  payload: string;
}): Promise<Uint8Array> {
  const parsed = decodeTonAddress(input.address);
  if (!parsed) throw unauthorized();
  const encoder = new TextEncoder();
  const message = concatBytes([
    encoder.encode('ton-proof-item-v2/'),
    i32be(parsed.workchain),
    parsed.hash,
    i32be(input.domainLengthBytes),
    encoder.encode(input.domain),
    i64be(input.timestamp),
    encoder.encode(input.payload),
  ]);
  return sha256(message);
}

async function verifyEd25519(publicKey: Uint8Array, signature: Uint8Array, message: Uint8Array): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey('raw', publicKey, { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, signature, message);
  } catch (error) {
    console.error('[tonproof] ed25519 verify unavailable', error instanceof Error ? error.message : String(error));
    return false;
  }
}

/* ----------------------------- 业务 ----------------------------- */

/** 解析 proof：body.proof 优先，其次 X-Ton-Proof（base64 JSON）。 */
function resolveProof(request: Request, body: Record<string, unknown>): TonProof | null {
  const fromBody = body.proof;
  if (fromBody && typeof fromBody === 'object') return fromBody as TonProof;
  const header = request.headers.get('x-ton-proof');
  if (header) {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(base64ToBytes(header)));
      if (parsed && typeof parsed === 'object') return parsed as TonProof;
    } catch {
      return null;
    }
  }
  return null;
}

export function noncePayload(nonce: string): string {
  return 'a9-auth:' + nonce;
}

/** GET /api/auth/nonce：下发 5 分钟有效、一次性 nonce。 */
export async function issueAuthNonce(env: Env, address: string, now = Date.now()) {
  const nonce = crypto.randomUUID().replace(/-/g, '') + Math.random().toString(36).slice(2, 10);
  const expiresAt = now + NONCE_TTL_MS;
  await store.insertAuthNonce(env, { nonce, address, createdAt: now, expiresAt });
  return { address, nonce, expiresAt };
}

/* ------------------- 登录挑战 + 会话 token（无需逐请求签名） ------------------- */

function randomNonce(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

/** GET /api/auth/challenge：不绑定地址的一次性挑战，作为 TON Connect 连接时 ton_proof 的 payload。 */
export async function issueAuthChallenge(env: Env, now = Date.now()): Promise<{ payload: string; expiresAt: number }> {
  const nonce = randomNonce();
  const expiresAt = now + AUTH_CHALLENGE_TTL_MS;
  await store.insertAuthNonce(env, { nonce, address: store.AUTH_NONCE_ANY_ADDRESS, createdAt: now, expiresAt });
  return { payload: noncePayload(nonce), expiresAt };
}

/** 规范化为 TON raw 形式 '<wc>:<hex>'（token 内地址与 body 地址比对用）；无法解析返回 null。 */
export function normalizeTonAddress(address: string): string | null {
  const parsed = decodeTonAddress(address);
  return parsed ? `${parsed.workchain}:${bytesToHex(parsed.hash)}` : null;
}

/** SESSION_SECRET 缺失或全空白视为未配置。 */
function sessionSecret(env: Env): string | null {
  const secret = env.SESSION_SECRET;
  return typeof secret === 'string' && secret.trim() !== '' ? secret : null;
}

function importSessionKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * 签发会话 token：base64url(JSON{a, e, v}) + '.' + base64url(HMAC-SHA256(payloadPart))。
 * a = 规范化 raw 地址，e = 过期 unix 秒，v = 版本。SESSION_SECRET 缺失时直接 500，绝不签发无签名 token。
 */
export async function signSessionToken(
  env: Env,
  address: string,
  now = Date.now(),
): Promise<{ token: string; expiresAt: number }> {
  const secret = sessionSecret(env);
  if (!secret) throw new ApiError('INTERNAL', '会话签名密钥未配置');
  const subject = normalizeTonAddress(address);
  if (!subject) throw badRequest('地址格式不合法');
  const exp = Math.floor(now / 1000) + SESSION_TTL_SECONDS;
  const payloadPart = bytesToBase64Url(
    new TextEncoder().encode(JSON.stringify({ a: subject, e: exp, v: SESSION_TOKEN_VERSION })),
  );
  const key = await importSessionKey(secret);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payloadPart)));
  return { token: payloadPart + '.' + bytesToBase64Url(mac), expiresAt: exp * 1000 };
}

/**
 * 校验会话 token：HMAC（crypto.subtle.verify 内部常量时间比较）→ 版本 → 未过期 → 地址一致。
 * 任何解析异常、缺密钥都返回 false，不抛错。
 */
export async function verifySessionToken(env: Env, token: string, address: string, now = Date.now()): Promise<boolean> {
  try {
    const secret = sessionSecret(env);
    if (!secret) return false;
    const parts = token.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return false;
    const [payloadPart, macPart] = parts;
    const key = await importSessionKey(secret);
    const signatureOk = await crypto.subtle.verify(
      'HMAC',
      key,
      base64ToBytes(macPart),
      new TextEncoder().encode(payloadPart),
    );
    if (!signatureOk) return false;
    const claims = JSON.parse(new TextDecoder().decode(base64ToBytes(payloadPart))) as {
      a?: unknown;
      e?: unknown;
      v?: unknown;
    };
    if (claims.v !== SESSION_TOKEN_VERSION) return false;
    if (typeof claims.e !== 'number' || !Number.isFinite(claims.e)) return false;
    if (Math.floor(now / 1000) >= claims.e) return false;
    const subject = normalizeTonAddress(address);
    return subject !== null && claims.a === subject;
  } catch {
    return false;
  }
}

/** Authorization: Bearer <token> 且对 body 钱包地址有效。 */
async function hasValidBearerSession(env: Env, request: Request, address: string, now: number): Promise<boolean> {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(request.headers.get('authorization') ?? '');
  if (!match) return false;
  return verifySessionToken(env, match[1], address, now);
}

/**
 * POST /api/auth/session：用与写接口完全相同的 ton_proof 校验（domain / 签名 / StateInit / nonce 消费 / 绑定）
 * 换取 7 天会话 token。expiresAt 为毫秒时间戳。
 */
export async function createAuthSession(
  request: Request,
  env: Env,
  now = Date.now(),
): Promise<{ token: string; address: string; expiresAt: number }> {
  if (!sessionSecret(env)) throw new ApiError('INTERNAL', '会话签名密钥未配置');
  const body = await readJsonBody(request);
  const address = parseAddress(body.address);
  const proof = resolveProof(request, body);
  if (!proof) throw unauthorized();
  await verifyTonProof(env, proof, address, now);
  const session = await signSessionToken(env, address, now);
  return { token: session.token, address, expiresAt: session.expiresAt };
}

function allowedProofDomains(env: Env): string[] {
  return (env.TON_PROOF_DOMAINS ?? DEFAULT_PROOF_DOMAINS)
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

export function clientIp(request: Request): string {
  return (
    request.headers.get('cf-connecting-ip') ||
    (request.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() ||
    'unknown'
  );
}

/**
 * 写接口鉴权。规则：
 *  - chain 模式：调用方应先返回 501（不进入本函数）；
 *  - demo 且 DEMO_ALLOW_UNSIGNED_WRITES=true：无 proof 时放行（演示宽松路径）；
 *  - 其余：必须带合法 ton_proof，否则 401（不泄露细节）。
 */
export async function requireWriteAuth(
  env: Env,
  request: Request,
  body: Record<string, unknown>,
  address: string,
  now = Date.now(),
): Promise<{ signed: boolean; ip: string }> {
  const ip = clientIp(request);
  // 会话 token 优先：Bearer 有效、未过期且地址与 body 钱包一致即放行；否则回落到逐请求 proof
  if (await hasValidBearerSession(env, request, address, now)) return { signed: true, ip };
  const proof = resolveProof(request, body);
  const unsignedAllowed = env.DEMO_ALLOW_UNSIGNED_WRITES === 'true';
  if (!proof) {
    if (unsignedAllowed) return { signed: false, ip };
    throw unauthorized();
  }
  await verifyTonProof(env, proof, address, now);
  return { signed: true, ip };
}

/** 逐请求 ton_proof 校验：时间窗 / domain / 签名 / StateInit 公钥 / nonce 消费 / 地址绑定。失败抛 401。 */
export async function verifyTonProof(env: Env, proof: TonProof, address: string, now = Date.now()): Promise<void> {
  if (typeof proof.timestamp !== 'number' || !Number.isFinite(proof.timestamp)) throw unauthorized();
  const nowSeconds = Math.floor(now / 1000);
  if (Math.abs(nowSeconds - proof.timestamp) > MAX_SKEW_SECONDS) throw unauthorized();

  const domain = proof.domain && typeof proof.domain.value === 'string' ? proof.domain.value : '';
  const domainLengthBytes = proof.domain && typeof proof.domain.lengthBytes === 'number' ? proof.domain.lengthBytes : -1;
  if (!domain || !allowedProofDomains(env).includes(domain.toLowerCase())) throw unauthorized();
  if (domainLengthBytes !== new TextEncoder().encode(domain).length) throw unauthorized();

  if (typeof proof.payload !== 'string' || !proof.payload) throw unauthorized();
  if (typeof proof.signature !== 'string' || !proof.signature) throw unauthorized();
  if (typeof proof.publicKey !== 'string' || !proof.publicKey) throw unauthorized();

  const publicKey = decodePublicKey(proof.publicKey);
  if (!publicKey) throw unauthorized();
  const publicKeyHex = bytesToHex(publicKey);

  // FIX-6：用 StateInit 证明「该公钥确实控制该地址」，并与客户端声明的公钥比对
  const stateInitProof = await verifyWalletStateInit(proof, address);
  if (stateInitProof.publicKeyHex !== publicKeyHex) throw unauthorized();

  let signature: Uint8Array;
  try {
    signature = base64ToBytes(proof.signature);
  } catch {
    throw unauthorized();
  }
  if (signature.length !== 64) throw unauthorized();

  const digest = await buildTonProofDigest({
    address,
    domain,
    domainLengthBytes,
    timestamp: proof.timestamp,
    payload: proof.payload,
  });
  const valid = await verifyEd25519(publicKey, signature, digest);
  if (!valid) throw unauthorized();

  // 签名通过后再消费一次性 nonce（payload = "a9-auth:<nonce>"），防重放
  const nonce = proof.payload.startsWith('a9-auth:') ? proof.payload.slice('a9-auth:'.length) : proof.payload;
  const consumed = await store.consumeAuthNonce(env, { nonce, address, now });
  if (!consumed) throw unauthorized();

  // 地址 ↔ 公钥绑定（带 StateInit 证明的 code_hash / verified_at；旧的 TOFU 行会被清理并重建）
  interface BindingRow {
    address: string;
    public_key: string;
    code_hash: string | null;
    verified_at: number | null;
  }
  const binding = await env.DB.prepare(
    'SELECT address, public_key, code_hash, verified_at FROM wallet_bindings WHERE address = ?',
  )
    .bind(address)
    .first<BindingRow>();

  if (binding && binding.verified_at) {
    if (binding.public_key.toLowerCase() !== publicKeyHex) throw unauthorized();
    if (binding.code_hash && binding.code_hash.toLowerCase() !== stateInitProof.codeHash) throw unauthorized();
    return;
  }
  if (binding) {
    // 迁移前遗留的 TOFU 绑定：无 StateInit 证明，清掉后按本次已验证内容重建
    await env.DB.prepare('DELETE FROM wallet_bindings WHERE address = ?').bind(address).run();
  }
  try {
    await env.DB.prepare(
      'INSERT INTO wallet_bindings (address, public_key, code_hash, verified_at, bound_at) VALUES (?, ?, ?, ?, ?)',
    )
      .bind(address, publicKeyHex, stateInitProof.codeHash, now, now)
      .run();
  } catch {
    // public_key UNIQUE 冲突：同一公钥已绑定其它地址 → 拒绝
    throw unauthorized();
  }
}

/** 限流：/api/admin/*、/api/stake、/api/claim、/api/auth/nonce（可传单独配额）。超阈值抛 429。 */
export async function enforceRateLimit(
  env: Env,
  request: Request,
  scope: string,
  now = Date.now(),
  limitOverride?: number,
): Promise<void> {
  const limit = limitOverride ?? Number(env.RATE_LIMIT_PER_MINUTE ?? '30');
  if (!Number.isFinite(limit) || limit <= 0) return;
  const result = await store.hitRateLimit(env, {
    key: clientIp(request) + '|' + scope,
    now,
    limit,
  });
  if (result.limited) {
    throw new ApiError('RATE_LIMITED', '请求过于频繁，请稍后重试');
  }
}

/** 便捷校验：拒绝显然非法的 proof 字段（用于测试/调试时给出 400 而非 401）。 */
export function assertProofShape(proof: unknown): asserts proof is TonProof {
  if (!proof || typeof proof !== 'object') throw badRequest('proof 必须是对象');
}
