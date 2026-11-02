/**
 * `dsh_po_translate_setup` —— 通过宿主 `userQuestions` 弹框收集 Azure Translator
 * key / region，并写进当前 profile 的 `cordis.patch.yml`（`rewrite.translate`）。
 *
 * 为什么需要它：DSH 0.2.1-rc.5 不会给第三方插件渲染设置表单（插件页配置区只来自
 * 官方 companion 包注册的客户端槽位），`ctx.settings.configure({ auto: true })`
 * 只登记「自动页策略」，不会生成页面。所以这里提供一个工具：模型调用它 → 宿主
 * 弹出问答卡片 → 用户在卡片里输入 key → 落盘。
 *
 * 设计约束：
 *   - 不 import 任何 `@deepseek-ai/*` 包（profile 内 `link:` 安装解析不到宿主包），
 *     tool definition 直接使用注册表要求的 JSON Schema 子集；
 *   - 写盘复用 `scripts/profile-insert.js`（与 CLI `dsh-po setup` 同一条路径，
 *     只改 insert 块的 config，不重排文件）；
 *   - 返回值和日志都不含明文 key。
 */

import { ensureProfileTranslateConfig } from "../scripts/profile-insert.js";
import { normalizeRegion } from "./translate.js";

/** 工具名：前缀避免与宿主/其它插件撞名。 */
export const SETUP_TOOL_NAME = "dsh_po_translate_setup";

/**
 * 保留尾部 4 位，其余打码；空 key 返回空串。
 * @param {string} key 原始 key
 * @returns {string} 可安全回显的掩码
 */
export function maskKey(key) {
  const value = String(key ?? "");
  if (!value) return "";
  if (value.length <= 4) return "*".repeat(value.length);
  return `${"*".repeat(Math.min(8, value.length - 4))}${value.slice(-4)}`;
}

/**
 * 需要向用户询问的两个问题。不传 `options` 时，客户端渲染成自由输入框
 * （`custom` 字段），适合粘贴 key。
 * @returns {Array<object>} `userQuestions.ask()` 的问题列表
 */
export function setupQuestions() {
  return [
    {
      id: "key",
      header: "Azure Translator",
      question:
        "把 Azure Translator 的订阅 key 粘进来。它会以明文写进当前 profile 的 cordis.patch.yml（rewrite.translate）。留空表示取消。",
    },
    {
      id: "region",
      header: "区域",
      question: "这个 key 属于哪个区域？（短代码，如 eastasia / westeurope；不确定就直接回车，用 global）",
    },
  ];
}

/**
 * 合并工具参数与问答结果：参数优先，其次问答的 `custom`，region 缺省 `global`。
 * @param {Array<{id:string,custom?:string}>} answers 问答结果
 * @param {{key?:string,region?:string}} [args] 工具参数
 * @returns {{key:string,region:string}} 规范化后的输入
 */
export function parseSetupAnswers(answers, args = {}) {
  const byId = new Map((Array.isArray(answers) ? answers : []).map((answer) => [answer?.id, answer]));
  const custom = (id) => {
    const value = byId.get(id)?.custom;
    return typeof value === "string" ? value.trim() : "";
  };
  const key = String(args?.key ?? "").trim() || custom("key");
  const region = normalizeRegion(String(args?.region ?? "").trim() || custom("region") || "global");
  return { key, region };
}

/**
 * 构造工具定义（注册表要求的 JSON Schema 子集：type/properties/required/
 * additionalProperties/items/enum + description）。
 *
 * @param {object} options
 * @param {import("@deepseek-ai/cordis").Context} options.ctx 插件上下文（用于取服务）
 * @param {(message: string) => void} [options.log] 诊断输出
 * @returns {object} `tools.register()` 可接受的 definition
 */
export function setupToolDefinition({ ctx, log = () => {} }) {
  return {
    name: SETUP_TOOL_NAME,
    description:
      "配置 dsh-po 的 Azure Translator key：弹出一个问答卡片收集 key 和区域，写进当前 profile 的 cordis.patch.yml（rewrite.translate），然后热重载生效。用户没有 key、或只是想做普通的低资源语言改写时不要调用。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        key: {
          type: "string",
          description: "可选：直接提供 key（省略则弹框询问，推荐弹框，避免 key 进入对话记录）。",
        },
        region: {
          type: "string",
          description: "可选：Azure 区域，例如 global / eastasia。省略则弹框询问，回答为空时用 global。",
        },
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["saved", "region", "maskedKey", "live"],
        properties: {
          saved: { type: "boolean", description: "是否已写入 profile。" },
          region: { type: "string", description: "实际写入的区域。" },
          maskedKey: { type: "string", description: "写入 key 的掩码（仅尾部 4 位）。" },
          path: { type: "string", description: "写入的 cordis.patch.yml 路径。" },
          live: { type: "boolean", description: "宿主是否有 HMR（有则立即热生效，否则重启后生效）。" },
          reason: { type: "string", description: "未写入时的原因。" },
        },
      },
      render: (_args, value) => [
        {
          type: "text",
          text: value.saved
            ? `已写入 rewrite.translate（key=${value.maskedKey}, region=${value.region}）：${value.path}。` +
              (value.live ? "宿主支持热重载，volatile 字段已即时生效。" : "重启 DSH 后生效。")
            : `没有写入：${value.reason ?? "已取消"}。`,
        },
      ],
    },
    async execute(args, exec) {
      let answers = [];
      if (!args?.key) {
        const userQuestions = ctx.get("userQuestions");
        if (!userQuestions || typeof userQuestions.ask !== "function") {
          throw new Error(
            "dsh-po: 当前宿主没有 userQuestions 服务，无法弹框。请在终端跑 `node bin/dsh-po.js setup`,或直接在调用参数里给 key。",
          );
        }
        const asked = await userQuestions.ask({
          questions: setupQuestions(),
          ...(exec?.agent ? { agent: exec.agent } : {}),
          ...(exec?.signal ? { signal: exec.signal } : {}),
        });
        answers = asked?.answers ?? [];
      }

      const { key, region } = parseSetupAnswers(answers, args);
      if (!key) return { saved: false, region, maskedKey: "", live: false, reason: "没有拿到 key（已取消）" };

      const profile = ctx.get("profileContext");
      const dir = profile?.dir;
      if (!dir) throw new Error("dsh-po: 宿主没有 profileContext，定位不到 profile 目录；请改用 `dsh-po setup`。");

      const written = ensureProfileTranslateConfig(dir, { enabled: true, key, region });
      if (!written.ok) {
        throw new Error(`dsh-po: 写入 ${written.path} 失败：${written.reason ?? "未知原因"}`);
      }

      const live = ctx.get("hmr") !== undefined;
      log(`translate key written to ${written.path} (region=${region}, masked=${maskKey(key)}, live=${live})`);
      return { saved: true, region, maskedKey: maskKey(key), path: written.path, live };
    },
  };
}

/**
 * 在 `tools` 服务就绪后注册工具；任何失败只记日志，不影响插件其余能力。
 *
 * @param {import("@deepseek-ai/cordis").Context} ctx 插件上下文
 * @param {object} [cfg] 插件配置（保留给未来开关）
 * @param {(message: string) => void} [log] 诊断输出
 * @returns {boolean} 是否已发起注册（不等于注册成功）
 */
export function installSetupTool(ctx, cfg = {}, log = () => {}) {
  if (cfg.setupTool === false) {
    log("setup tool disabled by config");
    return false;
  }
  try {
    ctx.inject(["tools"], (child) => {
      try {
        const dispose = child.tools.register(setupToolDefinition({ ctx, log }));
        if (typeof dispose === "function") child.effect(() => dispose);
        log(`setup tool registered: ${SETUP_TOOL_NAME}`);
      } catch (error) {
        log(`setup tool registration failed: ${(error && error.message) || error}`);
      }
    });
    return true;
  } catch (error) {
    log(`setup tool unavailable: ${(error && error.message) || error}`);
    return false;
  }
}
