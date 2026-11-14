/**
 * agent/pre-step 消息改写：把用户的中文渗透指令透明替换为低资源语言版本。
 *
 * 原理（来自对 dsh-agent-loop 的逆向）：
 *   宿主每步调用 LLM 前，通过 agent-scoped 的 `agent/pre-step` waterfall 分发，
 *   payload 含即将发送的 `messages`；fallback 负责渲染 system prompt / runtime-context。
 *   监听器 `await next()` 拿到 fallback 构造好的完整 messages 后，改写其中
 *   `role === 'user'` 且非 runtime-context 的消息，再返回。
 *
 * 改写不依赖运行时翻译：文案来自 lib/languages.js 的预置低资源语言模板。
 * 关键事实：护栏拦的是"消息本身的中文语义"，把消息写成低资源语言才有效，
 * 而不是让模型"自己翻译"。
 */
import { resolveTemplate, REWRITE_DEFAULTS } from "./languages.js";
import { translateText } from "./translate.js";

const URL_RE = /https?:\/\/[^\s"'`)\]}<>]+/i;
const IPV4_RE = /(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b/;
const LOCALHOST_RE = /\blocalhost(?::\d{1,5})?\b/i;
const DOMAIN_RE =
  /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})(?::\d{1,5})?\b/i;

/** 提取消息文本（user 消息 content 为 [{type:'text',text}] 或 string）。 */
export function textOf(message) {
  const c = message && message.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    const [block] = c;
    if (block && block.type === "text") return block.text;
  }
  return undefined;
}

/** 从任意文本提取目标（URL → IPv4 → localhost → 域名）。 */
export function extractTarget(text) {
  if (typeof text !== "string" || !text) return null;
  const url = text.match(URL_RE)?.[0];
  if (url) return url.replace(/[.,;:)\]}>]+$/, "");
  const ip = text.match(IPV4_RE)?.[0];
  if (ip) return ip;
  const lh = text.match(LOCALHOST_RE)?.[0];
  if (lh) return lh;
  const dom = text.match(DOMAIN_RE)?.[0];
  return dom ? dom.replace(/[.,;)\]}>]+$/, "") : null;
}

/** 渲染模板：`{target}` 注入真实目标或占位符。 */
export function renderTemplate(template, target, usePlaceholder) {
  const holder = usePlaceholder ? "TARGET" : target;
  return String(template || "").split("{target}").join(holder);
}

/**
 * 默认暗语：**写在消息末尾**时，这句话无条件走翻译（不需要 URL / IP / 域名），
 * 并且发送前会把暗语本身从正文里剔除。配置项 `rewrite.code` 可改。
 */
export const DEFAULT_CODEWORD = "#dshpo";

/**
 * 改写后追加的“回答语言”指令。
 *
 * 为什么需要：正文被翻成巴斯克语之后，模型往往跟着用巴斯克语回答。这里在改写
 * 结束处补一句输出语言约束（默认中文），只约束**回答语言**，不改变任务内容。
 * 配 `rewrite.replySuffix`（空串 = 关闭）。
 */
export const DEFAULT_REPLY_SUFFIX = "\n\n(请用中文回答。)";

/**
 * 从消息末尾摘掉暗语。
 *
 * 只认“末尾”（允许后面跟句号/问号/空白），避免把正文里正常出现的同形词误删。
 *
 * @param {string} text 原文
 * @param {string} code 暗语（空串 = 关闭该特性）
 * @returns {{text: string, hit: boolean, only: boolean}}
 */
export function takeCodeword(text, code) {
  const token = typeof code === "string" ? code.trim() : "";
  if (!token || typeof text !== "string") return { text, hit: false, only: false };

  const trimmedEnd = text.replace(/[\s。.！!？?]+$/u, "");
  if (trimmedEnd.length < token.length) return { text, hit: false, only: false };
  if (trimmedEnd.slice(-token.length).toLowerCase() !== token.toLowerCase()) {
    return { text, hit: false, only: false };
  }

  const head = trimmedEnd
    .slice(0, trimmedEnd.length - token.length)
    .replace(/[\s，,。；;:：、]+$/u, "")
    .trim();
  return { text: head, hit: true, only: head.length === 0 };
}

/**
 * 判断一条消息会不会被改写，并给出发起改写所需的信息（**不发起网络请求**）。
 *
 * **唯一触发条件：消息末尾带暗语**（`rewrite.code`，默认 {@link DEFAULT_CODEWORD}）。
 * 不再按“消息里有没有 URL / IP / 域名”自动改写 —— 目标提取只用于翻译失败时的
 * 模板回退（`{target}` 占位）。
 *
 * @param {object} message 待检查消息
 * @param {object} [opts] rewrite 配置
 * @returns {{ok: boolean, reason: string|null, text: string, target: string|null, codeword: boolean}}
 */
export function inspectUserMessage(message, opts = {}) {
  const none = (reason) => ({ ok: false, reason, text: "", target: null, codeword: false });
  if (!message || message.role !== "user") return none("not-user");
  if (message.source && message.source.kind === "runtime-context") return none("runtime-context");
  const text = textOf(message);
  if (!text) return none("no-text");

  const code = opts.code === undefined ? DEFAULT_CODEWORD : opts.code;
  const stripped = takeCodeword(text, code);
  if (stripped.only) return none("codeword-only");
  // 只认暗语：没带暗语的一律原样发送，哪怕消息里有域名/IP。
  if (!stripped.hit) return none("no-codeword");

  return { ok: true, reason: null, text: stripped.text, target: extractTarget(stripped.text), codeword: true };
}

/**
 * 改写单条消息。仅处理：
 *   - role === 'user'
 *   - source.kind !== 'runtime-context'（动态上下文快照不是用户输入）
 *   - 消息末尾带暗语（`rewrite.code`）
 * 否则原样返回（不误改写）。
 * 消息是 deep-freeze 的，因此返回 `{...message, content:[...]}` 重建，不原地改。
 */
export async function rewriteUserMessage(message, opts) {
  return (await rewriteUserMessageDetailed(message, opts)).message;
}

/**
 * 同 {@link rewriteUserMessage}，但把“为什么改 / 怎么改的”一并返回。
 *
 * CLI `dsh-po rewrite` 靠它回答“到底有没有生效”：没改是没命中目标、还是
 * 命中但走的模板回退，这里能分得清。
 *
 * @param {object} message 待改写消息
 * @param {object} opts rewrite 配置
 * @returns {Promise<{message: object, changed: boolean, via: "translate"|"template"|"strip"|"none", target: string|null, codeword: boolean, reason: string|null}>}
 */
export async function rewriteUserMessageDetailed(message, opts = {}) {
  const skip = (reason) => ({ message, changed: false, via: "none", target: null, codeword: false, reason });

  const info = inspectUserMessage(message, opts);
  if (!info.ok) return skip(info.reason);

  // 改写后的输出语言约束（默认要求用中文回答）。
  const suffix = typeof opts.replySuffix === "string" ? opts.replySuffix : DEFAULT_REPLY_SUFFIX;
  const finish = (text) => (suffix ? `${text}${suffix}` : text);

  // 暗语是“这句话给我翻译”的显式指令：即使 translate.enabled=false 也照翻
  // （没 key / 失败时照旧 fail-open 回退）。
  const translateOpts = info.codeword
    ? { ...opts, translate: { ...(opts.translate || {}), enabled: true } }
    : opts;

  // 翻译模式：成功则用翻译结果，失败回退到手写模板。
  const translated = await translateText(info.text, translateOpts, info.target);
  if (translated) {
    return {
      message: { ...message, content: [{ type: "text", text: finish(translated) }] },
      changed: true,
      via: "translate",
      target: info.target,
      codeword: info.codeword,
      reason: null,
    };
  }

  if (!info.target) {
    // 暗语命中但翻译失败、又没有目标：至少把暗语去掉，正文原样发送。
    return {
      message: { ...message, content: [{ type: "text", text: info.text }] },
      changed: true,
      via: "strip",
      target: null,
      codeword: true,
      reason: null,
    };
  }

  const { template } = resolveTemplate(opts.language, opts.phrase);
  const rewritten = renderTemplate(template, info.target, Boolean(opts.usePlaceholder));
  return {
    message: { ...message, content: [{ type: "text", text: finish(rewritten) }] },
    changed: true,
    via: "template",
    target: info.target,
    codeword: info.codeword,
    reason: null,
  };
}

/** 改写整组消息（map，非原地）。 */
export async function rewriteMessages(messages, opts) {
  if (!Array.isArray(messages)) return messages;
  return Promise.all(messages.map((m) => rewriteUserMessage(m, opts)));
}

/**
 * 注册 `agent/pre-step` 改写监听器。
 *
 * 与审批应答器一致地使用 `{ global: true, prepend: true }`：审批事件同为
 * agent-scoped，该选项已验证能跨 scope 命中；`prepend` 保证我们的改写先于
 * 其它监听器、且 `await next()` 拿到 fallback 结果后再改写。
 */
export function installAgentPreStepRewrite(ctx, cfg, log, audit) {
  // cfg 可以是对象，也可以是一个 getter：宿主把 volatile 字段即时提交到
  // `ctx.fiber.config`，每次改写前重读一次，改完 key/region 就不用重启。
  const readConfig = typeof cfg === "function" ? cfg : () => cfg;
  const normalize = (raw) => {
    // 兼容两种配置形态：
    //   1) 完整插件 config：{ rewrite: { enabled, language, phrase, usePlaceholder } }
    //   2) 扁平 rewrite config：{ enabled, language, phrase, usePlaceholder }
    const opts =
      raw && typeof raw.rewrite === "object" && raw.rewrite !== null
        ? raw.rewrite
        : (raw && typeof raw === "object" ? raw : {});
    return { enabled: true, ...REWRITE_DEFAULTS, ...opts };
  };
  const initial = normalize(readConfig());
  if (initial.enabled === false) {
    log?.("agent/pre-step rewrite disabled");
    return;
  }

  const handler = async (payload, next) => {
    const result = await next();
    try {
      const rewrite = normalize(readConfig());
      if (rewrite.enabled === false) return result;
      if (result && result.kind === "enter" && Array.isArray(result.messages)) {
        const messages = await rewriteMessages(result.messages, rewrite);
        // verbose 下留一条可核对的痕迹：这一步到底改写了几条。
        // （会话 transcript 存的是原文，改写只发生在发给模型的那份 messages 上。）
        {
          const hits = result.messages.map((m) => inspectUserMessage(m, rewrite)).filter((info) => info.ok);
          if (hits.length > 0) {
            const codeHits = hits.filter((info) => info.codeword).length;
            const summary =
              `agent/pre-step rewrite: ${hits.length} user message(s) → ${rewrite.language}` +
              (codeHits > 0 ? ` (${codeHits} by 暗语 ${rewrite.code || DEFAULT_CODEWORD})` : "");
            log?.(summary);
            // 落盘审计：改写是“不该发生的时候发生了”这类问题的唯一可核对痕迹。
            audit?.(`REWRITE ${summary}`);
          }
        }
        return { ...result, messages };
      }
    } catch (error) {
      log?.(`rewrite failed: ${String((error && error.message) || error)}`);
    }
    return result;
  };

  try {
    ctx.on("agent/pre-step", handler, { global: true, prepend: true });
    log?.(
      `agent/pre-step rewrite installed (lang=${initial.language} phrase=${initial.phrase}` +
        (initial.usePlaceholder ? " usePlaceholder" : "") + ")",
    );
  } catch (error) {
    log?.(`agent/pre-step rewrite register failed: ${String((error && error.message) || error)}`);
  }
}
