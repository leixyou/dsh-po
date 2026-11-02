import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createDiagnosticLog, defaultLogFile, MAX_LOG_BYTES } from "../lib/diagnostics.js";

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-po-diag-"));
  return path.join(dir, "dsh-po.log");
}

test("createDiagnosticLog: 追加写、带时间戳与前缀", () => {
  const file = tmpFile();
  const log = createDiagnosticLog({ file, prefix: "dsh-po" });
  log.write("hello");
  log.write("world");
  const lines = fs.readFileSync(file, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^\d{4}-\d{2}-\d{2}T[\d:.]+Z \[dsh-po\] hello$/);
  assert.match(lines[1], /world$/);
});

test("createDiagnosticLog: 写盘失败不抛错（目录不存在）", () => {
  const log = createDiagnosticLog({ file: path.join(os.tmpdir(), "dsh-po-nope-dir", "x.log") });
  assert.doesNotThrow(() => log.write("boom"));
});

test("createDiagnosticLog: 超过上限时截断重建", () => {
  const file = tmpFile();
  fs.writeFileSync(file, "x".repeat(MAX_LOG_BYTES + 10), "utf8");
  const log = createDiagnosticLog({ file });
  log.write("after truncate");
  const text = fs.readFileSync(file, "utf8");
  assert.ok(text.length < 1024, `应被截断，实际 ${text.length}`);
  assert.match(text, /after truncate/);
});

test("defaultLogFile: 跟随 DSH_HOME", () => {
  const original = process.env.DSH_HOME;
  process.env.DSH_HOME = "/tmp/dsh-home-test";
  try {
    assert.equal(defaultLogFile(), "/tmp/dsh-home-test/dsh-po.log");
  } finally {
    if (original === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = original;
  }
});
