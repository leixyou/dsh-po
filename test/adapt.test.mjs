import test from "node:test";
import assert from "node:assert/strict";
import { parseBundleEntries, introspect, clearIntrospectionCache } from "../lib/harness.js";
import { resolveTargets, LOGICAL_TARGETS, FALLBACK } from "../lib/targets.js";

function fakeIntro(entries, extra = {}) {
  const byId = new Map();
  const byName = new Map();
  for (const entry of entries) {
    byId.set(entry.id, entry);
    if (entry.name) byName.set(entry.name, entry);
  }
  return {
    ok: true,
    reason: "",
    root: "/fake",
    kind: "asar",
    version: "0.2.1-rc.5",
    bundles: ["dsh-base"],
    entries,
    byId,
    byName,
    services: { systemPrompt: "systemPrompt", approval: "approval" },
    approvalEvents: ["approval/request"],
    orders: { harnessIdentity: -1000, approvalPolicy: 115 },
    ...extra,
  };
}

const RC5_ENTRIES = [
  { id: "system-prompt", name: "@deepseek-ai/dsh-system-prompt", configKeys: ["personaPrefix"] },
  { id: "sandbox-policy", name: "@deepseek-ai/dsh-sandbox-policy", configKeys: ["mode"] },
  { id: "agent-instructions", name: "@deepseek-ai/dsh-agent-instructions", configKeys: ["maxBytes"] },
  { id: "session-query-sqlite", name: "@deepseek-ai/dsh-session-query-sqlite", configKeys: ["openAt"] },
  { id: "approval", name: "@deepseek-ai/dsh-user-approval", configKeys: ["policy"] },
  { id: "permission", name: "@deepseek-ai/dsh-permission-presets", configKeys: ["presets"] },
  { id: "spill-policy", name: "@deepseek-ai/dsh-spill-policy", configKeys: ["maxInlineTokens"] },
  { id: "tool-result-pruner", name: "@deepseek-ai/dsh-compaction-tool-result-pruner", configKeys: ["thresholdChars"] },
];

test("parseBundleEntries 提取 id / 包名 / config 键", () => {
  const yaml = [
    "    - id: approval",
    "      name: '@deepseek-ai/dsh-user-approval'",
    "      config:",
    "        policy: ask",
    "    - id: tool-result-pruner",
    "      name: '@deepseek-ai/dsh-compaction-tool-result-pruner'",
    "      config:",
    "        thresholdChars: 8192",
    "        headChars: 4096",
  ].join("\n");
  const entries = parseBundleEntries(yaml);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].id, "approval");
  assert.equal(entries[0].name, "@deepseek-ai/dsh-user-approval");
  assert.deepEqual(entries[0].configKeys, ["policy"]);
  assert.equal(entries[1].id, "tool-result-pruner");
  assert.deepEqual(entries[1].configKeys, ["thresholdChars", "headChars"]);
});

test("rc.5 形态：全部逻辑目标都能解析", () => {
  const plan = resolveTargets(fakeIntro(RC5_ENTRIES));
  assert.equal(plan.verified, true);
  for (const logical of Object.keys(LOGICAL_TARGETS)) {
    assert.ok(plan.found[logical], `${logical} 应被解析`);
  }
  assert.equal(plan.ids.approval, "approval");
  assert.equal(plan.ids.toolResultPruner, "tool-result-pruner");
});

test("rc.3 形态：旧包名 + 旧 id 仍然解析", () => {
  const entries = RC5_ENTRIES.map((e) => ({
    ...e,
    name: e.name
      .replace("dsh-user-approval", "dsh-approval")
      .replace("dsh-permission-presets", "dsh-permission")
      .replace("dsh-compaction-tool-result-pruner", "dsh-tool-result-pruner"),
  }));
  const plan = resolveTargets(fakeIntro(entries, { version: "0.2.1-rc.3" }));
  assert.equal(plan.ids.approval, "approval");
  assert.equal(plan.ids.permission, "permission");
  assert.equal(plan.ids.toolResultPruner, "tool-result-pruner");
});

test("id 被改名时按包名模糊匹配找回", () => {
  const entries = [
    { id: "approvals", name: "@deepseek-ai/dsh-user-approval", configKeys: [] },
    { id: "permission-presets", name: "@deepseek-ai/dsh-permission-presets", configKeys: [] },
    { id: "pruner", name: "@deepseek-ai/dsh-tool-result-pruner", configKeys: [] },
  ];
  const plan = resolveTargets(fakeIntro(entries, { version: "0.3.0" }));
  assert.equal(plan.ids.approval, "approvals");
  assert.equal(plan.ids.permission, "permission-presets");
  assert.equal(plan.ids.toolResultPruner, "pruner");
});

test("自省不可用时回退默认值且不抛错", () => {
  const plan = resolveTargets(null);
  assert.equal(plan.verified, false);
  assert.deepEqual(plan.ids, FALLBACK.ids);
  assert.ok(plan.approvalEvents.includes("approval/request"));
  assert.equal(plan.globalPromptOrder < plan.orders.harnessIdentity, true);
  assert.equal(plan.approvalContextOrder, FALLBACK.orders.approvalPolicy + 1);
});

test("order 常量跟随宿主实测值", () => {
  const plan = resolveTargets(fakeIntro(RC5_ENTRIES, {
    orders: { harnessIdentity: -2000, approvalPolicy: 200 },
  }));
  assert.equal(plan.globalPromptOrder < -2000, true);
  assert.equal(plan.approvalContextOrder, 201);
});

test("真实宿主自省（当前安装的 DSH）", { skip: false }, () => {
  clearIntrospectionCache();
  const intro = introspect({ fresh: true });
  if (!intro.ok) {
    // 非打包环境跳过，不算失败
    assert.ok(true, `skip: ${intro.reason}`);
    return;
  }
  assert.match(intro.version, /^\d+\.\d+\.\d+/);
  assert.ok(intro.entries.length > 0);
  const plan = resolveTargets(intro);
  assert.equal(plan.ids.approval, "approval");
  assert.ok(plan.approvalEvents.includes("approval/request"));
});
