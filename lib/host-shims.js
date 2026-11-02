/**
 * 宿主兼容层（纯运行时、内存内 monkey patch，不改写任何 @deepseek-ai 源文件）。
 *
 * ── 要修的是什么 ───────────────────────────────────────────────────────────
 * `@deepseek-ai/dsh-api-session-controller` 在 apply 时执行：
 *
 *   ctx.effect(() => ctx.fileUploads.registerAgentResolver(async (sessionId) => { ... }))
 *
 * 而 `@deepseek-ai/dsh-client-file-upload` 的实现是：
 *
 *   registerAgentResolver(resolve) {
 *     if (this.agentResolver !== void 0) throw new Error("file-upload: Agent resolver is already registered");
 *     this.agentResolver = resolve;
 *     return () => { if (this.agentResolver === resolve) this.agentResolver = void 0; };
 *   }
 *
 * 问题出在 cordis 的 traceable proxy：`ctx.fileUploads` 不是裸实例，读它的
 * 函数属性时，`createTraceable` 每次都会用 `createShadowMethod` 包一层新的
 * Proxy 返回。于是：
 *
 *   - 写：`this.agentResolver = resolve` 直落真实实例（写入正常）；
 *   - 读：`this.agentResolver` 返回的是一层新的 Proxy，永远 !== 原始 resolve。
 *
 * 结果就是 disposer 里的恒等式判断必然为 false，槽位永远清不掉。只要
 * session-controller 因为任何原因重启一次（例如插件停用导致它依赖的
 * `session-query-sqlite` 配置变化、进而级联重启），旧 resolver 就成了幽灵，
 * 新一次注册直接抛错，session-controller 进 failed 状态，会话 API 整个失效。
 *
 * 用户看到的「停用失败：dsh: warning: 1 entry did not activate
 * session-controller ...: Error: file-upload: Agent resolver is already
 * registered」就是这条链路。
 *
 * ── 本补丁怎么做 ───────────────────────────────────────────────────────────
 * 把 `FileUploads.prototype.registerAgentResolver` 换成等价实现：
 *
 *   1. 槽位额外存一份在 symbol 属性上 —— symbol 读取会绕过 traceable 包装，
 *      因此可以用 `===` 做可靠的身份比较；
 *   2. 写入/清理都用 `Object.defineProperty` 直落真实实例（defineProperty 没有
 *      被 proxy 拦截，不会被导到每次新建的 shadow 上）；
 *   3. disposer 幂等；发现槽位仍被上一次注册占用时，优先回收（reclaim）而不是
 *      抛错 —— cordis 的卸载顺序保证旧 fiber 已经 dispose，留下的只是幽灵。
 *
 * 补丁只替换一个原型方法，可逆、无磁盘写入，实例和未来重建的实例都覆盖。
 */

/** symbol 键：绕过 cordis traceable proxy 的函数包装，做可靠身份比较。 */
const SLOT = Symbol.for("dsh-po:fileUploads.agentResolver");
/** symbol 键：标记原型已经打过补丁，避免重复替换 / 多次 ctx 里重复安装。 */
const PATCHED = Symbol.for("dsh-po:fileUploads.patched");

/**
 * 按候选名取服务，兼容 `ctx.get` / `ctx.reflect.get` 的多种签名。
 * 取不到时返回 undefined，不抛错。
 *
 * @param {import("@deepseek-ai/cordis").Context} ctx 插件上下文
 * @param {string} name 服务名
 * @returns {unknown} 命中的服务实例，或 undefined
 */
export function tryGet(ctx, name) {
  if (!name) return undefined;
  const probes = [
    () => ctx.get?.(name),
    () => ctx.get?.(name, false),
    () => ctx.reflect?.get?.(name, false),
  ];
  for (const probe of probes) {
    try {
      const value = probe();
      if (value) return value;
    } catch { /* 下一个探针 */ }
  }
  return undefined;
}

/** 把真实值写到实例自身，绕开 traceable proxy 的 set 语义。 */
function defineInstanceValue(target, key, value) {
  Object.defineProperty(target, key, {
    value,
    configurable: true,
    writable: true,
    enumerable: false,
  });
}

/**
 * 在一个 FileUploads 实例的原型上安装幂等 resolver 补丁。
 *
 * @param {object} service fileUploads 服务实例（可以是 traceable proxy）
 * @param {(message: string) => void} [log] 诊断输出
 * @returns {boolean} 是否已就绪（已打过补丁或本次成功安装）
 */
export function patchFileUploadsService(service, log = () => {}) {
  let proto;
  try {
    proto = Object.getPrototypeOf(service);
  } catch {
    return false;
  }
  if (!proto || typeof proto.registerAgentResolver !== "function") return false;
  if (proto[PATCHED]) return true;

  // 只替换确认有该缺陷的实现：宿主将来修好（换实现）时自动让位，不覆盖官方修复。
  let source = "";
  try {
    source = Function.prototype.toString.call(proto.registerAgentResolver);
  } catch { /* 取不到源码就按未知处理 */ }
  const knownBuggy = source.includes("Agent resolver is already registered")
    && source.includes("this.agentResolver === resolve");
  if (!knownBuggy) {
    log("file-upload Agent resolver implementation is not the known buggy one; shim skipped");
    return false;
  }

  const patched = function registerAgentResolver(resolve) {
    if (typeof resolve !== "function") {
      throw new TypeError("dsh-po: file-upload Agent resolver must be a function");
    }
    // symbol 读取不受 traceable 包装影响，能拿到上一次注册的真实函数对象。
    const previous = this[SLOT];
    log("file-upload resolver registration via shim (occupied=" + (previous !== undefined) + ")");
    if (previous !== undefined && previous !== resolve) {
      log("file-upload resolver slot still held by a disposed registration; reclaiming it");
    }
    defineInstanceValue(this, SLOT, resolve);
    defineInstanceValue(this, "agentResolver", resolve);

    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      // 已有更新的注册接管槽位时，绝不误清。
      if (this[SLOT] !== resolve) return;
      defineInstanceValue(this, SLOT, undefined);
      defineInstanceValue(this, "agentResolver", undefined);
    };
  };

  Object.defineProperty(proto, "registerAgentResolver", {
    value: patched,
    configurable: true,
    writable: true,
    enumerable: false,
  });
  Object.defineProperty(proto, PATCHED, {
    value: true,
    configurable: true,
    writable: false,
    enumerable: false,
  });
  log("file-upload Agent resolver shim installed (idempotent disposer)");
  return true;
}

/**
 * 等 fileUploads 服务出现后安装补丁：先直取，再动态 inject，最后限时轮询。
 * 安装成功后自动停止轮询；任何失败都只记日志，不影响插件其余能力。
 *
 * @param {import("@deepseek-ai/cordis").Context} ctx 插件上下文
 * @param {{
 *   candidates?: string[],
 *   waitMs?: number,
 *   pollMs?: number,
 * }} [options] 候选服务名与等待预算
 * @param {(message: string) => void} [log] 诊断输出
 * @returns {() => void} 取消等待的 disposer
 */
export function installFileUploadResolverShim(ctx, options = {}, log = () => {}) {
  const candidates = [...new Set((options.candidates || []).filter(Boolean))];
  if (!candidates.length) return () => {};

  const waitMs = Math.max(0, Number(options.waitMs) || 0);
  const pollMs = Math.max(50, Number(options.pollMs) || 250);
  let stopped = false;
  let timer;

  const stop = () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };

  const attempt = () => {
    if (stopped) return true;
    for (const name of candidates) {
      const service = tryGet(ctx, name);
      if (!service) continue;
      if (patchFileUploadsService(service, log)) {
        stop();
        return true;
      }
      log(`file-upload shim skipped: service "${name}" does not expose registerAgentResolver`);
      stop();
      return true;
    }
    return false;
  };

  if (attempt()) return stop;

  // 动态 inject：服务出现时补一次。
  for (const name of candidates) {
    try {
      ctx.inject([name], () => attempt());
    } catch { /* 宿主不支持动态 inject 时交给轮询 */ }
  }

  const deadline = Date.now() + waitMs;
  const poll = () => {
    if (stopped) return;
    if (attempt()) return;
    if (Date.now() > deadline) {
      log("file-upload shim skipped: fileUploads service did not appear in time");
      stop();
      return;
    }
    timer = setTimeout(poll, pollMs);
    if (typeof timer.unref === "function") timer.unref();
  };
  poll();

  const dispose = () => stop();
  try {
    ctx.effect(() => dispose, "dsh-po: file-upload resolver shim");
  } catch { /* 非 effect 上下文忽略 */ }
  return dispose;
}

export const FILE_UPLOAD_SHIM_SYMBOLS = { SLOT, PATCHED };
