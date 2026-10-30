/**
 * 按当前宿主改写本体 cordis.patch.yml 的 entry id。
 *
 * 场景：将来某个 DSH 版本把 entry id 从 `approval` 改成 `approvals` 之类，
 * bundle patch 里的 id 变了，本体静态 YAML 就会指向一个不存在的条目。
 * 这里用运行时自省得到的真实 id 做一次 remap，并留下 .bak。
 *
 *   node scripts/resolve-patch.mjs            # 改写
 *   node scripts/resolve-patch.mjs --dry-run  # 只看差异
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { introspect } from "../lib/harness.js";
import { resolveTargets, LOGICAL_TARGETS } from "../lib/targets.js";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SELF_PATCH = path.join(PKG_ROOT, "cordis.patch.yml");

/**
 * @returns {{changed: boolean, remapped: Array<{from: string, to: string}>, lines: string[]}}
 */
export function adaptSelfPatch(options = {}) {
  const result = { changed: false, remapped: [], lines: [] };

  let text;
  try {
    text = fs.readFileSync(SELF_PATCH, "utf8");
  } catch (error) {
    result.lines.push(`读取失败：${(error && error.message) || error}`);
    return result;
  }

  const intro = introspect({ fresh: true });
  const plan = resolveTargets(intro);
  if (!intro.ok) {
    result.lines.push(`自省不可用（${intro.reason}）；保持原样`);
    return result;
  }

  // 旧 id → 当前 id（仅当旧 id 在当前宿主中确实不存在时替换）
  const remap = new Map();
  for (const [logical, candidates] of Object.entries(LOGICAL_TARGETS)) {
    const resolved = plan.ids[logical];
    if (!resolved) continue;
    for (const candidate of candidates) {
      if (candidate !== resolved && !intro.byId.has(candidate)) remap.set(candidate, resolved);
    }
  }

  const outLines = text.split(/\r?\n/).map((line) => {
    const m = /^(\s*-\s*id:\s*)(\S+)(\s*)$/.exec(line);
    if (!m) return line;
    const current = m[2];
    const next = remap.get(current);
    if (!next || next === current) return line;
    result.changed = true;
    result.remapped.push({ from: current, to: next });
    result.lines.push(`remap ${current} -> ${next}`);
    return `${m[1]}${next}${m[3]}`;
  });

  if (!result.changed) {
    result.lines.push("本体 patch id 与当前宿主一致，无需改写");
    return result;
  }
  if (options.dryRun) {
    result.lines.push("(dry-run：未写入)");
    return result;
  }

  fs.writeFileSync(`${SELF_PATCH}.bak`, text, "utf8");
  fs.writeFileSync(SELF_PATCH, outLines.join("\n"), "utf8");
  result.lines.push(`已写入 ${SELF_PATCH}（备份 ${path.basename(SELF_PATCH)}.bak）`);
  return result;
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invoked === fileURLToPath(import.meta.url)) {
  const report = adaptSelfPatch({ dryRun: process.argv.includes("--dry-run") });
  process.stdout.write(`${report.lines.join("\n")}\n`);
  process.exit(report.changed ? 0 : 0);
}
