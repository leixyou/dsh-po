import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  SETUP_TOOL_NAME,
  installSetupTool,
  maskKey,
  parseSetupAnswers,
  setupQuestions,
  setupToolDefinition,
} from "../lib/setup-tool.js";

const PROFILE_PATCH = `# profile patch
- insert:
    - id: dsh-po
      name: dsh-po
      config:
        enabled: true
        verbose: false
`;

function makeProfile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-po-setup-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "dsh-profile-test" }));
  fs.writeFileSync(path.join(dir, "cordis.patch.yml"), PROFILE_PATCH);
  return dir;
}

function fakeCtx({ dir, userQuestions, hmr } = {}) {
  const services = new Map();
  if (dir !== undefined) services.set("profileContext", { dir });
  if (userQuestions !== undefined) services.set("userQuestions", userQuestions);
  if (hmr !== undefined) services.set("hmr", hmr);
  return {
    get: (name) => services.get(name),
    inject(names, callback) {
      const child = {
        get: (name) => services.get(name),
        effect: (fn) => fn(),
        tools: { register: () => () => {} },
      };
      callback(child);
    },
  };
}

test("maskKey 只保留尾部 4 位", () => {
  assert.equal(maskKey(""), "");
  assert.equal(maskKey("abcd"), "****");
  assert.equal(maskKey("abcdefghij"), "******ghij");
});

test("parseSetupAnswers：参数优先、其次问答、region 缺省 global", () => {
  const answers = [
    { id: "key", selected: [], custom: "  from-dialog  " },
    { id: "region", selected: [], custom: "" },
  ];
  assert.deepEqual(parseSetupAnswers(answers, {}), { key: "from-dialog", region: "global" });
  assert.deepEqual(parseSetupAnswers(answers, { key: "arg-key", region: "eastasia" }), {
    key: "arg-key",
    region: "eastasia",
  });
  assert.deepEqual(parseSetupAnswers([], {}), { key: "", region: "global" });
  // Azure 只认短代码：显示名要归一
  assert.equal(parseSetupAnswers([{ id: "region", custom: "East Asia" }], {}).region, "eastasia");
  assert.equal(parseSetupAnswers([], { region: "West Europe" }).region, "westeurope");
});

test("setupQuestions 是自由输入（无 options）且 id 稳定", () => {
  const questions = setupQuestions();
  assert.deepEqual(questions.map((q) => q.id), ["key", "region"]);
  for (const question of questions) {
    assert.equal(question.options, undefined);
    assert.ok(question.question.length > 0);
  }
});

test("工具定义符合注册表要求：名称 / 参数 / 输出 / render", () => {
  const definition = setupToolDefinition({ ctx: fakeCtx(), log: () => {} });
  assert.equal(definition.name, SETUP_TOOL_NAME);
  assert.equal(definition.parameters.type, "object");
  assert.deepEqual(Object.keys(definition.parameters.properties).sort(), ["key", "region"]);
  assert.equal(definition.parameters.additionalProperties, false);
  assert.deepEqual(definition.output.schema.required, ["saved", "region", "maskedKey", "live"]);
  const content = definition.output.render({}, {
    saved: true,
    region: "global",
    maskedKey: "****abcd",
    path: "/tmp/x/cordis.patch.yml",
    live: true,
  });
  assert.equal(content[0].type, "text");
  assert.match(content[0].text, /rewrite\.translate/);
});

test("execute：问答输入 key/region 后写入 profile 的 rewrite.translate", async () => {
  const dir = makeProfile();
  const asked = [];
  const userQuestions = {
    async ask(request) {
      asked.push(request);
      return {
        answers: [
          { id: "key", selected: [], custom: "SECRET-KEY-1234" },
          { id: "region", selected: [], custom: "eastasia" },
        ],
      };
    },
  };
  const ctx = fakeCtx({ dir, userQuestions, hmr: {} });
  const definition = setupToolDefinition({ ctx, log: () => {} });

  const value = await definition.execute({}, { agent: { id: "a" }, signal: undefined });
  assert.equal(value.saved, true);
  assert.equal(value.region, "eastasia");
  assert.equal(value.maskedKey, "********1234");
  assert.equal(value.live, true);

  const text = fs.readFileSync(path.join(dir, "cordis.patch.yml"), "utf8");
  assert.match(text, /rewrite:/);
  assert.match(text, /translate:/);
  assert.match(text, /enabled: true/);
  assert.match(text, /key: "SECRET-KEY-1234"/);
  assert.match(text, /region: "eastasia"/);
  // 问答请求必须带 agent（userQuestions 用它做 live-root 校验）
  assert.deepEqual(asked[0].agent, { id: "a" });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("execute：空 key 视为取消，不写文件", async () => {
  const dir = makeProfile();
  const userQuestions = {
    ask: async () => ({ answers: [{ id: "key", selected: [], custom: "  " }] }),
  };
  const ctx = fakeCtx({ dir, userQuestions });
  const definition = setupToolDefinition({ ctx, log: () => {} });

  const value = await definition.execute({}, {});
  assert.equal(value.saved, false);
  assert.equal(fs.readFileSync(path.join(dir, "cordis.patch.yml"), "utf8"), PROFILE_PATCH);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("execute：没有 userQuestions 时给出可执行的替代方案", async () => {
  const dir = makeProfile();
  const definition = setupToolDefinition({ ctx: fakeCtx({ dir }), log: () => {} });
  await assert.rejects(() => definition.execute({}, {}), /userQuestions|dsh-po setup/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("installSetupTool：工具服务就绪后注册，失败只记日志", () => {
  const logs = [];
  const ctx = fakeCtx({});
  assert.equal(installSetupTool(ctx, {}, (m) => logs.push(m)), true);
  assert.match(logs.join("\n"), /setup tool registered/);

  assert.equal(installSetupTool(ctx, { setupTool: false }, (m) => logs.push(m)), false);
  assert.match(logs.join("\n"), /disabled by config/);

  const failing = {
    inject: (_names, callback) => callback({ tools: { register: () => { throw new Error("boom"); } }, effect: () => {} }),
  };
  assert.equal(installSetupTool(failing, {}, (m) => logs.push(m)), true);
  assert.match(logs.join("\n"), /registration failed: boom/);
});
