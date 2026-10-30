#!/usr/bin/env node
/**
 * dsh-po CLI — 版本自适应状态检查。
 *
 *   dsh-po                同 status
 *   dsh-po status         显示宿主自省结果 + 各逻辑目标解析到的 entry id
 *   dsh-po verify         有未解析目标时退出码 1（可进 CI / 升级后自检）
 *   dsh-po adapt          按当前宿主改写本体 cordis.patch.yml 的 id（带备份）
 *
 * 与旧版的区别：不再用 grep 猜用户层 patch 是否含 `danger-full-access`，
 * 而是直接读运行中宿主的 bundle patch，判断每个覆盖目标是否真实存在。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { introspect } from "../lib/harness.js";
import { resolveTargets, LOGICAL_TARGETS } from "../lib/targets.js";

const NAME = "dsh-po";
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SELF_PATCH = path.join(PKG_ROOT, "cordis.patch.yml");

function findDshHome() {
  const seeds = [
    process.env.DSH_HOME,
    process.env.DSH_BASE,
    path.join(os.homedir(), ".dsh"),
  ].filter(Boolean);
  for (const seed of seeds) {
    try {
      if (fs.existsSync(path.join(seed, "profiles"))) return seed;
    } catch { /* next */ }
  }
  return "";
}

function profiles(home) {
  const root = path.join(home, "profiles");
  const out = [];
  try {
    for (const entry of fs.readdirSync(root)) {
      const dir = path.join(root, entry);
      try { if (fs.statSync(dir).isDirectory()) out.push(dir); } catch { /* skip */ }
    }
  } catch { /* ignore */ }
  return out;
}

function readJson(fp) {
  try { return JSON.parse(fs.readFileSync(fp, "utf8")); } catch { return null; }
}

function checkProfile(dir) {
  const res = { dir, bundles: false, insert: false, staticInject: false };
  const pkg = readJson(path.join(dir, "package.json"));
  res.bundles = Array.isArray(pkg?.dsh?.profile?.bundles) && pkg.dsh.profile.bundles.includes(NAME);
  try {
    const yml = fs.readFileSync(path.join(dir, "cordis.patch.yml"), "utf8");
    res.insert = /id:\s*dsh-po/.test(yml);
    // 旧版 insert 行写死了 inject: [systemPrompt, tools]，宿主服务改名时会拖死整个插件
    res.staticInject = /inject:\s*\[\s*systemPrompt\s*,\s*tools\s*\]/.test(yml);
  } catch { /* ignore */ }
  return res;
}

/** 本体 patch 里声明了哪些 id / 覆盖了哪些键。 */
function selfPatchTargets() {
  let text = "";
  try { text = fs.readFileSync(SELF_PATCH, "utf8"); } catch { return { ok: false, entries: [] }; }
  const entries = [];
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    const id = /^\s*-\s*id:\s*(\S+)\s*$/.exec(line);
    if (id) { cur = { id: id[1], keys: [] }; entries.push(cur); continue; }
    if (!cur) continue;
    const key = /^\s{4}([A-Za-z0-9_$.-]+):/.exec(line);
    if (key) cur.keys.push(key[1]);
  }
  return { ok: true, entries };
}

async function main() {
  const cmd = process.argv[2] || "status";
  const home = findDshHome();
  const intro = introspect({ fresh: true });
  const plan = resolveTargets(intro);

  process.stdout.write(`${NAME} — no-patch cordis plugin (version-adaptive)\n`);

  if (!home) {
    process.stdout.write("DSH_HOME: (not found)\n");
  } else {
    process.stdout.write(`DSH_HOME: ${home}\n`);
  }

  process.stdout.write(`harness: ${plan.version || "unknown"}  kind=${plan.kind || "n/a"}  root=${intro.root || "(not found)"}\n`);
  if (!intro.ok) {
    process.stdout.write(`  ! 自省未完成：${intro.reason}（使用内置默认值，忽略版本差异）\n`);
  } else {
    process.stdout.write(`  bundles: ${intro.bundles.join(", ")}\n`);
    process.stdout.write(`  entries: ${intro.entries.length}\n`);
  }

  process.stdout.write("\n逻辑目标 → 解析结果\n");
  for (const logical of Object.keys(LOGICAL_TARGETS)) {
    const hit = plan.found[logical];
    const id = plan.ids[logical];
    const state = hit ? "OK  " : (intro.ok ? "MISS" : "DFLT");
    const pkg = hit && hit.name ? `  ${hit.name}` : "";
    process.stdout.write(`  ${state} ${logical.padEnd(18)} id=${id}${pkg}\n`);
  }

  process.stdout.write("\n运行时契约\n");
  process.stdout.write(`  systemPrompt service: ${plan.services.systemPrompt}\n`);
  process.stdout.write(`  approval service    : ${plan.services.approval}\n`);
  process.stdout.write(`  approval events     : ${plan.approvalEvents.join(", ")}\n`);
  process.stdout.write(`  orders              : prompt=${plan.globalPromptOrder} approvalCtx=${plan.approvalContextOrder}\n`);

  const self = selfPatchTargets();
  if (self.ok) {
    process.stdout.write("\n本体 patch 覆盖检查\n");
    for (const entry of self.entries) {
      const present = intro.ok ? intro.byId.has(entry.id) : null;
      const state = present === null ? "??" : (present ? "OK" : "MISS");
      process.stdout.write(`  ${state} id=${entry.id}${entry.keys.length ? `  keys=${entry.keys.join(",")}` : ""}\n`);
    }
  }

  for (const dir of profiles(home)) {
    const r = checkProfile(dir);
    process.stdout.write(`\nprofile: ${path.basename(dir)}\n`);
    process.stdout.write(`  bundles 已包含 ${NAME}: ${r.bundles ? "yes" : "no"}\n`);
    process.stdout.write(`  cordis.patch.yml 本体 insert: ${r.insert ? "yes" : "no"}\n`);
    if (r.staticInject) {
      process.stdout.write("  ! insert 行仍有静态 inject=[systemPrompt,tools]：建议跑 `dsh-po adapt` 移除\n");
    }
  }

  const unresolved = Object.keys(LOGICAL_TARGETS).filter((k) => !plan.found[k]);

  if (cmd === "adapt") {
    process.stdout.write("\n→ 对齐本体 patch 的 entry id…\n");
    const { adaptSelfPatch } = await import("../scripts/resolve-patch.mjs");
    const report = adaptSelfPatch({ dryRun: process.argv.includes("--dry-run") });
    process.stdout.write(report.lines.map((l) => `  ${l}\n`).join("") || "  (无变化)\n");

    process.stdout.write("\n→ 迁移 profile 里的静态 inject 行…\n");
    const { migrateStaticInject, ensureProfileBodyInsert } = await import("../scripts/profile-insert.js");
    for (const dir of profiles(home)) {
      const migrated = migrateStaticInject(dir);
      if (migrated.changed) {
        process.stdout.write(`  ${path.basename(dir)}: 已移除 inject: [systemPrompt, tools]\n`);
      } else if (!migrated.ok) {
        process.stdout.write(`  ${path.basename(dir)}: 读取失败，跳过\n`);
      } else {
        process.stdout.write(`  ${path.basename(dir)}: 无静态 inject，保持\n`);
      }
      try {
        const insert = ensureProfileBodyInsert(dir);
        if (insert.wrote) process.stdout.write(`  ${path.basename(dir)}: 补写本体 insert\n`);
      } catch (error) {
        process.stdout.write(`  ${path.basename(dir)}: insert 失败 ${(error && error.message) || error}\n`);
      }
    }
  }

  if (cmd === "verify") {
    if (intro.ok && unresolved.length === 0) {
      process.stdout.write("\nverify: 全部目标已解析。\n");
      process.exit(0);
    }
    process.stdout.write(`\nverify: 未解析目标 ${unresolved.join(", ") || "(none)"}；宿主 ${plan.version || "unknown"}\n`);
    process.exit(1);
  }

  process.stdout.write("\n说明：本插件没有「Apply 补丁」步骤，改完文件后完全退出并重启 dsh 宿主（web / desktop）。\n");
  process.stdout.write("升级 DSH 之后跑一次 `dsh-po status`（或 `dsh-po verify`）即可知道是否仍然适配。\n");
}

main().catch((error) => {
  process.stderr.write(`${NAME}: ${(error && error.message) || error}\n`);
  process.exit(1);
});
