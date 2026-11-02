/**
 * 外部翻译后端（默认 Azure Translator）。
 *
 * 与手写模板库互补：模板只能覆盖固定语义，翻译能把用户中文里的具体指令
 * 原样转成低资源语言。翻译失败 / 缺 key / 超时一律返回 null，由 rewrite.js
 * 回退到模板，不阻塞 agent loop。
 *
 * 凭据优先级：config > 环境变量。
 *   - AZURE_TRANSLATOR_KEY
 *   - AZURE_TRANSLATOR_REGION
 *   - AZURE_TRANSLATOR_ENDPOINT
 */
import { softenPrefix } from "./languages.js";

/**
 * 把 region 归一成 Azure 要求的短代码：小写 + 去掉空格与非字母数字。
 * Azure 的 `Ocp-Apim-Subscription-Region` 只认 `eastasia` / `westeurope` 这类
 * 短代码；用户在弹框里手填 "East Asia" 会被 401 拒绝。
 * @param {string} value 原始 region（显示名、"Global"、短代码或空）
 * @returns {string} 归一后的 region；空值原样返回空串
 */
export function normalizeRegion(value) {
  return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

export const TRANSLATE_DEFAULTS = {
  enabled: false,
  api: "azure",      // 当前仅 azure；留扩展位
  endpoint: "https://api.cognitive.microsofttranslator.com",
  key: "",           // Azure Translator 订阅 key
  region: "",        // 资源 region（global 资源也要填 "global"）
  from: "zh-Hans",   // 源语言；留空 = 自动检测
  to: "",            // 目标语言；留空 = rewrite.language
  timeoutMs: 5000,
  soften: false,     // 翻译结果前拼接软化前缀（assume_own / stepwise）
};

const cache = new Map();
const CACHE_MAX = 200;

function putCache(key, value) {
  if (cache.size >= CACHE_MAX) {
    const first = cache.keys().next().value;
    if (first !== undefined) cache.delete(first);
  }
  cache.set(key, value);
}

/** 测试/诊断用：清空翻译缓存。 */
export function clearTranslateCache() {
  cache.clear();
}

/**
 * 翻译一条文本。成功返回目标语言文本；任何失败返回 null（fail-open）。
 * @param {string} text 原文
 * @param {object} rewrite 已合并的 rewrite 配置（含 translate 子对象）
 * @param {string|null} target 提取到的目标，用于软化前缀的 {target}
 */
export async function translateText(text, rewrite, target) {
  const t = { ...TRANSLATE_DEFAULTS, ...(rewrite && rewrite.translate ? rewrite.translate : {}) };
  if (!t.enabled || t.api !== "azure") return null;

  const key = t.key || process.env.AZURE_TRANSLATOR_KEY || "";
  if (!key) return null;
  const region = normalizeRegion(t.region || process.env.AZURE_TRANSLATOR_REGION || "");
  const endpoint = (t.endpoint || process.env.AZURE_TRANSLATOR_ENDPOINT || TRANSLATE_DEFAULTS.endpoint).replace(/\/+$/, "");

  const to = t.to || rewrite.language || "eu";
  const query = new URLSearchParams({ "api-version": "3.0", to });
  if (t.from) query.set("from", t.from);
  const url = `${endpoint}/translate?${query.toString()}`;

  // 缓存 key 覆盖所有影响输出的输入（软化前缀依赖 language/phrase/target）。
  const cacheKey = JSON.stringify([url, text, t.soften, rewrite.language, rewrite.phrase, target]);
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(100, Number(t.timeoutMs) || 5000));
  if (typeof timer.unref === "function") timer.unref();

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Ocp-Apim-Subscription-Key": key,
        ...(region ? { "Ocp-Apim-Subscription-Region": region } : {}),
      },
      body: JSON.stringify([{ text }]),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const json = await res.json();
    const translated = json?.[0]?.translations?.[0]?.text;
    if (typeof translated !== "string" || !translated) return null;

    const out = t.soften
      ? softenPrefix(rewrite.language, rewrite.phrase, target) + translated
      : translated;
    putCache(cacheKey, out);
    return out;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
