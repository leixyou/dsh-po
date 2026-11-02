import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { findDshPoConfigBlock, readDshPoConfig } from "../lib/profile-config.js";

function makeProfile(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-po-profile-"));
  fs.writeFileSync(path.join(dir, "cordis.patch.yml"), text);
  return dir;
}

const DESKTOP_SHAPE = `# Your patch layer for this dsh profile
- id: ui-chat
  name: "@deepseek-ai/dsh-client-ui-chat"
  config:
    transcriptView: standard
- insert:
    - id: dsh-po
      name: dsh-po
      config:
        enabled: true
        verbose: false
        rewrite:
          translate:
            enabled: true
            key: "FAKEKEYFAKEKEYFAKEKEYFAKEKEYFAKEKEYFAKEKEYFAKEKEYFAKEKEYFAKEKEYFAKEKEYFAKEKEYFAKEKE\\
              AAbACOGKWfS"
            region: "eastasia"
- insert:
    - id: other-plugin
      name: other-plugin
      config:
        enabled: true
`;

test("readDshPoConfig: 真实 desktop 形状（双引号行尾 \\ 续行）", () => {
  const dir = makeProfile(DESKTOP_SHAPE);
  const read = readDshPoConfig(dir);
  assert.equal(read.ok, true, read.reason || "");
  assert.equal(read.config.enabled, true);
  assert.equal(read.config.verbose, false);
  assert.equal(read.config.rewrite.translate.enabled, true);
  assert.equal(read.config.rewrite.translate.region, "eastasia");
  assert.equal(
    read.config.rewrite.translate.key,
    "FAKEKEYFAKEKEYFAKEKEYFAKEKEYFAKEKEYFAKEKEYFAKEKEYFAKEKEYFAKEKEYFAKEKEYFAKEKEYFAKEKEAAbACOGKWfS",
  );
  assert.ok(!/\s/.test(read.config.rewrite.translate.key), "续行不能把换行/空格带进 key");
});

test("readDshPoConfig: 块边界正确，不吞后面的条目", () => {
  const dir = makeProfile(DESKTOP_SHAPE);
  const config = readDshPoConfig(dir).config;
  assert.equal(Object.prototype.hasOwnProperty.call(config, "other-plugin"), false);
  assert.equal(config.rewrite && Object.keys(config.rewrite).length, 1);
});

test("readDshPoConfig: 注释/空行/单引号/裸标量/数字", () => {
  const dir = makeProfile(`- insert:
    - id: dsh-po
      name: dsh-po
      config:
        # 注释行要跳过
        enabled: true          # 行尾注释
        setupTool: false
        serviceWaitMs: 5000
        prompt: 'it''s fine'
        rewrite:
          language: eu
          phrase: assume_own
          usePlaceholder: true
`);
  const read = readDshPoConfig(dir);
  assert.equal(read.ok, true, read.reason || "");
  assert.deepEqual(read.config, {
    enabled: true,
    setupTool: false,
    serviceWaitMs: 5000,
    prompt: "it's fine",
    rewrite: { language: "eu", phrase: "assume_own", usePlaceholder: true },
  });
});

test("readDshPoConfig: 带 # 的引号标量不当注释（暗语）", () => {
  const dir = makeProfile(`- insert:
    - id: dsh-po
      name: dsh-po
      config:
        rewrite:
          code: "#dshpo"
          translate:
            enabled: true
`);
  const read = readDshPoConfig(dir);
  assert.equal(read.ok, true, read.reason || "");
  assert.equal(read.config.rewrite.code, "#dshpo");
  assert.equal(read.config.rewrite.translate.enabled, true);
});

test("readDshPoConfig: 没有 dsh-po 条目时给出原因", () => {
  const dir = makeProfile("- id: ui-chat\n  config:\n    transcriptView: standard\n");
  const read = readDshPoConfig(dir);
  assert.equal(read.ok, false);
  assert.match(read.reason, /dsh-po/);
});

test("readDshPoConfig: 文件不存在不抛错", () => {
  const read = readDshPoConfig(path.join(os.tmpdir(), "dsh-po-not-a-profile"));
  assert.equal(read.ok, false);
  assert.match(read.reason, /读取失败/);
});

test("findDshPoConfigBlock: 找到 config 子块的缩进", () => {
  const lines = DESKTOP_SHAPE.split("\n");
  const block = findDshPoConfigBlock(lines);
  assert.ok(block);
  assert.equal(block.indent, 8);
  assert.equal(block.index, lines.findIndex((line) => line.trim() === "enabled: true"));
});
