import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  removeProfileBodyInsert,
  removeProfileBundles,
  removeStaleLinks,
} from "../scripts/profile-insert.js";

function tmpProfile(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-po-uninstall-"));
  for (const [rel, content] of Object.entries(files)) {
    const fp = path.join(dir, rel);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, content, "utf8");
  }
  return dir;
}

test("removeProfileBodyInsert: 独立 insert 块整体删除", () => {
  const dir = tmpProfile({
    "cordis.patch.yml": [
      "- id: ui-chat",
      "  name: x",
      "  config: {}",
      "",
      "- insert:",
      "    - id: dsh-po",
      "      name: dsh-po",
      "      config:",
      "        enabled: true",
      "        verbose: false",
      "",
    ].join("\n"),
  });
  const r = removeProfileBodyInsert(dir);
  assert.equal(r.removed, true);
  const out = fs.readFileSync(path.join(dir, "cordis.patch.yml"), "utf8");
  assert.ok(!out.includes("dsh-po"), out);
  assert.ok(out.includes("- id: ui-chat"), out);
});

test("removeProfileBodyInsert: 多条目 insert 只删 dsh-po 一条", () => {
  const dir = tmpProfile({
    "cordis.patch.yml": [
      "- insert:",
      "    - id: jts-terminal-mcp",
      "      name: cordis:include",
      "      config:",
      "        path: /tmp/x.json",
      "    - id: dsh-po",
      "      name: dsh-po",
      "      config:",
      "        enabled: true",
      "",
    ].join("\n"),
  });
  const r = removeProfileBodyInsert(dir);
  assert.equal(r.removed, true);
  const out = fs.readFileSync(path.join(dir, "cordis.patch.yml"), "utf8");
  assert.ok(out.includes("jts-terminal-mcp"), out);
  assert.ok(!out.includes("dsh-po"), out);
  assert.ok(out.includes("- insert:"), out);
});

test("removeProfileBodyInsert: 无 dsh-po 时不改动", () => {
  const text = "- id: ui-chat\n  name: x\n  config: {}\n";
  const dir = tmpProfile({ "cordis.patch.yml": text });
  const r = removeProfileBodyInsert(dir);
  assert.equal(r.removed, false);
  assert.equal(fs.readFileSync(path.join(dir, "cordis.patch.yml"), "utf8"), text);
});

test("removeProfileBundles: 移除 bundles 里的 dsh-po", () => {
  const dir = tmpProfile({
    "package.json": JSON.stringify({
      name: "dsh-profile-test",
      dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "dsh-po"] } },
    }, null, 2),
  });
  const r = removeProfileBundles(dir);
  assert.equal(r.removed, true);
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  assert.deepEqual(pkg.dsh.profile.bundles, ["@deepseek-ai/dsh-base"]);
});

test("removeProfileBundles: 不在 bundles 时不改动", () => {
  const dir = tmpProfile({
    "package.json": JSON.stringify({
      name: "dsh-profile-test",
      dsh: { profile: { bundles: ["@deepseek-ai/dsh-base"] } },
    }, null, 2),
  });
  const r = removeProfileBundles(dir);
  assert.equal(r.removed, false);
});

test("removeStaleLinks: 删除符号链接与 .bin shim", () => {
  const dir = tmpProfile({});
  const nodeModules = path.join(dir, "node_modules");
  fs.mkdirSync(path.join(nodeModules, ".bin"), { recursive: true });
  fs.symlinkSync("/fake/dsh-po", path.join(nodeModules, "dsh-po"));
  fs.writeFileSync(path.join(nodeModules, ".bin", "dsh-po"), "shim", "utf8");
  fs.writeFileSync(path.join(nodeModules, ".bin", "dsh-purge-nopatch"), "old", "utf8");

  const removed = removeStaleLinks(dir);
  assert.equal(removed, 3);
  assert.ok(!fs.existsSync(path.join(nodeModules, "dsh-po")));
  assert.ok(!fs.existsSync(path.join(nodeModules, ".bin", "dsh-po")));
  assert.ok(!fs.existsSync(path.join(nodeModules, ".bin", "dsh-purge-nopatch")));
});

test("removeStaleLinks: 真实目录不删除", () => {
  const dir = tmpProfile({});
  const nodeModules = path.join(dir, "node_modules");
  fs.mkdirSync(path.join(nodeModules, "dsh-po"), { recursive: true });
  fs.writeFileSync(path.join(nodeModules, "dsh-po", "index.js"), "x", "utf8");

  const removed = removeStaleLinks(dir);
  assert.equal(removed, 0);
  assert.ok(fs.existsSync(path.join(nodeModules, "dsh-po", "index.js")));
});
