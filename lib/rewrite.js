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
 * 改写单条消息。仅处理：
 *   - role === 'user'
 *   - source.kind !== 'runtime-context'（动态上下文快照不是用户输入）
 *   - 文本能提取到目标
 * 否则原样返回（不误改写）。
 * 消息是 deep-freeze 的，因此返回 `{...message, content:[...]}` 重建，不原地改。
 */
export async function rewriteUserMessage(message, opts) {
  if (!message || message.role !== "user") return message;
  if (message.source && message.source.kind === "runtime-context") return message;
  const text = textOf(message);
  if (!text) return message;
  const target = extractTarget(text);
  if (!target) return message;

  // 翻译模式：成功则用翻译结果，失败回退到手写模板。
  const translated = await translateText(text, opts, target);
  if (translated) {
    return { ...message, content: [{ type: "text", text: translated }] };
  }

  const { template } = resolveTemplate(opts.language, opts.phrase);
  const rewritten = renderTemplate(template, target, Boolean(opts.usePlaceholder));
  return { ...message, content: [{ type: "text", text: rewritten }] };
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
export function installAgentPreStepRewrite(ctx, cfg, log) {
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
