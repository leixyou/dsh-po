#!/usr/bin/env node
/**
 * dsh-po CLI — 版本自适应状态检查。
 *
 *   dsh-po                同 status
 *   dsh-po status         显示宿主自省结果 + 各逻辑目标解析到的 entry id
 *   dsh-po verify         有未解析目标时退出码 1（可进 CI / 升级后自检）
 *   dsh-po adapt          按当前宿主改写本体 cordis.patch.yml 的 id（带备份）
 *   dsh-po setup          交互式输入 Azure Translator key/region，写入 rewrite.translate
 *   dsh-po rewrite "文本"  用当前 profile 的 rewrite 配置跑一遍改写，打印 target/path/result
 *                         （验证“自动改写到底有没有生效”，不用重启宿主）
 *   dsh-po uninstall      清理 profile 残留（insert / bundles / node_modules 链接）
 *                         可用 --profile=<name> 只清理某个 profile
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

/** 交互式提问（仅 TTY；非 TTY 返回空串）。secret=true 时回显 *。 */
function ask(prompt, { secret = false } = {}) {
  return new Promise((resolve) => {
    const { stdin, stdout } = process;
    if (!stdin.isTTY || !stdout.isTTY) { resolve(""); return; }
    stdin.resume();
    stdin.setRawMode(true);
    stdout.write(prompt);
    let buf = "";
    const onData = (chunk) => {
      for (const ch of chunk.toString("utf8")) {
        const code = ch.charCodeAt(0);
        if (code === 3) { stdout.write("^C\n"); process.exit(130); }
        if (code === 13 || code === 10) {
          stdin.setRawMode(false);
          stdin.pause();
          stdout.write("\n");
          stdin.off("data", onData);
          resolve(buf.trim());
          return;
        }
        if (code === 127 || code === 8) {
          if (buf.length) { buf = buf.slice(0, -1); stdout.write("\b \b"); }
          continue;
        }
        buf += ch;
        stdout.write(secret ? "*" : ch);
      }
    };
    stdin.on("data", onData);
  });
}

async function main() {
  const cmd = process.argv[2] || "status";
  const home = findDshHome();

  if (cmd === "setup") {
    const { ensureProfileTranslateConfig } = await import("../scripts/profile-insert.js");
    const key = await ask("Azure Translator key（回车跳过）: ", { secret: true });
    if (!key) {
      process.stdout.write("未输入 key，未做改动。\n");
      return;
    }
    const region = (await ask("region [global]: ")) || "global";
    const targetArg = process.argv.find((a) => a.startsWith("--profile="));
    const wanted = targetArg ? targetArg.slice("--profile=".length) : "";
    let touched = false;
    for (const dir of profiles(home)) {
      if (wanted && path.basename(dir) !== wanted) continue;
      const r = ensureProfileTranslateConfig(dir, { enabled: true, key, region });
      if (r.ok && r.updated) {
        touched = true;
        process.stdout.write(`  ${path.basename(dir)}: 已写入 rewrite.translate（enabled=true, region=${region}）\n`);
      } else {
        process.stdout.write(`  ${path.basename(dir)}: ${r.reason || "未更新"}\n`);
      }
    }
    process.stdout.write(
      touched ? "\n完成。完全退出并重启 dsh 宿主后生效。\n" : "\n没有写入任何 profile（先安装并确保 insert 存在）。\n",
    );
    return;
  }

  if (cmd === "rewrite") {
    const [{ readDshPoConfig }, { rewriteUserMessageDetailed, DEFAULT_REPLY_SUFFIX }, { TRANSLATE_DEFAULTS }, { maskKey }] = await Promise.all([
      import("../lib/profile-config.js"),
      import("../lib/rewrite.js"),
      import("../lib/translate.js"),
      import("../lib/setup-tool.js"),
    ]);

    const flags = new Map();
    const words = [];
    for (const arg of process.argv.slice(3)) {
      if (!arg.startsWith("--")) { words.push(arg); continue; }
      const eq = arg.indexOf("=");
      if (eq < 0) flags.set(arg.slice(2), true);
      else flags.set(arg.slice(2, eq), arg.slice(eq + 1));
    }

    const wanted = typeof flags.get("profile") === "string" ? flags.get("profile") : "";
    const candidates = wanted ? [path.join(home, "profiles", wanted)] : ["desktop", "web", "headless"].map((n) => path.join(home, "profiles", n));

    let picked = null;
    let lastFailure = null;
    for (const dir of candidates) {
      const read = readDshPoConfig(dir);
      if (read.ok) { picked = { dir, read }; break; }
      lastFailure = { dir, read };
    }
    if (!picked) {
      const where = lastFailure ? `${lastFailure.read.path}: ${lastFailure.read.reason}` : "没有 profile";
      process.stdout.write(`没有可用的 dsh-po 配置（${where}）。先安装，或用 --profile=<name> 指定。\n`);
      process.exitCode = 2;
      return;
    }

    const { dir, read } = picked;
    const rewrite = { ...(read.config?.rewrite || {}) };
    if (flags.has("language")) rewrite.language = String(flags.get("language"));
    if (flags.has("phrase")) rewrite.phrase = String(flags.get("phrase"));
    if (flags.has("no-translate")) rewrite.translate = { ...(rewrite.translate || {}), enabled: false };

    const translate = { ...TRANSLATE_DEFAULTS, ...(rewrite.translate || {}) };

    let text = words.join(" ").trim();
    if (!text && !process.stdin.isTTY) {
      text = (await new Promise((resolve) => {
        let buffer = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk) => { buffer += chunk; });
        process.stdin.on("end", () => resolve(buffer));
      })).trim();
    }
    if (!text) {
      process.stdout.write('用法: dsh-po rewrite "帮我扫描这个接口的逻辑 #dshpo"\n');
      process.exitCode = 2;
      return;
    }

    const result = await rewriteUserMessageDetailed(
      { role: "user", content: [{ type: "text", text }], source: { kind: "user" } },
      rewrite,
    );
    const output = result.changed ? result.message.content[0].text : text;

    if (flags.has("json")) {
      process.stdout.write(`${JSON.stringify({
        profile: path.basename(dir),
        profileDir: dir,
        configPath: read.path,
        language: rewrite.language ?? "eu",
        phrase: rewrite.phrase ?? "assume_own",
        translate: {
          enabled: translate.enabled === true,
          maskedKey: maskKey(translate.key),
          region: translate.region,
        },
        codeword: result.codeword,
        replySuffix: rewrite.replySuffix === undefined ? DEFAULT_REPLY_SUFFIX : rewrite.replySuffix,
        target: result.target,
        via: result.via,
        reason: result.reason,
        input: text,
        output,
      }, null, 2)}\n`);
      return;
    }

    const reasonText = {
      "no-codeword": "没带暗语 —— 只有消息末尾带上 `#dshpo`（或 rewrite.code 指定的词）才会改写",
      "runtime-context": "这是运行时上下文快照，不改写",
      "not-user": "不是 user 消息，不改写",
      "no-text": "没有可读文本，不改写",
      "codeword-only": "整条消息只有暗语，没有正文可翻译",
    }[result.reason] || read.reason || "未改写";

    process.stdout.write(`profile : ${path.basename(dir)}  (${read.path})\n`);
    process.stdout.write(
      `rewrite : lang=${rewrite.language ?? "eu"} phrase=${rewrite.phrase ?? "assume_own"} ` +
        `translate=${translate.enabled ? `on(key=${maskKey(translate.key) || "missing"}, region=${translate.region || "-"})` : "off"}\n`,
    );
    if (result.codeword) process.stdout.write(`codeword: on（${rewrite.code || "#dshpo"}，已从正文剔除）\n`);
    const suffix = rewrite.replySuffix === undefined ? DEFAULT_REPLY_SUFFIX : rewrite.replySuffix;
    if (suffix) process.stdout.write(`reply   : ${JSON.stringify(suffix)}\n`);
    process.stdout.write(`target  : ${result.target ?? "(none)"}\n`);
    process.stdout.write(`path    : ${result.via}\n`);
    process.stdout.write(result.changed ? `result  : ${output}\n` : `result  : 未改写 — ${reasonText}\n`);
    return;
  }

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

  if (cmd === "uninstall" || cmd === "remove") {
    const { removeProfileBodyInsert, removeProfileBundles, removeStaleLinks } = await import("../scripts/profile-insert.js");
    const targetArg = process.argv.find((a) => a.startsWith("--profile="));
    const wanted = targetArg ? targetArg.slice("--profile=".length) : "";
    let touched = false;
    for (const dir of profiles(home)) {
      if (wanted && path.basename(dir) !== wanted) continue;
      const bundles = removeProfileBundles(dir);
      if (bundles.removed) { touched = true; process.stdout.write(`  ${path.basename(dir)}: removed from bundles\n`); }
      try {
        const insert = removeProfileBodyInsert(dir);
        if (insert.removed) { touched = true; process.stdout.write(`  ${path.basename(dir)}: removed body insert\n`); }
      } catch (error) {
        process.stdout.write(`  ${path.basename(dir)}: insert 删除失败 ${(error && error.message) || error}\n`);
      }
      const links = removeStaleLinks(dir);
      if (links > 0) { touched = true; process.stdout.write(`  ${path.basename(dir)}: removed ${links} stale link(s)\n`); }
    }
    process.stdout.write(touched ? "\n清理完成。完全退出并重启 dsh 宿主后生效。\n" : "\n没有需要清理的残留。\n");
    return;
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
