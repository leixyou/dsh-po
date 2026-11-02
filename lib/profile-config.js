/**
 * 读 profile `cordis.patch.yml` 里 dsh-po 条目的 `config` 子树。
 *
 * 用途：CLI 想复现“宿主里那套 rewrite 配置”时，必须拿到和宿主一样的值 ——
 * 尤其是 `rewrite.translate.key`，它可能是双引号跨行（行尾 `\` 续行）写的。
 * 仓库不引第三方 YAML 依赖，这里只实现这个文件实际用到的 YAML 子集：
 *
 *   - 缩进映射（`key:` + 更深的子行）
 *   - 双引号标量：支持行尾 `\` 续行（拼接时不加空格）与常见转义
 *   - 单引号标量（`''` 转义）
 *   - 裸标量：去行尾注释，识别 true/false/null/数字
 *
 * 遇到不认识的形状（列表、锚点、块标量）就跳过该键，不猜。
 */

import fs from "node:fs";
import path from "node:path";

/** 行首空格数。 */
function indentOf(line) {
  const match = /^( *)/.exec(line);
  return match ? match[1].length : 0;
}

/** 下一行“有内容”的行号（跳过空行与整行注释），没有则 -1。 */
function nextContentLine(lines, from) {
  for (let i = from; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    return i;
  }
  return -1;
}

/** 双引号/单引号标量的反转义（只处理这个文件会出现的那些）。 */
function unescapeQuoted(text, quote) {
  if (quote === "'") return text.split("''").join("'");
  return text.replace(/\\(.)/g, (_, ch) => {
    switch (ch) {
      case "n": return "\n";
      case "t": return "\t";
      case '"': return '"';
      case "\\": return "\\";
      default: return ch;
    }
  });
}

/**
 * 解析一个标量，可能吃掉后续续行。
 *
 * @param {string[]} lines 全文件按行拆分
 * @param {number} index 当前行
 * @param {string} rest 冒号后的原始文本
 * @returns {{value: unknown, next: number}} next 为下一处待解析行号
 */
function parseScalar(lines, index, rest) {
  const quote = rest[0];

  if (quote === '"' || quote === "'") {
    let buffer = rest.slice(1);
    let cursor = index;
    let collected = "";

    for (;;) {
      let end = -1;
      for (let i = 0; i < buffer.length; i += 1) {
        if (quote === '"' && buffer[i] === "\\") { i += 1; continue; }
        // 单引号里的 '' 是一个转义的单引号，不是结束
        if (quote === "'" && buffer[i] === "'" && buffer[i + 1] === "'") { i += 1; continue; }
        if (buffer[i] === quote) { end = i; break; }
      }
      if (end >= 0) {
        collected += buffer.slice(0, end);
        return { value: unescapeQuoted(collected, quote), next: cursor + 1 };
      }

      // 引号没闭合：YAML 折行。行尾 `\` 表示“直接拼接、不插空格”，否则补一个空格。
      const continued = buffer.endsWith("\\");
      const piece = continued ? buffer.slice(0, -1) : buffer;
      cursor += 1;
      if (cursor >= lines.length) return { value: unescapeQuoted(collected + piece, quote), next: cursor };
      collected += piece + (continued ? "" : " ");
      buffer = lines[cursor].trim();
    }
  }

  // 裸标量：去掉行尾注释
  const raw = rest.replace(/\s+#.*$/, "").trim();
  if (raw === "true") return { value: true, next: index + 1 };
  if (raw === "false") return { value: false, next: index + 1 };
  if (raw === "null" || raw === "~" || raw === "") return { value: null, next: index + 1 };
  if (/^-?\d+(?:\.\d+)?$/.test(raw)) return { value: Number(raw), next: index + 1 };
  return { value: raw, next: index + 1 };
}

/**
 * 解析一段缩进映射。
 *
 * @param {string[]} lines 全文件按行拆分
 * @param {number} start 起始行号
 * @param {number} indent 这一段所有键共用的缩进
 * @returns {{value: Record<string, unknown>, next: number}}
 */
function parseMapping(lines, start, indent) {
  const out = {};
  let i = start;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) { i += 1; continue; }

    const lineIndent = indentOf(line);
    if (lineIndent < indent) break;
    if (lineIndent > indent) { i += 1; continue; }

    const match = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(trimmed);
    if (!match) { i += 1; continue; }
    const key = match[1];
    const rest = match[2];

    if (rest === "" || rest.startsWith("#")) {
      const child = nextContentLine(lines, i + 1);
      if (child >= 0 && indentOf(lines[child]) > indent) {
        const parsed = parseMapping(lines, child, indentOf(lines[child]));
        out[key] = parsed.value;
        i = parsed.next;
      } else {
        out[key] = null;
        i += 1;
      }
      continue;
    }

    const scalar = parseScalar(lines, i, rest);
    out[key] = scalar.value;
    i = scalar.next;
  }

  return { value: out, next: i };
}

/**
 * 从 patch 文本里找出 dsh-po 条目的 config 块起始位置。
 *
 * @param {string[]} lines 全文件按行拆分
 * @returns {{index: number, indent: number} | null}
 */
export function findDshPoConfigBlock(lines) {
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^\s*-\s*(id|name):\s*["']?dsh-po["']?\s*$/.test(lines[i])) continue;
    const entryIndent = indentOf(lines[i]);
    for (let j = i + 1; j < lines.length; j += 1) {
      const trimmed = lines[j].trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const lineIndent = indentOf(lines[j]);
      if (lineIndent <= entryIndent) break; // 条目结束
      if (/^config:\s*(#.*)?$/.test(trimmed)) {
        const child = nextContentLine(lines, j + 1);
        if (child < 0 || indentOf(lines[child]) <= lineIndent) return { index: j + 1, indent: lineIndent + 2 };
        return { index: child, indent: indentOf(lines[child]) };
      }
    }
    return null;
  }
  return null;
}

/**
 * 读某个 profile 的 dsh-po 配置。
 *
 * @param {string} profileDir profile 目录（含 cordis.patch.yml）
 * @returns {{ok: boolean, path: string, config: Record<string, unknown>|null, reason: string|null}}
 */
export function readDshPoConfig(profileDir) {
  const file = path.join(profileDir, "cordis.patch.yml");
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    return { ok: false, path: file, config: null, reason: `读取失败: ${(error && error.message) || error}` };
  }

  const lines = String(text).split(/\r?\n/);
  const block = findDshPoConfigBlock(lines);
  if (!block) return { ok: false, path: file, config: null, reason: "没有找到 dsh-po 条目的 config 块" };

  const parsed = parseMapping(lines, block.index, block.indent);
  return { ok: true, path: file, config: parsed.value, reason: null };
}

export const YAML_SUBSET_NOTE =
  "只支持缩进映射与引号/裸标量；列表、锚点、块标量按不支持处理（跳过该键）。";
