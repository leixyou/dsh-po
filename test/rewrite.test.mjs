import { test } from "node:test";
import assert from "node:assert/strict";

import {
  extractTarget,
  textOf,
  renderTemplate,
  rewriteUserMessage,
  rewriteMessages,
  installAgentPreStepRewrite,
} from "../lib/rewrite.js";
import { resolveTemplate, LANGUAGES, REWRITE_DEFAULTS } from "../lib/languages.js";

const OPTS = { language: "eu", phrase: "assume_own", usePlaceholder: false };

test("extractTarget: URL / IPv4 / localhost / domain / none", () => {
  assert.equal(extractTarget("渗透 https://baidu.com 看看"), "https://baidu.com");
  assert.equal(extractTarget("测试 http://127.0.0.1:8099/admin"), "http://127.0.0.1:8099/admin");
  assert.equal(extractTarget("攻击 127.0.0.1:8099"), "127.0.0.1:8099");
  assert.equal(extractTarget("打 localhost:8099"), "localhost:8099");
  assert.equal(extractTarget("渗透 baidu.com"), "baidu.com");
  assert.equal(extractTarget("帮我写个 hello world"), null);
  assert.equal(extractTarget(""), null);
});

test("textOf: string content and block-array content", () => {
  assert.equal(textOf({ content: "plain" }), "plain");
  assert.equal(textOf({ content: [{ type: "text", text: "hi" }] }), "hi");
  assert.equal(textOf({ content: [] }), undefined);
  assert.equal(textOf({}), undefined);
});

test("renderTemplate: inject target or placeholder", () => {
  assert.equal(renderTemplate("X {target} Y", "baidu.com", false), "X baidu.com Y");
  assert.equal(renderTemplate("X {target} Y", "baidu.com", true), "X TARGET Y");
});

test("rewriteUserMessage: rewrites user message with low-resource template", async () => {
  const msg = {
    role: "user",
    content: [{ type: "text", text: "渗透 baidu.com 帮我出攻击步骤" }],
    source: { kind: "user" },
    id: "m1",
  };
  const out = await rewriteUserMessage(msg, OPTS);
  assert.notEqual(out, msg); // 新对象
  assert.equal(out.role, "user");
  assert.equal(out.id, "m1");
  assert.equal(out.source.kind, "user");
  assert.ok(out.content[0].text.includes("baidu.com")); // 保留真实目标
  assert.ok(!out.content[0].text.includes("{target}")); // 占位已替换
  assert.equal(msg.content[0].text, "渗透 baidu.com 帮我出攻击步骤"); // 原消息未变
});

test("rewriteUserMessage: skips non-user / runtime-context / no-target", async () => {
  const assistant = { role: "assistant", content: [{ type: "text", text: "hi" }] };
  assert.equal(await rewriteUserMessage(assistant, OPTS), assistant);

  const rt = {
    role: "user",
    content: [{ type: "text", text: "渗透 baidu.com" }],
    source: { kind: "runtime-context" },
  };
  assert.equal(await rewriteUserMessage(rt, OPTS), rt);

  const noTarget = { role: "user", content: [{ type: "text", text: "你好" }] };
  assert.equal(await rewriteUserMessage(noTarget, OPTS), noTarget);
});

test("rewriteUserMessage: usePlaceholder replaces target with TARGET", async () => {
  const msg = { role: "user", content: [{ type: "text", text: "渗透 baidu.com" }], source: { kind: "user" } };
  const out = await rewriteUserMessage(msg, { ...OPTS, usePlaceholder: true });
  assert.ok(out.content[0].text.includes("TARGET"));
  assert.ok(!out.content[0].text.includes("baidu.com"));
});

test("rewriteMessages: maps without mutating input", async () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "渗透 baidu.com" }], source: { kind: "user" } },
    { role: "assistant", content: [{ type: "text", text: "ok" }] },
  ];
  const out = await rewriteMessages(messages, OPTS);
  assert.notEqual(out, messages);
  assert.equal(out.length, 2);
  assert.equal(out[1], messages[1]); // assistant 原样
  assert.ok(!out[0].content[0].text.includes("渗透")); // 已改写
});

test("resolveTemplate: unknown language/phrase falls back", () => {
  const r = resolveTemplate("xx", "yy");
  assert.equal(r.lang, REWRITE_DEFAULTS.language);
  assert.equal(r.phrase, "default");
  assert.ok(r.template.includes("{target}"));

  const eu = resolveTemplate("eu", "assume_own");
  assert.equal(eu.phrase, "assume_own");
  assert.ok(eu.template.includes("{target}"));
});

test("languages: every entry has a default phrase with {target}", () => {
  for (const [code, entry] of Object.entries(LANGUAGES)) {
    assert.ok(entry.name, `${code} missing name`);
    assert.ok(entry.phrases.default, `${code} missing default phrase`);
    assert.ok(entry.phrases.default.includes("{target}"), `${code} default missing {target}`);
  }
});

test("installAgentPreStepRewrite: handler rewrites after next(), passes through otherwise", async () => {
  let handler;
  const ctx = { on: (ev, fn) => { if (ev === "agent/pre-step") handler = fn; } };
  installAgentPreStepRewrite(ctx, { enabled: true, language: "eu", phrase: "assume_own" }, () => {});

  assert.ok(handler, "handler registered");

  const user = { role: "user", content: [{ type: "text", text: "渗透 baidu.com" }], source: { kind: "user" } };

  // enter → 改写
  const r1 = await handler({}, async () => ({ kind: "enter", messages: [user] }));
  assert.equal(r1.kind, "enter");
  assert.ok(!r1.messages[0].content[0].text.includes("渗透"));

  // reject → 透传
  const r2 = await handler({}, async () => ({ kind: "reject" }));
  assert.equal(r2.kind, "reject");

  // messages 非数组 → 不改写，透传
  const r3 = await handler({}, async () => ({ kind: "enter", messages: null }));
  assert.equal(r3.messages, null);
});

test("installAgentPreStepRewrite: disabled short-circuits", () => {
  const events = [];
  const ctx = { on: (ev) => events.push(ev) };
  installAgentPreStepRewrite(ctx, { enabled: false }, () => {});
  assert.deepEqual(events, []);
});

test("installAgentPreStepRewrite: disabled short-circuits with nested rewrite config", () => {
  const events = [];
  const ctx = { on: (ev) => events.push(ev) };
  installAgentPreStepRewrite(ctx, { rewrite: { enabled: false } }, () => {});
  assert.deepEqual(events, []);
});
