/**
 * 版本适配层：把「逻辑目标」映射到「当前宿主实际的 entry id / 服务名 / 事件名」。
 *
 * 解析优先级：
 *   1. 运行时自省（lib/harness.js）—— 真实存在的 id 与包名，跨版本最可靠
 *   2. 候选别名列表 —— 同一逻辑目标在不同版本里的历史 id
 *   3. 内置默认值 —— 自省完全失败时仍能工作（标记 unverified）
 *
 * 这样 dsh-po 不再绑定 0.2.1-rc.3：rc.4/rc.5 把 dsh-approval 改名成
 * dsh-user-approval、dsh-permission 改名成 dsh-permission-presets 之后，
 * 只要 entry id 不变就零改动；若将来 id 也改了，候选别名和自省兜底仍能命中。
 */

import { introspect } from "./harness.js";

/** 逻辑目标 → 候选 entry id（按优先级）。 */
export const LOGICAL_TARGETS = {
  systemPrompt: ["system-prompt", "systemPrompt", "prompt"],
  sandboxPolicy: ["sandbox-policy", "sandbox"],
  approval: ["approval", "user-approval", "permission-approval"],
  permission: ["permission", "permission-presets"],
  spillPolicy: ["spill-policy", "spill"],
  toolResultPruner: ["tool-result-pruner", "compaction-tool-result-pruner", "tool-result-compactor", "pruner"],
  agentInstructions: ["agent-instructions", "workspace-instructions"],
  sessionQuery: ["session-query-sqlite", "session-query", "session-search"],
};

/** 自省不可用时的兜底值（0.2.x 全系一致）。 */
export const FALLBACK = {
  ids: {
    systemPrompt: "system-prompt",
    sandboxPolicy: "sandbox-policy",
    approval: "approval",
    permission: "permission",
    spillPolicy: "spill-policy",
    toolResultPruner: "tool-result-pruner",
    agentInstructions: "agent-instructions",
    sessionQuery: "session-query-sqlite",
  },
  services: { systemPrompt: "systemPrompt", approval: "approval" },
  approvalEvents: ["approval/request", "approval:request", "user-approval/request"],
  orders: { harnessIdentity: -1000, approvalPolicy: 115 },
};

/** 拆掉 scope 前缀，便于与 entry.name 比对。 */
function barePackageName(name) {
  return String(name || "").replace(/^@deepseek-ai\//, "");
}

/**
 * @param {ReturnType<import("./harness.js").introspect>} intro
 * @returns {{
 *   verified: boolean,
 *   version: string,
 *   kind: string,
 *   ids: Record<string,string>,
 *   found: Record<string, {id:string,name:string|null}|null>,
 *   services: {systemPrompt:string, approval:string},
 *   approvalEvents: string[],
 *   orders: {harnessIdentity:number, approvalPolicy:number},
 *   globalPromptOrder: number,
 *   approvalContextOrder: number,
 * }}
 */
export function resolveTargets(intro) {
  const ok = Boolean(intro && intro.ok);
  const byId = (intro && intro.byId) || new Map();
  const byName = (intro && intro.byName) || new Map();

  const ids = {};
  const found = {};

  for (const [logical, candidates] of Object.entries(LOGICAL_TARGETS)) {
    let hit = null;
    for (const candidate of candidates) {
      // 1) 直接命中 entry id
      const entry = byId.get(candidate);
      if (entry) { hit = { id: entry.id, name: entry.name || null }; break; }
      // 2) 命中包名（id 改名、包名保留的情况）
      const byPkg = byName.get(candidate) || byName.get(`@deepseek-ai/${candidate}`);
      if (byPkg) { hit = { id: byPkg.id, name: byPkg.name || null }; break; }
    }
    if (!hit && ok) {
      // 3) 包名模糊匹配：id 改名后仍可按包名找回
      //    例：id `approvals` ← 包 `@deepseek-ai/dsh-user-approval`（stem `approval`）
      outer: for (const candidate of candidates) {
        const stem = candidate.replace(/^dsh-/, "");
        for (const [name, entry] of byName) {
          const bare = barePackageName(name);
          if (bare === stem || bare.endsWith(`-${stem}`)) {
            hit = { id: entry.id, name: entry.name || null };
            break outer;
          }
        }
      }
    }
    found[logical] = hit;
    ids[logical] = hit ? hit.id : FALLBACK.ids[logical];
  }

  const services = {
    systemPrompt: (intro && intro.services && intro.services.systemPrompt) || FALLBACK.services.systemPrompt,
    approval: (intro && intro.services && intro.services.approval) || FALLBACK.services.approval,
  };

  // 事件名：以自省结果为主，历史别名追加在后，全部注册（未知事件注册无副作用）
  const events = [];
  for (const name of [
    ...((intro && intro.approvalEvents) || []),
    ...FALLBACK.approvalEvents,
  ]) {
    if (name && !events.includes(name)) events.push(name);
  }

  const orders = {
    harnessIdentity: (intro && intro.orders && intro.orders.harnessIdentity) ?? FALLBACK.orders.harnessIdentity,
    approvalPolicy: (intro && intro.orders && intro.orders.approvalPolicy) ?? FALLBACK.orders.approvalPolicy,
  };

  return {
    verified: ok,
    version: (intro && intro.version) || "",
    kind: (intro && intro.kind) || "",
    reason: (intro && intro.reason) || "",
    ids,
    found,
    services,
    approvalEvents: events,
    orders,
    // 破甲正文排在 Harness 身份之前，留足余量
    globalPromptOrder: Math.min(orders.harnessIdentity - 99000, -1e5),
    // 官方审批策略文案之后，逐条覆盖
    approvalContextOrder: orders.approvalPolicy + 1,
  };
}

/** 便捷封装：自省 + 解析（一次调用拿到完整计划）。 */
export function resolvePlan(options = {}) {
  return resolveTargets(introspect(options));
}
