import fs from "node:fs";
import path from "node:path";

export const NAME = "dsh-po";

export const INSERT_BLOCK = [
  "- insert:",
  "    - id: dsh-po",
  "      name: dsh-po",
  "      inject: [systemPrompt, tools]",
  "      config:",
  "        enabled: true",
  "        verbose: false",
  "",
].join("\n");

export function profileHasBodyInsert(text) {
  const lines = String(text || "").split(/\r?\n/);
  let insertIndent = -1;
  for (const line of lines) {
    if (/^\s*-\s*insert:\s*$/.test(line)) {
      insertIndent = (line.match(/^[ \t]*/) || [""])[0].length;
      continue;
    }
    if (insertIndent < 0) continue;
    const indent = (line.match(/^[ \t]*/) || [""])[0].length;
    const trimmed = line.trim();
    if (trimmed && indent <= insertIndent && /^-\s/.test(trimmed)) {
      insertIndent = -1;
      if (/^\s*-\s*insert:\s*$/.test(trimmed)) insertIndent = indent;
      continue;
    }
    if (/^-\s*id:\s*dsh-po\s*$/.test(trimmed)) return true;
    if (/^-\s*name:\s*dsh-po\s*$/.test(trimmed)) return true;
  }
  return false;
}

function isEffectivelyEmpty(text) {
  const lines = String(text || "").split(/\r?\n/).filter((l) => {
    const t = l.trim();
    return t !== "" && !t.startsWith("#");
  });
  if (lines.length === 0) return true;
  if (lines.length === 1 && lines[0].trim() === "[]") return true;
  return false;
}

export function ensureProfileBodyInsert(profileDir) {
  const fp = path.join(profileDir, "cordis.patch.yml");
  let text = "";
  try { text = fs.readFileSync(fp, "utf8"); } catch { text = ""; }
  if (profileHasBodyInsert(text)) {
    return { ok: true, wrote: false, path: fp };
  }
  // 全新 profile 的 cordis.patch.yml 可能是空列表 `[]`，直接追加 insert 会
  // 形成两个 YAML 文档（`[]\n- insert:`）导致 parsePatchList 抛错。
  // 空内容 / 纯 `[]` / 仅注释直接写 INSERT_BLOCK。
  if (isEffectivelyEmpty(text)) {
    fs.writeFileSync(fp, INSERT_BLOCK, "utf8");
    return { ok: true, wrote: true, path: fp };
  }
  const prefix = text && !text.endsWith("\n") ? "\n" : "";
  fs.writeFileSync(fp, `${text}${prefix}${text ? "\n" : ""}${INSERT_BLOCK}`, "utf8");
  return { ok: true, wrote: true, path: fp };
}

function readJson(fp) {
  try { return JSON.parse(fs.readFileSync(fp, "utf8")); } catch { return null; }
}

export function ensureProfileBundles(profileDir) {
  const fp = path.join(profileDir, "package.json");
  const pkg = readJson(fp);
  if (!pkg) return { ok: false, wrote: false, path: fp };
  pkg.dsh = pkg.dsh && typeof pkg.dsh === "object" ? pkg.dsh : {};
  pkg.dsh.profile = pkg.dsh.profile && typeof pkg.dsh.profile === "object" ? pkg.dsh.profile : {};
  const bundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : [];
  if (bundles.includes(NAME)) return { ok: true, wrote: false, path: fp };
  pkg.dsh.profile.bundles = [...bundles, NAME];
  fs.writeFileSync(fp, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
  return { ok: true, wrote: true, path: fp };
}

export function findProfileDir() {
  const seeds = [process.env.INIT_CWD, process.env.npm_config_local_prefix, process.cwd()].filter(Boolean);
  for (const seed of seeds) {
    let dir = path.resolve(seed);
    for (let i = 0; i < 8; i += 1) {
      const pkg = readJson(path.join(dir, "package.json"));
      const isProfile =
        (pkg && typeof pkg.name === "string" && pkg.name.startsWith("dsh-profile-")) ||
        (pkg && Array.isArray(pkg?.dsh?.profile?.bundles));
      if (isProfile) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return "";
}
