/**
 * dsh-po 的 Config schema（schemastery）。
 *
 * 声明后 DSH 设置页会按 schema 自动生成配置表单（原生「弹框」）：
 *   - `role("secret")` 字段是只写密码框，读回时被 redact，绝不外发；
 *   - `.volatile()` 字段改动即时生效（不用重启宿主）；
 *   - `.loose()` 容忍 profile 里已有的额外键，不因新增字段拒绝旧配置。
 *
 * 注意：本文件只在宿主里被 `lib/index.js` 动态 import；schemastery 不可用时
 * 动态 import 失败，插件回退到无 schema 的纯运行时行为（CLI setup 仍可用）。
 */
import z from "./vendor/schemastery.js";
import { DEFAULT_CODEWORD, DEFAULT_REPLY_SUFFIX } from "./rewrite.js";

const translateConfig = z.object({
  enabled: z.boolean().default(false),
  api: z.string().default("azure"),
  endpoint: z.string().default("https://api.cognitive.microsofttranslator.com"),
  key: z.string().role("secret").default(""),
  region: z.string().default(""),
  from: z.string().default("zh-Hans"),
  to: z.string().default(""),
  timeoutMs: z.number().default(5000),
  soften: z.boolean().default(false),
}).volatile();

export const Config = z.object({
  enabled: z.boolean().default(true),
  verbose: z.boolean().default(false),
  prompt: z.string().default(""),
  postPrompt: z.string().default(""),
  postPromptOrder: z.number().default(9000),
  approvalContext: z.boolean().default(true),
  approvalResult: z.string().default("allowed-once"),
  // 破甲正文投放通道：section / context / both / none
  promptPlacement: z.string().default("both"),
  serviceWaitMs: z.number().default(10000),
  servicePollMs: z.number().default(250),
  fixFileUploadResolver: z.boolean().default(true),
  setupTool: z.boolean().default(true),
  rewrite: z.object({
    enabled: z.boolean().default(true),
    language: z.string().default("eu"),
    phrase: z.string().default("assume_own"),
    usePlaceholder: z.boolean().default(false),
    // 消息末尾带上这个暗语 → 无条件翻译，并从正文里剔除（空串 = 关闭）
    code: z.string().default(DEFAULT_CODEWORD),
    // 改写后追加的输出语言约束（默认要求用中文回答；空串 = 不追加）
    replySuffix: z.string().default(DEFAULT_REPLY_SUFFIX),
    // 单步耗时超过此值（ms）时写一条 SLOW pre-step 诊断
    slowMs: z.number().default(200),
    translate: translateConfig,
  }),
}).loose();

export default Config;
