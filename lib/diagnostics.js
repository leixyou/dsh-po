/**
 * 落盘诊断日志。
 *
 * 为什么需要：桌面版宿主是 Electron 起的，插件的 `console.warn` 写到它的 stdout，
 * 用户在 GUI 里**看不到**。破甲正文没进 system prompt 这类故障因此完全没有痕迹
 * （只有开着 verbose 并且从终端启动才能看见）。
 *
 * 这里把关键事件写进 `$DSH_HOME/dsh-po.log`（默认 `~/.dsh/dsh-po.log`）：
 *   - 每次 apply 的一行摘要（宿主版本 / 自省是否成功 / order）
 *   - 每一项（审批上下文 / 破甲正文 / postPrompt）的安装结果
 *   - 自愈与失败原因
 *
 * 只写摘要，不写 prompt 正文、不写 key。文件超过上限就截断重写，不会长到失控。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** 单个日志文件的上限；超过就在下次写入前截断。 */
export const MAX_LOG_BYTES = 256 * 1024;

/**
 * 默认日志路径：`$DSH_HOME/dsh-po.log`，没有 DSH_HOME 时用 `~/.dsh/dsh-po.log`。
 *
 * @returns {string}
 */
export function defaultLogFile() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  return path.join(home, "dsh-po.log");
}

/**
 * 创建一个写文件的日志器。任何写盘失败都静默忽略 —— 诊断不能反过来把插件搞挂。
 *
 * @param {{file?: string, prefix?: string, maxBytes?: number}} [options]
 * @returns {{write: (message: string) => void, file: string}}
 */
export function createDiagnosticLog(options = {}) {
  const file = options.file || defaultLogFile();
  const prefix = options.prefix || "dsh-po";
  const maxBytes = Number(options.maxBytes) > 0 ? Number(options.maxBytes) : MAX_LOG_BYTES;

  const write = (message) => {
    try {
      // 超限就重建，避免日志无限增长。
      try {
        if (fs.statSync(file).size > maxBytes) fs.writeFileSync(file, "", "utf8");
      } catch { /* 文件不存在：继续 */ }

      const stamp = new Date().toISOString();
      fs.appendFileSync(file, `${stamp} [${prefix}] ${message}\n`, "utf8");
    } catch { /* 诊断失败不影响主流程 */ }
  };

  return { write, file };
}
