#!/usr/bin/env node
/**
 * 装进 DSH profile 时补两笔：
 *   1. dsh.profile.bundles 追加 "dsh-po"
 *   2. 用户层 cordis.patch.yml 写本体 insert 行
 * 在插件仓库自身跑 pnpm install 时找不到 profile 目录，整段跳过。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  NAME,
  ensureProfileBodyInsert,
  ensureProfileBundles,
  findProfileDir,
} from "./profile-insert.js";

function main() {
  const profileDir = findProfileDir();
  if (!profileDir) return;

  const bundles = ensureProfileBundles(profileDir);
  process.stdout.write(
    bundles.wrote
      ? `${NAME}: appended to bundles (${profileDir})\n`
      : `${NAME}: already in bundles (${profileDir})\n`,
  );

  try {
    const insert = ensureProfileBodyInsert(profileDir);
    process.stdout.write(
      insert.wrote
        ? `${NAME}: wrote body insert (${insert.path})\n`
        : `${NAME}: insert already in ${insert.path}\n`,
    );
  } catch (e) {
    process.stderr.write(`${NAME}: insert failed: ${(e && e.message) || e}\n`);
    process.exit(1);
  }
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invoked === fileURLToPath(import.meta.url)) main();
