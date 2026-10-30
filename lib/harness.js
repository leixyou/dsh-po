/**
 * 宿主自省（runtime introspection）。
 *
 * 目标：不靠版本号字符串，也不靠硬编码表，而是直接读「正在运行的这套 DSH」
 * 安装目录里的真实内容，反推插件要用的契约：
 *
 *   - bundle patch 里实际存在的 entry id（`approval` / `permission` / ...）
 *   - 每个 id 当前指向的包名（rc.5 把 dsh-approval 改名成 dsh-user-approval 等）
 *   - 服务名（`super(ctx, "systemPrompt")`）
 *   - 审批事件名（`approval/request`）
 *   - systemPrompt 的 order 常量（HARNESS_IDENTITY / APPROVAL_POLICY）
 *
 * 兼容两种安装形态：
 *   1. Electron 打包：resources/app.asar（asar 索引 + 偏移读取，不落盘）
 *   2. 解包/开发树：resources/dsh/node_modules/...
 */
import fs from "node:fs";
import path from "node:path";

const PKG_SCOPE = "@deepseek-ai";
const ASAR_MAX_HEADER = 64 * 1024 * 1024;

/* ────────────────────────────── 基础文件工具 ────────────────────────────── */

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/* ───────────────────────────── 定位宿主根目录 ───────────────────────────── */

function looksLikeHarness(root) {
  if (!root) return false;
  return isFile(path.join(root, "app.asar"))
    || isDir(path.join(root, "dsh", "node_modules", PKG_SCOPE))
    || isDir(path.join(root, "node_modules", PKG_SCOPE));
}

/**
 * 依次尝试：显式环境变量 → Electron resourcesPath → 可执行文件推导 →
 * macOS 默认安装位 → 从 cwd 向上查找。
 */
export function findResourcesRoot() {
  const cands = [];
  const push = (p) => { if (p && typeof p === "string" && !cands.includes(p)) cands.push(p); };

  push(process.env.DSH_RESOURCES);
  push(process.env.DSH_APP_ROOT);
  push(typeof process.resourcesPath === "string" ? process.resourcesPath : "");

  if (typeof process.execPath === "string" && process.execPath) {
    const binDir = path.dirname(process.execPath);
    // macOS: Contents/MacOS/<bin> → Contents/Resources
    push(path.join(binDir, "..", "Resources"));
    // Windows/Linux: <app>/<bin> → <app>/resources
    push(path.join(binDir, "resources"));
  }

  push("/Applications/DeepSeek Harness.app/Contents/Resources");

  for (const c of cands) {
    try {
      if (looksLikeHarness(c)) return path.resolve(c);
    } catch { /* next */ }
  }

  let dir = process.cwd();
  for (let i = 0; i < 10; i += 1) {
    if (looksLikeHarness(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "";
}

/* ─────────────────────────────── asar 读取器 ─────────────────────────────── */

function readAsarIndex(asarPath) {
  let fd = null;
  try {
    fd = fs.openSync(asarPath, "r");
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    const jsonSize = head.readUInt32LE(12);
    if (!jsonSize || jsonSize > ASAR_MAX_HEADER) throw new Error("bad asar header");
    const raw = Buffer.alloc(jsonSize);
    fs.readSync(fd, raw, 0, jsonSize, 16);
    const tree = JSON.parse(raw.toString("utf8"));
    const dataStart = 8 + head.readUInt32LE(4);
    return { fd, tree, dataStart };
  } catch {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
    return null;
  }
}

/**
 * 打开 asar，返回只读文件视图：{ kind, root, read(rel), list(), close() }。
 */
export function openAsar(asarPath) {
  const idx = readAsarIndex(asarPath);
  if (!idx) return null;
  const { fd, tree, dataStart } = idx;

  const nodeAt = (rel) => {
    let node = tree;
    for (const seg of String(rel).split("/")) {
      if (!seg) continue;
      if (!node || !node.files || !node.files[seg]) return null;
      node = node.files[seg];
    }
    return node;
  };

  let cache = null;

  return {
    kind: "asar",
    root: path.dirname(asarPath),
    read(rel) {
      const node = nodeAt(rel);
      if (!node || node.offset === undefined) return null;
      const len = Number(node.size) || 0;
      if (!len) return "";
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, dataStart + Number(node.offset));
      return buf.toString("utf8");
    },
    list() {
      if (cache) return cache;
      const out = [];
      const walk = (node, prefix) => {
        if (node.files) {
          for (const [k, v] of Object.entries(node.files)) walk(v, prefix ? `${prefix}/${k}` : k);
        } else if (node.offset !== undefined) {
          out.push(prefix);
        }
      };
      walk(tree, "");
      cache = out;
      return out;
    },
    close() { try { fs.closeSync(fd); } catch { /* ignore */ } },
  };
}

/** 解包目录形态的文件视图，接口与 openAsar 一致。 */
export function openDir(root) {
  return {
    kind: "dir",
    root,
    read(rel) {
      const fp = path.join(root, rel);
      try { return fs.readFileSync(fp, "utf8"); } catch { return null; }
    },
    list() {
      const out = [];
      const walk = (dir, prefix) => {
        let ents = [];
        try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const ent of ents) {
          const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
          if (ent.isDirectory()) walk(path.join(dir, ent.name), rel);
          else out.push(rel);
        }
      };
      walk(root, "");
      return out;
    },
    close() { /* nothing to release */ },
  };
}

/** 打开宿主文件系统视图（优先 asar，其次解包目录）。 */
export function openHarnessFs(root = findResourcesRoot()) {
  if (!root) return null;
  const asarPath = path.join(root, "app.asar");
  if (isFile(asarPath)) {
    const view = openAsar(asarPath);
    if (view) return view;
  }
  if (isDir(path.join(root, "dsh"))) return openDir(root);
  if (isDir(path.join(root, "node_modules", PKG_SCOPE))) return openDir(root);
  return null;
}

/** asar 内常见的前缀差异：`dsh/...` 与裸 `...`。 */
function readAny(view, rels) {
  for (const rel of rels) {
    const text = view.read(rel);
    if (text !== null && text !== undefined) return text;
  }
  return null;
}

/* ───────────────────────────── 包级信息读取 ───────────────────────────── */

export function packageJson(view, pkgName) {
  const rel = `node_modules/${PKG_SCOPE}/${pkgName}/package.json`;
  const text = readAny(view, [rel, `dsh/${rel}`]);
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * 读取一个 bundle 声明的全部 patch 文件。
 * 注意 `dsh.bundle.patch` 可能是 string，也可能是 string[]（如 dsh-web-app
 * 会带 presets/*.patch.yml），这里统一摊平。
 */
export function bundlePatchTexts(view, pkgName) {
  const pkg = packageJson(view, pkgName);
  const declared = pkg?.dsh?.bundle?.patch;
  const list = Array.isArray(declared) ? declared : (declared ? [declared] : ["cordis.patch.yml"]);

  const texts = [];
  for (const item of list) {
    if (typeof item !== "string") continue;
    const rel = `node_modules/${PKG_SCOPE}/${pkgName}/${item.replace(/^\.\//, "")}`;
    const text = readAny(view, [rel, `dsh/${rel}`]);
    if (text) texts.push(text);
  }
  return texts;
}

/** 读取某个包的所有 .js 源码（用于探测 service 名 / 事件名 / 常量）。 */
export function packageSources(view, pkgName) {
  const needle = `node_modules/${PKG_SCOPE}/${pkgName}/`;
  const hits = view.list().filter((p) => p.includes(needle) && /\.(m?js|cjs)$/.test(p));
  const chunks = [];
  for (const rel of hits.slice(0, 8)) {
    const text = view.read(rel);
    if (text) chunks.push(text);
  }
  return chunks.join("\n");
}

/* ───────────────────────────── bundle patch 解析 ───────────────────────────── */

/**
 * 极简 YAML 块扫描：只提取 `- id:` 条目及其 `name:` / `config` 顶层键。
 * 不追求通用 YAML 能力，只要求对官方 patch 结构稳定。
 */
export function parseBundleEntries(text) {
  const entries = [];
  if (!text) return entries;

  let cur = null;
  const flush = () => { if (cur) { delete cur.cfgIndent; entries.push(cur); } cur = null; };

  for (const line of String(text).split(/\r?\n/)) {
    const idMatch = /^(\s*)-\s*id:\s*["']?([^"'\s#]+)["']?\s*(?:#.*)?$/.exec(line);
    if (idMatch) {
      flush();
      cur = {
        id: idMatch[2],
        name: null,
        configKeys: [],
        disabled: false,
        indent: idMatch[1].length,
        cfgIndent: undefined,
      };
      continue;
    }
    if (!cur) continue;

    const indent = (line.match(/^[ \t]*/) || [""])[0].length;
    const trimmed = line.trim();

    // 同层新的列表项 → 当前条目结束
    if (trimmed && indent <= cur.indent && /^-/.test(trimmed)) { flush(); continue; }

    if (!cur.name) {
      const nm = /^\s*name:\s*["']?([^"'\s#]+)["']?/.exec(line);
      if (nm) cur.name = nm[1];
    }
    if (/^\s*disabled:/.test(line)) cur.disabled = !/disabled:\s*false\b/.test(line);

    if (/^\s*config:\s*$/.test(line)) { cur.cfgIndent = indent; continue; }
    if (cur.cfgIndent !== undefined) {
      if (trimmed && indent <= cur.cfgIndent) { cur.cfgIndent = undefined; continue; }
      const key = /^\s*([A-Za-z0-9_$.-]+):/.exec(line);
      if (key) cur.configKeys.push(key[1]);
    }
  }
  flush();
  return entries;
}

/* ───────────────────────────── service / 事件探测 ───────────────────────────── */

function detectServiceName(sources, fallback) {
  const m = /super\(\s*ctx\s*,\s*["'`]([A-Za-z0-9_$]+)["'`]\s*\)/.exec(sources || "");
  return m ? m[1] : fallback;
}

function detectEventName(sources, fallback) {
  const re = /["'`]([a-z0-9][a-z0-9-]*\/request)["'`]/g;
  const found = new Set();
  let m;
  while ((m = re.exec(sources || "")) && found.size < 4) found.add(m[1]);
  return found.size ? [...found] : [fallback];
}

function detectOrder(sources, name, fallback) {
  const re = new RegExp(`${name}\\s*:\\s*(-?[0-9]+(?:\\.[0-9]+)?e?[+-]?[0-9]*)`, "i");
  const m = re.exec(sources || "");
  if (!m) return fallback;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : fallback;
}

/* ───────────────────────────── 活跃 bundle 列表 ───────────────────────────── */

function activeBundleNames() {
  const names = new Set(["dsh-base", "dsh-web-app"]);
  const home = process.env.DSH_HOME || path.join(process.env.HOME || "", ".dsh");
  const profilesDir = path.join(home, "profiles");
  let dirs = [];
  try { dirs = fs.readdirSync(profilesDir); } catch { return [...names]; }
  for (const d of dirs) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(profilesDir, d, "package.json"), "utf8"));
      const bundles = pkg?.dsh?.profile?.bundles;
      if (Array.isArray(bundles)) {
        for (const b of bundles) {
          if (typeof b === "string" && b.startsWith(`${PKG_SCOPE}/`)) names.add(b.slice(PKG_SCOPE.length + 1));
        }
      }
    } catch { /* 单个 profile 失败不影响整体 */ }
  }
  return [...names];
}

/* ─────────────────────────────── 主入口 ─────────────────────────────── */

const CACHE = new Map();

/**
 * 自省结果：
 * {
 *   ok, reason, root, kind, version, bundles,
 *   entries: [{id, name, configKeys, disabled}],
 *   byId: Map<id, entry>, byName: Map<name, entry>,
 *   services: { systemPrompt, approval },
 *   approvalEvents: string[],
 *   orders: { harnessIdentity, approvalPolicy },
 * }
 */
export function introspect(options = {}) {
  const cacheKey = options.root || "auto";
  if (!options.fresh && CACHE.has(cacheKey)) return CACHE.get(cacheKey);

  const out = {
    ok: false,
    reason: "",
    root: "",
    kind: "",
    version: "",
    bundles: [],
    entries: [],
    byId: new Map(),
    byName: new Map(),
    services: { systemPrompt: "systemPrompt", approval: "approval" },
    approvalEvents: ["approval/request"],
    orders: { harnessIdentity: -1000, approvalPolicy: 115 },
  };

  const root = options.root || findResourcesRoot();
  out.root = root;
  if (!root) {
    out.reason = "harness resources root not found";
    CACHE.set(cacheKey, out);
    return out;
  }

  const view = openHarnessFs(root);
  if (!view) {
    out.reason = "no app.asar and no unpacked dsh/ tree";
    CACHE.set(cacheKey, out);
    return out;
  }

  try {
    out.kind = view.kind;

    for (const name of ["dsh-base", "dsh-web-app", "dsh-brand"]) {
      const pkg = packageJson(view, name);
      if (pkg?.version) { out.version = pkg.version; break; }
    }
    if (!out.version && process.env.DSH_VERSION) out.version = process.env.DSH_VERSION;

    out.bundles = activeBundleNames();

    const seen = new Set();
    for (const bundle of out.bundles) {
      for (const text of bundlePatchTexts(view, bundle)) {
        for (const entry of parseBundleEntries(text)) {
          const key = `${entry.id}\u0000${entry.name || ""}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.entries.push(entry);
        }
      }
    }

    for (const entry of out.entries) {
      if (!out.byId.has(entry.id)) out.byId.set(entry.id, entry);
      if (entry.name && !out.byName.has(entry.name)) out.byName.set(entry.name, entry);
    }

    // 服务名 / 事件名 / order 常量：从实际包源码探测
    const sysEntry = out.byId.get("system-prompt");
    const sysPkg = sysEntry?.name || `${PKG_SCOPE}/dsh-system-prompt`;
    const sysSrc = packageSources(view, sysPkg.replace(`${PKG_SCOPE}/`, ""));
    if (sysSrc) {
      out.services.systemPrompt = detectServiceName(sysSrc, out.services.systemPrompt);
      out.orders.harnessIdentity = detectOrder(sysSrc, "HARNESS_IDENTITY", out.orders.harnessIdentity);
      out.orders.approvalPolicy = detectOrder(sysSrc, "APPROVAL_POLICY", out.orders.approvalPolicy);
    }

    const apprEntry = out.byId.get("approval");
    const apprPkg = apprEntry?.name || `${PKG_SCOPE}/dsh-user-approval`;
    const apprSrc = packageSources(view, apprPkg.replace(`${PKG_SCOPE}/`, ""));
    if (apprSrc) {
      out.services.approval = detectServiceName(apprSrc, out.services.approval);
      out.approvalEvents = detectEventName(apprSrc, "approval/request");
    }

    out.ok = out.entries.length > 0;
    if (!out.ok) out.reason = "no bundle patch entries discovered";
  } catch (error) {
    out.reason = `introspection failed: ${(error && error.message) || error}`;
  } finally {
    view.close();
  }

  CACHE.set(cacheKey, out);
  return out;
}

/** 测试/诊断用：清空自省缓存。 */
export function clearIntrospectionCache() {
  CACHE.clear();
}
