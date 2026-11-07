#!/usr/bin/env node
/**
 * A9 主网部署前自检（preflight-mainnet）
 *
 * 用法：
 *   node worker/scripts/preflight-mainnet.mjs
 *   node worker/scripts/preflight-mainnet.mjs --tag=v11-audit-fixed
 *   # 真实地址尚未写进 wrangler.toml 时（与 CI 门禁同口径）：
 *   PROD_ROUND_CONTROLLER_ADDRESS=0:... PROD_TEAM_WALLET_ADDRESS=0:... PROD_KEEPER_ADDRESS=0:... \
 *   PROD_JETTON_MASTER_ADDRESS=0:... PROD_ORACLE_CONFIG_HASH=sha256:... \
 *     node worker/scripts/preflight-mainnet.mjs
 *
 * 设计原则（硬要求）：
 *   - 6 类检查全部必须拿到数据；任何一项拿不到数据 = FAIL，不降级为 WARN、不静默跳过。
 *   - 只读脚本：不修改文件、不部署、不调用网络；不打印任何 secret 的值（只报存在/缺失）。
 *   - 任一 FAIL → 进程退出码 1。
 *
 * 基线来源：
 *   - 合约 code hash：contracts/README.md §0 / §7.1 的 v11 基线（4 个自研合约 + 2 个 Jetton 官方模板）。
 *   - 主网参数：ops/config/mainnet.params.json（唯一参数输入）+ docs/00_DECISIONS_V2.md 的 V7 时间线。
 *   - 源码冻结：tag v11-audit-fixed（v11 外部审计通过后打）必须存在，且 contracts/{contracts,build,tests,scripts}
 *     与 tag 完全一致（文档可以在 tag 之后继续提交；合约/测试/构建产物/部署脚本改动会被拦住）。
 *   - 检查 7：ops/scripts 内禁止写死 `--net testnet`（主网部署脚本必须显式指定网络）。
 *   - 检查 8：生产 D1 必须独立于演示库（database_id 不同且非全 0 占位符）。
 *   - tag 可用 --tag=<expected> 覆盖（演练/回归用）。
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const WORKER = join(ROOT, "worker");

/* ------------------------------ 基线常量 ------------------------------ */

/**
 * v11 合约 code hash（hex，小写、无 0x）。来源：contracts/README.md §0 与 §7.1。
 * 注意：这是审计前的 v11 构建；外部审计若改动代码，必须同步更新这里和 README，并打 tag v11-audit-fixed。
 */
const BASELINE_HASHES = {
  RoundController: "905f62f5cf3b114e94f195e25319f58a505fbfcd78ea3997ae8e26d285d5c96b",
  StakeTicket: "0f00d2995452947199ce5887b17c3f0bf502ecae1d9a439a74a8d32e7ebd3dbc",
  JunxiangDistributor: "7fd6f461cf14393c3bb0fecb1208eb9b796a974d84b140ee9fce9b10b14932af",
  ClaimRecord: "a74d51786d46fe16a749d92d71d5479a6d10689c5542d3a46d6b7e42fd302c43",
  JettonMaster: "76b56d9a6301223f1201d719e2f4a3fb84e08d7d701cb93bb43c9d0208e5e241",
  JettonWallet: "d06daa57ed188ce9cb6ca596dd2111347433bf335223ac66c0d713c8e3db74f4",
};
function baselineSource() {
  return "contracts/README.md §0 / §7.1（v11；主网要求 tag v11-audit-fixed）";
}

/** V7 时间线（docs/00_DECISIONS_V2.md）。 */
const V7_TIMING = {
  previewSeconds: 43200,
  stakeDurationSeconds: 129600,
  candleSeconds: 3600,
  candleCount: 24,
  minQualifiedCandles: 16,
  observationSeconds: 86400,
};

const V7_DOC_TOKENS = [
  "PREVIEW_SECONDS=43200",
  "STAKE_DURATION_SECONDS=129600",
  "CANDLE_SECONDS=3600",
  "CANDLE_COUNT=24",
  "MIN_QUALIFIED_CANDLES=16",
  "OBSERVATION_SECONDS=86400",
];

/* ------------------------------ 输出与检查框架 ------------------------------ */

const results = [];

function record(id, title, ok, details) {
  results.push({ id: id, title: title, ok: ok, details: details || [] });
}

function runCheck(id, title, fn) {
  try {
    const details = fn();
    record(id, title, true, details);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    record(id, title, false, message.split("\n"));
  }
}

/** 收集一个检查项内的全部问题，最后一次性报出（方便「还差什么」一次看全）。 */
function collect() {
  const issues = [];
  return {
    add: function (message) {
      issues.push(message);
    },
    throwIfAny: function () {
      if (issues.length > 0) fail(issues.join("\n"));
    },
    issues: issues,
  };
}

function fail(message) {
  throw new Error(message);
}

function assertEqual(details, label, actual, expected) {
  const a = String(actual);
  const e = String(expected);
  if (a !== e) fail(label + " 期望 " + e + "，实际 " + a);
  details.push(label + "=" + e + " ✓");
}

function readText(file) {
  if (!existsSync(file)) fail("文件不存在：" + file);
  return readFileSync(file, "utf8");
}

function readJson(file) {
  const text = readText(file);
  try {
    return JSON.parse(text);
  } catch (error) {
    fail("JSON 解析失败：" + file + "（" + (error instanceof Error ? error.message : String(error)) + "）");
  }
}

function getPath(obj, path) {
  let cur = obj;
  for (const key of path.split(".")) {
    if (cur === null || typeof cur !== "object" || !(key in cur)) {
      fail("缺少字段 " + path);
    }
    cur = cur[key];
  }
  return cur;
}

/** 极简 TOML 段解析（只取 [section] 下的 key = "value"，足够读取 wrangler.toml vars）。 */
function parseTomlSection(text, sectionName) {
  const lines = text.split(/\r?\n/);
  let current = null;
  const values = new Map();
  let found = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const header = line.match(/^\[([^\]]+)\]$/);
    if (header) {
      current = header[1].trim();
      if (current === sectionName) found = true;
      continue;
    }
    if (current !== sectionName) continue;
    const kv = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.+)$/);
    if (!kv) continue;
    let value = kv[2].trim();
    const quoted = value.match(/^"([^"]*)"$/);
    if (quoted) value = quoted[1];
    values.set(kv[1], value);
  }
  if (!found) fail("wrangler.toml 缺少 [" + sectionName + "] 段");
  return values;
}

function parseDevVars() {
  const file = join(WORKER, ".dev.vars");
  const map = new Map();
  if (!existsSync(file)) return map;
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    map.set(line.slice(0, idx).trim(), line.slice(idx + 1).trim());
  }
  return map;
}

/* ------------------------------ 1. 配置 ------------------------------ */

function checkConfig() {
  const details = [];
  const toml = readText(join(WORKER, "wrangler.toml"));
  const vars = parseTomlSection(toml, "env.production.vars");

  const required = {
    DATA_SOURCE: "chain",
    CHAIN_NETWORK: "mainnet",
    DEMO_ALLOW_UNSIGNED_WRITES: "false",
    DEMO_AUTOPLAY: "false",
  };
  const issues = collect();
  for (const [key, expected] of Object.entries(required)) {
    if (!vars.has(key)) {
      issues.add("[env.production.vars] 缺少 " + key);
      continue;
    }
    const actual = String(vars.get(key));
    if (actual !== expected) issues.add(key + " 期望 " + expected + "，实际 " + actual);
  }

  const placeholders = [
    "ROUND_CONTROLLER_ADDRESS",
    "TEAM_WALLET_ADDRESS",
    "KEEPER_ADDRESS",
    "JETTON_MASTER_ADDRESS",
    "ORACLE_CONFIG_HASH",
  ];
  for (const key of placeholders) {
    const envOverride = process.env["PROD_" + key];
    if (envOverride && envOverride.trim()) {
      // 与 CI 部署门禁一致：真实地址可由 GitHub Variables / 环境变量 PROD_* 注入
      const override = envOverride.trim();
      if (override.indexOf("__") >= 0 || override.toUpperCase().indexOf("PLACEHOLDER") >= 0) {
        issues.add("PROD_" + key + " 仍是占位符值");
        continue;
      }
      details.push(key + " 已由环境变量注入（非占位符）✓");
      continue;
    }
    if (!vars.has(key)) {
      issues.add("[env.production.vars] 缺少 " + key);
      continue;
    }
    const value = String(vars.get(key)).trim();
    if (!value) {
      issues.add(key + " 为空");
      continue;
    }
    if (value.indexOf("__") >= 0 || value.toUpperCase().indexOf("PLACEHOLDER") >= 0) {
      issues.add(key + " 仍是占位符（部署时必须由 GitHub Variables 注入真实值）");
      continue;
    }
    details.push(key + " 已注入（非占位符）✓");
  }
  issues.throwIfAny();
  return details;
}

/* ------------------------------ 2. 合约哈希 ------------------------------ */

function checkContractHashes() {
  const details = [];
  const buildDir = join(ROOT, "contracts", "build");
  const issues = collect();
  for (const [name, expected] of Object.entries(BASELINE_HASHES)) {
    const artifact = readJson(join(buildDir, name + ".json"));
    if (typeof artifact.hash !== "string" || !artifact.hash) {
      issues.add(name + ".json 缺少 hash 字段");
      continue;
    }
    const actual = artifact.hash.replace(/^0x/i, "").toLowerCase();
    if (actual !== expected) {
      issues.add(name + " hash 与 v11 基线不一致：期望 " + expected + "，实际 " + actual);
      continue;
    }
    details.push(name + "=" + expected.slice(0, 12) + "… ✓");
  }
  issues.throwIfAny();
  details.push("基线来源：" + baselineSource());
  return details;
}

/* ------------------------------ 3. 主网参数 ------------------------------ */

function checkMainnetParams() {
  const details = [];
  const params = readJson(join(ROOT, "ops", "config", "mainnet.params.json"));

  for (const [key, expected] of Object.entries(V7_TIMING)) {
    assertEqual(details, "timeline." + key, getPath(params, "timeline." + key), expected);
  }
  assertEqual(details, "price.p0UsdE8", getPath(params, "price.p0UsdE8"), "116000");
  assertEqual(details, "rounds.roundRewardRaw", getPath(params, "rounds.roundRewardRaw"), "700000000000000000");
  assertEqual(details, "rounds.teamRoundRaw", getPath(params, "rounds.teamRoundRaw"), "120000000000000000");
  assertEqual(details, "stakeLimits.minStakeRaw", getPath(params, "stakeLimits.minStakeRaw"), "1000000000000");
  assertEqual(details, "stakeLimits.maxTotalStakeRaw", getPath(params, "stakeLimits.maxTotalStakeRaw"), "0");
  assertEqual(details, "stakeLimits.maxStakePerAddressBps", getPath(params, "stakeLimits.maxStakePerAddressBps"), "0");
  assertEqual(details, "network.chainId", getPath(params, "network.chainId"), -239);

  // 与 docs/00 V7 时间线口径交叉校验：文档里必须能读到同样的常量（拿不到 = FAIL）
  const docs = readText(join(ROOT, "docs", "00_DECISIONS_V2.md"));
  for (const token of V7_DOC_TOKENS) {
    if (docs.indexOf(token) < 0) fail("docs/00 缺少 V7 常量 " + token + "（无法确认与主网参数一致）");
  }
  details.push("docs/00 V7 时间线常量 ✓（" + V7_DOC_TOKENS.length + " 项）");
  return details;
}

/* ------------------------------ 4. 迁移目录 ------------------------------ */

function checkMigrations() {
  const details = [];
  const dir = join(WORKER, "migrations");
  if (!existsSync(dir)) fail("worker/migrations 目录不存在");
  const entries = readdirSync(dir).sort();
  const sqlFiles = entries.filter((name) => name.endsWith(".sql"));
  if (sqlFiles.length === 0) fail("worker/migrations 下没有任何 .sql 迁移文件");
  const issues = collect();
  for (const name of sqlFiles) {
    if (!/^[0-9]{4}_.+\.sql$/.test(name)) {
      issues.add("非法迁移文件名：" + name + "（必须是 NNNN_*.sql；seed 请放 worker/seed/）");
      continue;
    }
    if (/seed/i.test(name)) {
      issues.add("迁移目录出现 seed 文件：" + name + "（禁止把演示种子当迁移执行）");
    }
  }
  issues.throwIfAny();
  details.push("迁移文件 " + sqlFiles.length + " 个，命名全部合法、无 seed");
  return details;
}

/* ------------------------------ 5. 源码冻结 tag ------------------------------ */

function git(args) {
  const result = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
  if (result.error) fail("无法执行 git " + args.join(" ") + "（" + result.error.message + "）");
  return result;
}

function checkGitTag() {
  const details = [];
  const arg = process.argv.slice(2).find((item) => item.startsWith("--tag="));
  const expectedTag = arg ? arg.slice("--tag=".length) : "v11-audit-fixed";
  if (!expectedTag) fail("--tag= 不能为空");

  // 1) tag 必须存在
  const rev = git(["rev-parse", "--verify", "--quiet", expectedTag + "^{commit}"]);
  if (rev.status !== 0) fail("冻结 tag 不存在：" + expectedTag);
  const commit = String(rev.stdout || "").trim();
  details.push("tag " + expectedTag + " -> " + commit.slice(0, 12) + " ✓");

  // 2) 合约/测试/构建产物/部署脚本必须与 tag 完全一致（文档允许在 tag 后继续提交）
  const frozenPaths = [
    "contracts/contracts",
    "contracts/build",
    "contracts/tests",
    "contracts/scripts",
  ];
  for (const path of frozenPaths) {
    if (!existsSync(join(ROOT, path))) fail("冻结路径不存在：" + path + "（无法确认与 tag 一致）");
  }

  const diff = git(["diff", "--quiet", expectedTag, "HEAD", "--"].concat(frozenPaths));
  if (diff.status !== 0) {
    const stat = git(["diff", "--stat", expectedTag, "HEAD", "--"].concat(frozenPaths));
    fail(
      "合约/测试/构建产物/部署脚本与冻结 tag " + expectedTag + " 不一致（tag 后禁止改动这些路径）：\n" +
        String(stat.stdout || stat.stderr || "").trim(),
    );
  }
  details.push("contracts/{contracts,build,tests,scripts} 与 " + expectedTag + " 完全一致 ✓");
  return details;
}

/* ------------------------------ 6. secrets 占位 ------------------------------ */

function checkSecrets() {
  const details = [];
  const devVars = parseDevVars();
  const names = ["ADMIN_TOKEN", "TONCENTER_API_KEY"];
  const issues = collect();
  for (const name of names) {
    const fromEnv = typeof process.env[name] === "string" && process.env[name].trim() !== "";
    const fromFile = devVars.has(name) && String(devVars.get(name)).trim() !== "";
    if (!fromEnv && !fromFile) {
      issues.add(name + " 缺失（环境变量与 worker/.dev.vars 均未提供；只报有无，不打印值）");
      continue;
    }
    details.push(name + " 存在 ✓（值已隐藏；来源：" + (fromEnv ? "环境变量" : "worker/.dev.vars") + "）");
  }
  issues.throwIfAny();
  return details;
}

/* ------------------------------ 7. ops 脚本禁止写死测试网 ------------------------------ */

function checkOpsNoTestnetNetFlag() {
  const details = [];
  // Exact file:line whitelist for the intentional legacy shim. Any new hardcode,
  // new file, or moved line fails immediately (no comment-line heuristics).
  const WHITELIST = new Map([
    ["ops/scripts/lib/toolchain.mjs:42", "注释（解释 shim 作用）"],
    ["ops/scripts/lib/toolchain.mjs:44", "兼容垫片（作用正是重写残留 --net testnet）"],
  ]);
  const result = spawnSync("grep", ["-rn", "--", "--net testnet", "ops/scripts"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (result.error) fail("无法执行 grep（" + result.error.message + "）");
  if (result.status === 1) {
    details.push("ops/scripts 内 --net testnet 命中 0 处 ✓");
    return details;
  }
  if (result.status !== 0) {
    fail("grep 执行失败（exit " + result.status + "）：" + String(result.stderr || "").trim());
  }
  const lines = String(result.stdout || "")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "");
  const exempt = [];
  const unexpected = [];
  for (const line of lines) {
    const m = /^([^:]+:\d+):/.exec(line);
    const key = m ? m[1] : null;
    if (key && WHITELIST.has(key)) exempt.push(key + "  (" + WHITELIST.get(key) + ")");
    else unexpected.push(line);
  }
  if (unexpected.length > 0) {
    fail(
      "ops/scripts 内仍有 " + unexpected.length + " 处未豁免的写死 --net testnet（主网部署脚本禁止写死测试网）：\n" +
        unexpected.slice(0, 20).join("\n") +
        (unexpected.length > 20 ? "\n…（仅显示前 20 处）" : ""),
    );
  }
  details.push(
    "已豁免 " + exempt.length + " 处（legacy shim，其作用正是重写残留）：",
    ...exempt.map((item) => "  " + item),
    "其余 0 处残留 ✓",
  );
  return details;
}

/* ------------------------------ 8. 生产 D1 与演示库分离 ------------------------------ */

function checkD1Separation() {
  const details = [];
  const text = readText(join(WORKER, "wrangler.toml"));

  function d1Id(sectionName) {
    const header = "[[ " + sectionName + " ]]".replace(/ /g, "");
    const pattern = new RegExp("\\[\\[" + sectionName.replace(/\./g, "\\.") + "\\]\\]([\\s\\S]*?)(?=\\n\\[|$)");
    const block = text.match(pattern);
    if (!block) fail("wrangler.toml 缺少 " + header + " 段");
    const id = block[1].match(/database_id\s*=\s*"([^"]*)"/);
    if (!id) fail(header + " 缺少 database_id");
    return id[1].trim();
  }

  const demoId = d1Id("d1_databases");
  const tomlProdId = d1Id("env.production.d1_databases");
  const override = process.env.PROD_D1_DATABASE_ID;
  const prodId = override && override.trim() ? override.trim() : tomlProdId;

  if (!prodId) fail("生产 D1 database_id 为空");
  if (/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(prodId) || prodId.indexOf("__") >= 0 || prodId.toUpperCase().indexOf("PLACEHOLDER") >= 0) {
    fail("生产 D1 database_id 仍是占位符（" + prodId + "）；部署时由 GitHub Variable PROD_D1_DATABASE_ID 注入");
  }
  if (demoId && prodId === demoId) {
    fail("生产 D1 database_id 与顶层 demo 相同（" + prodId + "）：主网迁移/索引器会写进演示库");
  }
  details.push("demo D1=" + demoId.slice(0, 8) + "… / prod D1=" + prodId.slice(0, 8) + "…（不同）✓");
  return details;
}

/* ------------------------------ 执行 ------------------------------ */

console.log("A9 主网部署前自检（preflight-mainnet）");
console.log("仓库：" + ROOT);
console.log("");

runCheck(1, "配置：env.production 必须是 chain / mainnet / 无签名关", checkConfig);
runCheck(2, "合约哈希：contracts/build 必须等于 v11 基线（4 个自研 + 2 个 Jetton 模板）", checkContractHashes);
runCheck(3, "主网参数：ops/config/mainnet.params.json 必须等于 V7", checkMainnetParams);
runCheck(4, "迁移目录：只允许 NNNN_*.sql 且不含 seed", checkMigrations);
runCheck(5, "源码冻结：tag 必须存在，且合约/测试/构建产物/部署脚本与 tag 完全一致", checkGitTag);
runCheck(6, "secrets 占位：ADMIN_TOKEN / TONCENTER_API_KEY 存在（不打印值）", checkSecrets);
runCheck(7, "ops 脚本：禁止写死 --net testnet（主网必须显式网络）", checkOpsNoTestnetNetFlag);
runCheck(8, "生产 D1：database_id 必须与 demo 不同且非占位符", checkD1Separation);

let failed = 0;
for (const result of results) {
  console.log("[" + result.id + "/" + results.length + "] " + (result.ok ? "PASS" : "FAIL") + " — " + result.title);
  for (const detail of result.details) {
    console.log("       " + detail);
  }
  if (!result.ok) failed += 1;
}

const passed = results.length - failed;
console.log("");
console.log("汇总：PASS " + passed + " / FAIL " + failed + " / TOTAL " + results.length);
if (failed > 0) {
  console.log("结果：FAIL（未通过主网部署前自检，禁止部署）");
  process.exit(1);
}
console.log("结果：PASS（" + results.length + " 项全部通过，可以进入部署流程）");
