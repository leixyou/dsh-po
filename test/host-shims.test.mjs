import test from "node:test";
import assert from "node:assert/strict";
import {
  FILE_UPLOAD_SHIM_SYMBOLS,
  installFileUploadResolverShim,
  patchFileUploadsService,
  tryGet,
} from "../lib/host-shims.js";

const { PATCHED } = FILE_UPLOAD_SHIM_SYMBOLS;

/** 官方实现的等价物：复现「disposer 用 this.agentResolver === resolve 判断」的写法。 */
function makeFileUploadsClass() {
  return class FakeFileUploads {
    agentResolver;
    registerAgentResolver(resolve) {
      if (this.agentResolver !== void 0) throw new Error("file-upload: Agent resolver is already registered");
      this.agentResolver = resolve;
      return () => {
        if (this.agentResolver === resolve) this.agentResolver = void 0;
      };
    }
  };
}

/**
 * 模拟 cordis 的 traceable service proxy：
 * - 读函数属性时返回一层新的 Proxy（身份一定不等于原函数）；
 * - 写属性落到真实实例；
 * - 没有 defineProperty 拦截，所以 defineProperty 直落实例；
 * - symbol 读取不做包装。
 */
function traceable(service) {
  const shadowProxy = (fn) => new Proxy(fn, { apply: (target, thisArg, args) => Reflect.apply(target, thisArg, args) });
  return new Proxy(service, {
    get(target, prop, receiver) {
      if (typeof prop === "symbol") return Reflect.get(target, prop, receiver);
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? shadowProxy(value) : value;
    },
    set(target, prop, value) {
      return Reflect.set(target, prop, value);
    },
  });
}

test("原始实现：traceable 包装下 disposer 永远清不掉槽位（bug 复现）", () => {
  const service = traceable(new (makeFileUploadsClass())());
  const resolve = async () => "agent";
  const dispose = service.registerAgentResolver(resolve);
  assert.notEqual(service.agentResolver, resolve); // proxy 包过，身份不再相等
  dispose();
  assert.notEqual(service.agentResolver, undefined); // 清不掉
  assert.throws(() => service.registerAgentResolver(resolve), /already registered/);
});

test("补丁后：disposer 能清空槽位，重启式重注册不再抛错", () => {
  const raw = new (makeFileUploadsClass())();
  const service = traceable(raw);
  const logs = [];
  assert.equal(patchFileUploadsService(service, (m) => logs.push(m)), true);
  assert.equal(raw[Symbol.for("dsh-po:fileUploads.patched")] ?? Object.getPrototypeOf(raw)[PATCHED], true);

  const first = async () => "agent-1";
  const disposeFirst = service.registerAgentResolver(first);
  disposeFirst();
  assert.equal(raw.agentResolver, undefined);

  const second = async () => "agent-2";
  assert.doesNotThrow(() => service.registerAgentResolver(second));
  assert.equal(raw.agentResolver, second);
  assert.deepEqual(logs.filter((line) => line.includes("reclaiming")), []);
});

test("补丁后：上一代残留的 resolver 会被回收而不是抛错", () => {
  const raw = new (makeFileUploadsClass())();
  const leaked = async () => "stale";
  raw.agentResolver = leaked; // 模拟 cordis 重启后清不掉的幽灵槽位
  const service = traceable(raw);
  patchFileUploadsService(service);

  const fresh = async () => "fresh";
  assert.doesNotThrow(() => service.registerAgentResolver(fresh));
  assert.equal(raw.agentResolver, fresh);
});

test("补丁后：旧代 disposer 不会误清新一代的注册", () => {
  const raw = new (makeFileUploadsClass())();
  const service = traceable(raw);
  patchFileUploadsService(service);

  const oldResolve = async () => "old";
  const disposeOld = service.registerAgentResolver(oldResolve);
  const newResolve = async () => "new";
  service.registerAgentResolver(newResolve); // 新一代覆盖（旧代按标准顺序应先 dispose，这里故意晚调）

  disposeOld();
  assert.equal(raw.agentResolver, newResolve);
});

test("补丁后：disposer 幂等，重复调用无副作用", () => {
  const raw = new (makeFileUploadsClass())();
  const service = traceable(raw);
  patchFileUploadsService(service);
  const resolve = async () => "agent";
  const dispose = service.registerAgentResolver(resolve);
  dispose();
  dispose();
  assert.equal(raw.agentResolver, undefined);
});

test("补丁只安装一次，非 FileUploads 服务被跳过", () => {
  const raw = new (makeFileUploadsClass())();
  const service = traceable(raw);
  const logs = [];
  patchFileUploadsService(service, (m) => logs.push(m));
  patchFileUploadsService(service, (m) => logs.push(m));
  assert.equal(logs.filter((line) => line.includes("shim installed")).length, 1);
  assert.equal(patchFileUploadsService(traceable({ upload() {} })), false);
  assert.equal(patchFileUploadsService(undefined), false);
});

test("宿主换了实现（已修好）时让位，不覆盖官方修复", () => {
  class FixedFileUploads {
    agentResolver;
    registerAgentResolver(resolve) {
      if (this.agentResolver !== void 0) throw new Error("file-upload: resolver already set");
      this.agentResolver = resolve;
      return () => {};
    }
  }
  const logs = [];
  const raw = new FixedFileUploads();
  assert.equal(patchFileUploadsService(raw, (m) => logs.push(m)), false);
  assert.match(logs.join("\n"), /shim skipped/);
  assert.equal(Object.getPrototypeOf(raw)[PATCHED], undefined);
  raw.registerAgentResolver(() => {});
  assert.throws(() => raw.registerAgentResolver(() => {}), /resolver already set/); // 原实现仍在
});

test("tryGet 兼容 ctx.get / ctx.reflect.get 的多种签名", () => {
  assert.equal(tryGet({ get: (name) => (name === "a" ? { a: 1 } : undefined) }, "a").a, 1);
  assert.equal(tryGet({ get: () => { throw new Error("nope"); }, reflect: { get: () => ({ b: 2 }) } }, "b").b, 2);
  assert.equal(tryGet({}, "x"), undefined);
});

test("服务晚到时，补丁通过轮询补装", async () => {
  let service;
  const disposers = [];
  const ctx = {
    get: () => service,
    inject() {},
    effect: (fn) => disposers.push(fn()),
  };
  installFileUploadResolverShim(ctx, { candidates: ["fileUploads"], waitMs: 500, pollMs: 50 }, () => {});
  assert.equal(service, undefined);

  const raw = new (makeFileUploadsClass())();
  service = traceable(raw);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(Object.getPrototypeOf(raw)[PATCHED], true);
  assert.equal(typeof disposers[0], "function");
});
