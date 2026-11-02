#!/usr/bin/env node
/**
 * 卸载 dsh-po 时清理 profile：
 *   1. cordis.patch.yml 里的本体 insert
 *   2. dsh.profile.bundles 里的 "dsh-po"
 *   3. node_modules 里遗留的 dsh-po 符号链接 / .bin shim
 * 找不到 profile 目录时整段跳过（与 ensure-profile-bundle.mjs 一致）。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  NAME,
  removeProfileBodyInsert,
  removeProfileBundles,
  removeStaleLinks,
  findProfileDir,
} from "./profile-insert.js";

function main() {
  const profileDir = findProfileDir();
  if (!profileDir) return;

  const bundles = removeProfileBundles(profileDir);
  process.stdout.write(
    bundles.removed
      ? `${NAME}: removed from bundles (${profileDir})\n`
      : `${NAME}: not in bundles (${profileDir})\n`,
  );

  try {
    const insert = removeProfileBodyInsert(profileDir);
    process.stdout.write(
      insert.removed
        ? `${NAME}: removed body insert (${insert.path})\n`
        : `${NAME}: no body insert in ${insert.path}\n`,
    );
  } catch (e) {
    process.stderr.write(`${NAME}: remove insert failed: ${(e && e.message) || e}\n`);
    process.exit(1);
  }

  const links = removeStaleLinks(profileDir);
  if (links > 0) process.stdout.write(`${NAME}: removed ${links} stale link(s)\n`);
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invoked === fileURLToPath(import.meta.url)) main();
