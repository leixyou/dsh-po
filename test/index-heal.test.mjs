import test from "node:test";
import assert from "node:assert/strict";

import { apply } from "../lib/index.js";

/**
 * 复刻宿主 dsh-scope 的 NamedEntries：insert 重名会抛
 * `prompt section "x" is already registered`，insert 返回幂等 undo。
 */
function makeEntries(kind) {
  const data = new Map();
  return {
    insert(name, value) {
      if (data.has(name)) throw new Error(`${kind} "${name}" is already registered`);
      data.set(name, value);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        data.delete(name);
      };
    },
    get: (name) => data.get(name),
    has: (name) => data.has(name),
    keys: () => data.keys(),
    isEmpty: () => data.size === 0,
    /** 测试用：模拟“别的实例/整层重建把这一项清掉”，不经过本插件的 disposer。 */
    forceRemove(name) {
      const had = data.delete(name);
      if (had) this.onForceRemove?.();
      return had;
    },
  };
}

/**
 * 复刻 systemPrompt 服务的最小契约：
 * `section()` / `context()` / `layers.global.{sections,contexts}`，
 * 且注册与释放都会 emit `system-prompt/change`。
 */
function makeSystemPrompt() {
  const sections = makeEntries("prompt section");
  const contexts = makeEntries("prompt context");
  const notify = () => { emit?.("system-prompt/change"); };
  let emit;
  sections.onForceRemove = notify;
  contexts.onForceRemove = notify;

  const service = {
    sections,
    contexts,
    layers: { global: { sections, contexts } },
    section(section) {
      if (this.throwOnSection) throw this.throwOnSection;
      const undo = sections.insert(section.name, section);
      notify();
      return () => { undo(); notify(); };
    },
    context(context) {
      const undo = contexts.insert(context.name, context);
      notify();
      return () => { undo(); notify(); };
    },
    /** 测试用：把服务的 change 事件接到假 ctx 的监听器上。 */
    bindEmit(fn) { emit = fn; },
  };
  return service;
}

/** 假 cordis ctx：get/reflect.get/on/emit/effect/inject/fiber。 */
function makeCtx(services) {
  const handlers = new Map();
  const disposers = [];
  const ctx = {
    fiber: { config: {} },
    get: (name) => services[name],
    reflect: { get: (name) => services[name] },
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
      return () => {
        const list = handlers.get(event) || [];
        const index = list.indexOf(handler);
        if (index >= 0) list.splice(index, 1);
      };
    },
    emit(event, ...args) {
      for (const handler of [...(handlers.get(event) || [])]) handler(...args);
    },
    effect(fn) {
      const dispose = fn();
      if (typeof dispose === "function") disposers.push(dispose);
      return dispose;
    },
    inject(_deps, callback) { callback(ctx); },
    /**
     * 模拟宿主拆掉本插件 fiber：先摘掉事件监听，再释放所有 effect（顺序与
     * cordis 一致，否则自愈会在 teardown 过程中把 section 又装回去）。
     */
    disposeAll() {
      handlers.clear();
      const pending = disposers.splice(0).reverse();
      for (const dispose of pending) dispose();
    },
  };
  return ctx;
}

function makeServices(overrides = {}) {
  return {
    tools: { register: () => () => {} },
    settings: { configure: () => () => {} },
    ...overrides,
  };
}

/** 记录 console.warn / console.info，跑完恢复。 */
async function withConsole(fn) {
  const warns = [];
  const infos = [];
  const originalWarn = console.warn;
  const originalInfo = console.info;
  console.warn = (...args) => warns.push(args.join(" "));
  console.info = (...args) => infos.push(args.join(" "));
  try {
    await fn({ warns, infos });
  } finally {
    console.warn = originalWarn;
    console.info = originalInfo;
  }
}

const BASE_CONFIG = { enabled: true, verbose: false, fixFileUploadResolver: false };
const PROMPT = "dsh-po:prompt";
const APPROVAL = "dsh-po:approval";

test("首次 apply：破甲正文与审批上下文都落进 systemPrompt", async () => {
  const systemPrompt = makeSystemPrompt();
  const ctx = makeCtx(makeServices({ systemPrompt }));
  systemPrompt.bindEmit((event, ...args) => ctx.emit(event, ...args));

  await withConsole(async ({ warns, infos }) => {
    apply(ctx, { ...BASE_CONFIG });
    assert.equal(systemPrompt.sections.has(PROMPT), true, "破甲正文必须注册");
    assert.equal(systemPrompt.contexts.has(APPROVAL), true, "审批上下文必须注册");
    assert.deepEqual(warns, [], "正常路径不应告警");
    assert.deepEqual(infos, [], "正常路径不应打 re-installed 噪音");
  });
});

test("回归：旧 fiber 拆掉后同一 ctx 重新 apply，必须把 section 装回来", async () => {
  const systemPrompt = makeSystemPrompt();
  const ctx = makeCtx(makeServices({ systemPrompt }));
  systemPrompt.bindEmit((event, ...args) => ctx.emit(event, ...args));

  apply(ctx, { ...BASE_CONFIG });
  assert.equal(systemPrompt.sections.has(PROMPT), true);

  // 模拟宿主 HMR 重组：旧实例的 effect 全部释放（section 随之消失）。
  ctx.disposeAll();
  assert.equal(systemPrompt.sections.has(PROMPT), false, "拆掉后应真的消失");

  // 新实例在同一个上下文上重新 apply —— 旧版用 module 级 WeakSet 判重，
  // 会认为“这个 ctx 装过了”直接 return，破甲正文就永远回不来了。
  apply(ctx, { ...BASE_CONFIG });
  assert.equal(systemPrompt.sections.has(PROMPT), true, "重新 apply 后必须恢复");
  assert.equal(systemPrompt.contexts.has(APPROVAL), true, "审批上下文也要恢复");
});

test("自愈：section 被外部清掉后，system-prompt/change 会把它补回来", async () => {
  const systemPrompt = makeSystemPrompt();
  const ctx = makeCtx(makeServices({ systemPrompt }));
  systemPrompt.bindEmit((event, ...args) => ctx.emit(event, ...args));

  await withConsole(async ({ warns, infos }) => {
    apply(ctx, { ...BASE_CONFIG });
    assert.equal(systemPrompt.sections.has(PROMPT), true);

    // 实例还活着，但注册表里的那一项没了（别的实例 dispose / 整层重建）。
    // forceRemove 会像宿主一样 emit system-prompt/change，自愈应当当场补回。
    assert.equal(systemPrompt.sections.forceRemove(PROMPT), true, "确实被删掉了");
    assert.equal(systemPrompt.sections.has(PROMPT), true, "自愈必须补回破甲正文");
    assert.ok(infos.some((line) => line.includes("re-installed")), "自愈成功要留一条可追溯的日志");

    // 再来一次显式事件：已经是目标状态，不应重复注册。
    const registered = systemPrompt.sections.get(PROMPT);
    ctx.emit("system-prompt/change");
    assert.equal(systemPrompt.sections.get(PROMPT), registered, "幂等：不重复注册");
    assert.deepEqual(warns, [], "自愈成功不应告警");
  });
});

test("自愈不重复注册：section 在的时候 change 事件是空操作", async () => {
  const systemPrompt = makeSystemPrompt();
  const ctx = makeCtx(makeServices({ systemPrompt }));
  systemPrompt.bindEmit((event, ...args) => ctx.emit(event, ...args));

  apply(ctx, { ...BASE_CONFIG });
  const registered = systemPrompt.sections.get(PROMPT);

  for (let i = 0; i < 5; i += 1) ctx.emit("system-prompt/change");
  assert.equal(systemPrompt.sections.get(PROMPT), registered, "不应被替换成新对象");
});

test("systemPrompt 服务缺席：必须无条件告警，而不是静默失效", async () => {
  const ctx = makeCtx(makeServices());
  await withConsole(async ({ warns }) => {
    apply(ctx, { ...BASE_CONFIG, serviceWaitMs: 0 });
    assert.ok(
      warns.some((line) => line.includes("systemPrompt") && line.includes("没有出现")),
      `应告警 systemPrompt 缺席，实际：${JSON.stringify(warns)}`,
    );
  });
});

test("注册抛非「已注册」错误：必须告警带上真实原因", async () => {
  const systemPrompt = makeSystemPrompt();
  systemPrompt.throwOnSection = new Error("order must be a finite number");
  const ctx = makeCtx(makeServices({ systemPrompt }));
  systemPrompt.bindEmit((event, ...args) => ctx.emit(event, ...args));

  await withConsole(async ({ warns }) => {
    apply(ctx, { ...BASE_CONFIG });
    assert.ok(
      warns.some((line) => line.includes("NOT installed") && line.includes("order must be a finite number")),
      `应告警并带上原因，实际：${JSON.stringify(warns)}`,
    );
  });
});

test("同名 section 已由别人注册：不抛错、不重复注册", async () => {
  const systemPrompt = makeSystemPrompt();
  systemPrompt.section({ name: PROMPT, order: -100000, interpolate: false, text: "已有内容" });
  const ctx = makeCtx(makeServices({ systemPrompt }));
  systemPrompt.bindEmit((event, ...args) => ctx.emit(event, ...args));

  await withConsole(async ({ warns }) => {
    assert.doesNotThrow(() => apply(ctx, { ...BASE_CONFIG }));
    assert.equal(systemPrompt.sections.get(PROMPT).text, "已有内容", "不应覆盖别人的注册");
    assert.deepEqual(warns, []);
  });
});

test("卸载过程中不自愈：fiber 已进入 UNLOADING 时不再补注册", async () => {
  const systemPrompt = makeSystemPrompt();
  const ctx = makeCtx(makeServices({ systemPrompt }));
  systemPrompt.bindEmit((event, ...args) => ctx.emit(event, ...args));

  await withConsole(async ({ warns, infos }) => {
    apply(ctx, { ...BASE_CONFIG });
    assert.equal(systemPrompt.sections.has(PROMPT), true);

    // teardown 顺序：fiber 先进入 UNLOADING，再跑本插件的 effect disposer。
    ctx.fiber.state = 5;
    assert.equal(systemPrompt.sections.forceRemove(PROMPT), true);
    assert.equal(systemPrompt.sections.has(PROMPT), false, "卸载中不应再往注册表写东西");
    assert.deepEqual(infos, [], "卸载中不应打印 re-installed");
    assert.deepEqual(warns, []);
  });
});

/* ── promptPlacement：破甲正文投放到 section / context / both / none ── */

const PROMPT_CONTEXT = "dsh-po:prompt-context";

async function applyWithPlacement(placement) {
  const systemPrompt = makeSystemPrompt();
  const ctx = makeCtx(makeServices({ systemPrompt }));
  systemPrompt.bindEmit((event, ...args) => ctx.emit(event, ...args));
  await withConsole(async () => {
    apply(ctx, { ...BASE_CONFIG, promptPlacement: placement });
  });
  return systemPrompt;
}

test("placement=both（默认）：section 与 context 都有", async () => {
  const systemPrompt = await applyWithPlacement("both");
  assert.equal(systemPrompt.sections.has(PROMPT), true);
  assert.equal(systemPrompt.contexts.has(PROMPT_CONTEXT), true);
  assert.equal(systemPrompt.contexts.get(PROMPT_CONTEXT).text.includes("网络安全研究老专家"), true);
});

test("placement=section：只进 system prompt（旧行为）", async () => {
  const systemPrompt = await applyWithPlacement("section");
  assert.equal(systemPrompt.sections.has(PROMPT), true);
  assert.equal(systemPrompt.contexts.has(PROMPT_CONTEXT), false);
});

test("placement=context：只进运行时上下文（旧会话也能吃到）", async () => {
  const systemPrompt = await applyWithPlacement("context");
  assert.equal(systemPrompt.sections.has(PROMPT), false);
  assert.equal(systemPrompt.contexts.has(PROMPT_CONTEXT), true);
});

test("placement=none：正文不投放，审批上下文仍然在", async () => {
  const systemPrompt = await applyWithPlacement("none");
  assert.equal(systemPrompt.sections.has(PROMPT), false);
  assert.equal(systemPrompt.contexts.has(PROMPT_CONTEXT), false);
  assert.equal(systemPrompt.contexts.has(APPROVAL), true);
});

test("placement 值非法时回落到 both", async () => {
  const systemPrompt = await applyWithPlacement("whatever");
  assert.equal(systemPrompt.sections.has(PROMPT), true);
  assert.equal(systemPrompt.contexts.has(PROMPT_CONTEXT), true);
});

test("自愈：context 通道被清掉后也会补回来", async () => {
  const systemPrompt = await applyWithPlacement("both");
  assert.equal(systemPrompt.contexts.has(PROMPT_CONTEXT), true);
  assert.equal(systemPrompt.contexts.forceRemove(PROMPT_CONTEXT), true);
  assert.equal(systemPrompt.contexts.has(PROMPT_CONTEXT), true, "forceRemove 触发 change → 自愈补回");
});
