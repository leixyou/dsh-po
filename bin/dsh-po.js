#!/usr/bin/env node
/**
 * dsh-po CLI（纯 cordis 实现）。
 * 只做状态检查与说明，不改写任何 @deepseek-ai 源文件。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const NAME = "dsh-po";

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
    for (const name of fs.readdirSync(root)) {
      const dir = path.join(root, name);
      if (fs.statSync(dir).isDirectory()) out.push(dir);
    }
  } catch { /* ignore */ }
  return out;
}

function checkProfile(dir) {
  const res = { dir, bundles: false, insert: false, config: false };
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    res.bundles = Array.isArray(pkg?.dsh?.profile?.bundles) && pkg.dsh.profile.bundles.includes(NAME);
  } catch { /* ignore */ }
  try {
    const yml = fs.readFileSync(path.join(dir, "cordis.patch.yml"), "utf8");
    res.insert = /id:\s*dsh-po/.test(yml);
    res.config =
      /danger-full-access/.test(yml) &&
      /id:\s*approval\b[\s\S]*?policy:\s*ask/.test(yml);
  } catch { /* ignore */ }
  return res;
}

function main() {
  const [cmd] = process.argv.slice(2);
  const home = findDshHome();
  process.stdout.write(`${NAME} — no-patch cordis plugin (no source patching)\n`);
  process.stdout.write(`DSH_HOME: ${home || "(not found)"}\n\n`);

  if (!home) {
    process.stdout.write("未找到 DSH_HOME。请确认 dsh 已安装，或设置 DSH_HOME。\n");
    return;
  }

  for (const dir of profiles(home)) {
    const r = checkProfile(dir);
    process.stdout.write(`profile: ${path.basename(dir)}\n`);
    process.stdout.write(`  bundles 已包含 ${NAME}: ${r.bundles ? "yes" : "no"}\n`);
    process.stdout.write(`  cordis.patch.yml 本体 insert: ${r.insert ? "yes" : "no"}\n`);
    process.stdout.write(`  danger-full-access + approval ask 覆盖: ${r.config ? "yes" : "no"}\n`);
  }

  if (cmd === "apply" || cmd === "status") {
    process.stdout.write("\n说明：本插件没有「Apply 补丁」步骤。\n");
    process.stdout.write("安装后完全退出并重启 dsh 宿主（web / desktop）即生效。\n");
    process.stdout.write("验证：node bin/dsh-po.js status 或检查系统提示词是否已注入。\n");
  }
}

main();
