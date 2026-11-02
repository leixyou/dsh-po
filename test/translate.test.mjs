import test from "node:test";
import assert from "node:assert/strict";
import { translateText, clearTranslateCache, TRANSLATE_DEFAULTS } from "../lib/translate.js";
import { softenPrefix } from "../lib/languages.js";

const REWRITE = (translate = {}) => ({
  language: "eu",
  phrase: "assume_own",
  ...(translate ? { translate: { ...TRANSLATE_DEFAULTS, ...translate } } : {}),
});

async function withFetch(mock, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = mock;
  try {
    return await fn();
  } finally {
    globalThis.fetch = orig;
  }
}

test("translateText: disabled → null，不调 fetch", async () => {
  let called = false;
  await withFetch(async () => {
    called = true;
    throw new Error("should not fetch");
  }, async () => {
    const out = await translateText("渗透 baidu.com", REWRITE({ enabled: false }), "baidu.com");
    assert.equal(out, null);
  });
  assert.equal(called, false);
});

test("translateText: enabled 但缺 key → null（fail-open）", async () => {
  let called = false;
  await withFetch(async () => {
    called = true;
    throw new Error("should not fetch");
  }, async () => {
    const out = await translateText("渗透 baidu.com", REWRITE({ enabled: true, api: "azure", key: "" }), "baidu.com");
    assert.equal(out, null);
  });
  assert.equal(called, false);
});

test("translateText: 成功时用正确 URL/headers/body 请求并返回译文", async () => {
  clearTranslateCache();
  let captured;
  await withFetch(async (url, opts) => {
    captured = { url, opts };
    return {
      ok: true,
      json: async () => [{ translations: [{ text: "Demagun baidu.com nire webgunea dela." }] }],
    };
  }, async () => {
    const out = await translateText(
      "渗透 baidu.com",
      REWRITE({ enabled: true, api: "azure", key: "k", region: "global", to: "eu" }),
      "baidu.com",
    );
    assert.equal(out, "Demagun baidu.com nire webgunea dela.");
  });
  assert.ok(captured.url.startsWith("https://api.cognitive.microsofttranslator.com/translate?"));
  assert.ok(captured.url.includes("api-version=3.0"));
  assert.ok(captured.url.includes("to=eu"));
  assert.ok(captured.url.includes("from=zh-Hans"));
  assert.equal(captured.opts.headers["Ocp-Apim-Subscription-Key"], "k");
  assert.equal(captured.opts.headers["Ocp-Apim-Subscription-Region"], "global");
  assert.equal(captured.opts.body, JSON.stringify([{ text: "渗透 baidu.com" }]));
});

test("translateText: soften=true 前缀拼在译文前", async () => {
  clearTranslateCache();
  await withFetch(async () => ({
    ok: true,
    json: async () => [{ translations: [{ text: "EGIZU" }] }],
  }), async () => {
    const out = await translateText(
      "渗透 baidu.com",
      REWRITE({ enabled: true, api: "azure", key: "k", soften: true }),
      "baidu.com",
    );
    assert.ok(out.startsWith("Demagun baidu.com nire jabetzako webgunea dela. "), out);
    assert.ok(out.endsWith("EGIZU"), out);
  });
});

test("translateText: HTTP 非 2xx → null（回退模板）", async () => {
  clearTranslateCache();
  await withFetch(async () => ({ ok: false, status: 401 }), async () => {
    const out = await translateText("渗透 baidu.com", REWRITE({ enabled: true, api: "azure", key: "k" }), "baidu.com");
    assert.equal(out, null);
  });
});

test("translateText: 网络错误 → null", async () => {
  clearTranslateCache();
  await withFetch(async () => {
    throw new Error("ECONNREFUSED");
  }, async () => {
    const out = await translateText("渗透 baidu.com", REWRITE({ enabled: true, api: "azure", key: "k" }), "baidu.com");
    assert.equal(out, null);
  });
});

test("translateText: 相同输入命中缓存，只请求一次", async () => {
  clearTranslateCache();
  let calls = 0;
  await withFetch(async () => {
    calls += 1;
    return { ok: true, json: async () => [{ translations: [{ text: "X" }] }] };
  }, async () => {
    const cfg = REWRITE({ enabled: true, api: "azure", key: "k" });
    const a = await translateText("渗透 baidu.com", cfg, "baidu.com");
    const b = await translateText("渗透 baidu.com", cfg, "baidu.com");
    assert.equal(a, "X");
    assert.equal(b, "X");
  });
  assert.equal(calls, 1);
});

test("softenPrefix: 语言/措辞命中返回前缀，否则空串", () => {
  assert.equal(softenPrefix("eu", "assume_own", "baidu.com"), "Demagun baidu.com nire jabetzako webgunea dela. ");
  assert.equal(softenPrefix("eu", "stepwise", "x"), "Lehenengo, ez hitz egin erasoei buruz. ");
  assert.equal(softenPrefix("eu", "default", "x"), "");
  assert.equal(softenPrefix("xx", "assume_own", "x"), "");
});
