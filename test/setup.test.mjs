import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureProfileTranslateConfig, INSERT_BLOCK } from "../scripts/profile-insert.js";

function tmpProfile(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-po-setup-"));
  for (const [rel, content] of Object.entries(files)) {
    const fp = path.join(dir, rel);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, content, "utf8");
  }
  return dir;
}

test("ensureProfileTranslateConfig: 无 rewrite 时插入完整嵌套", () => {
  const dir = tmpProfile({ "cordis.patch.yml": INSERT_BLOCK });
  const r = ensureProfileTranslateConfig(dir, { enabled: true, key: "KEY123", region: "global" });
  assert.equal(r.updated, true);
  const out = fs.readFileSync(path.join(dir, "cordis.patch.yml"), "utf8");
  assert.ok(out.includes("rewrite:"), out);
  assert.ok(out.includes("translate:"), out);
  assert.ok(out.includes("enabled: true"), out);
  assert.ok(out.includes('key: "KEY123"'), out);
  assert.ok(out.includes('region: "global"'), out);
  // 幂等：再跑一次不重复
  const r2 = ensureProfileTranslateConfig(dir, { enabled: true, key: "KEY123", region: "global" });
  assert.equal(r2.updated, true);
  const out2 = fs.readFileSync(path.join(dir, "cordis.patch.yml"), "utf8");
  assert.equal((out2.match(/translate:/g) || []).length, 1);
  assert.equal((out2.match(/key:/g) || []).length, 1);
});

test("ensureProfileTranslateConfig: 更新已有 key，不删其它 rewrite 键", () => {
  const dir = tmpProfile({
    "cordis.patch.yml": [
      "- insert:",
      "    - id: dsh-po",
      "      name: dsh-po",
      "      config:",
      "        enabled: true",
      "        rewrite:",
      "          language: ku",
      "          phrase: stepwise",
      "          translate:",
      "            enabled: false",
      "            key: \"OLD\"",
      "",
    ].join("\n"),
  });
  const r = ensureProfileTranslateConfig(dir, { enabled: true, key: "NEW", region: "eastus" });
  assert.equal(r.updated, true);
  const out = fs.readFileSync(path.join(dir, "cordis.patch.yml"), "utf8");
  assert.ok(out.includes("language: ku"), out);
  assert.ok(out.includes("phrase: stepwise"), out);
  assert.ok(out.includes("enabled: true"), out);
  assert.ok(out.includes('key: "NEW"'), out);
  assert.ok(out.includes('region: "eastus"'), out);
  assert.ok(!out.includes("OLD"), out);
});

test("ensureProfileTranslateConfig: 无 dsh-po insert → ok=false", () => {
  const dir = tmpProfile({ "cordis.patch.yml": "- id: ui-chat\n  name: x\n  config: {}\n" });
  const r = ensureProfileTranslateConfig(dir, { enabled: true, key: "K", region: "global" });
  assert.equal(r.ok, false);
  assert.match(r.reason, /insert/);
});

/* ── 暗语写入：rewrite.code ── */

const { ensureProfileRewriteCode } = await import("../scripts/profile-insert.js");
const { readDshPoConfig } = await import("../lib/profile-config.js");

test("ensureProfileRewriteCode: 无 rewrite 时插入嵌套，并且能被解析回来", () => {
  const dir = tmpProfile({ "cordis.patch.yml": INSERT_BLOCK });
  const r = ensureProfileRewriteCode(dir, "#dshpo");
  assert.equal(r.ok, true);
  assert.equal(r.updated, true);

  const read = readDshPoConfig(dir);
  assert.equal(read.ok, true, read.reason || "");
  assert.equal(read.config.rewrite.code, "#dshpo");

  // 幂等
  const again = ensureProfileRewriteCode(dir, "#dshpo");
  assert.equal(again.updated, false);
  const text = fs.readFileSync(path.join(dir, "cordis.patch.yml"), "utf8");
  assert.equal((text.match(/code:/g) || []).length, 1);
});

test("ensureProfileRewriteCode: 已有 translate 配置不受影响", () => {
  const dir = tmpProfile({ "cordis.patch.yml": INSERT_BLOCK });
  ensureProfileTranslateConfig(dir, { enabled: true, key: "KEY123", region: "eastasia" });
  ensureProfileRewriteCode(dir, "#dshpo");

  const read = readDshPoConfig(dir);
  assert.equal(read.config.rewrite.code, "#dshpo");
  assert.equal(read.config.rewrite.translate.key, "KEY123");
  assert.equal(read.config.rewrite.translate.region, "eastasia");
  assert.equal(read.config.rewrite.translate.enabled, true);
});

test("ensureProfileRewriteCode: 换暗语只改值", () => {
  const dir = tmpProfile({ "cordis.patch.yml": INSERT_BLOCK });
  ensureProfileRewriteCode(dir, "#dshpo");
  const r = ensureProfileRewriteCode(dir, "##go");
  assert.equal(r.updated, true);
  assert.equal(readDshPoConfig(dir).config.rewrite.code, "##go");
  assert.equal((fs.readFileSync(path.join(dir, "cordis.patch.yml"), "utf8").match(/code:/g) || []).length, 1);
});

test("ensureProfileRewriteCode: 没有 dsh-po insert 时不动文件", () => {
  const dir = tmpProfile({ "cordis.patch.yml": "- id: ui-chat\n  config:\n    transcriptView: standard\n" });
  const before = fs.readFileSync(path.join(dir, "cordis.patch.yml"), "utf8");
  const r = ensureProfileRewriteCode(dir, "#dshpo");
  assert.equal(r.ok, false);
  assert.match(r.reason, /dsh-po/);
  assert.equal(fs.readFileSync(path.join(dir, "cordis.patch.yml"), "utf8"), before);
});
