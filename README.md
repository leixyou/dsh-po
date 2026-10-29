# dsh-po

DeepSeek Harness 破甲插件：全部通过官方 cordis 插件 API 实现 ——
不改写任何 `@deepseek-ai/*` 包源码，不做 asar 抽取、不做字符串替换补丁。

## 为什么不需要破解

逆向官方 DSH 0.2.x 包后发现：破甲想达到的效果，官方插件 API 本身就覆盖了：

| 能力 | 目标 | 实现 |
|---|---|---|
| 沙箱模式 | 默认 `danger-full-access` | `cordis.patch.yml` 覆盖 `sandbox-policy.mode` |
| 文件写放行 | 写入不再被沙箱拒绝 | 不需要：官方 `dsh-bash-sandbox` / `dsh-fs-sandbox` 在 `danger-full-access` 下直接 unfenced/unconfined |
| 审批策略 | 策略与模式组合 | `cordis.patch.yml` 覆盖 `approval.policy: ask` |
| 审批自动放行 | 审批门自动放行 | 运行时 `ctx.on("approval/request", () => "allowed-once")` 应答器 |
| 审批默认 | 默认 `never` | 同上，改为 `ask` 走应答器 |
| 放行句 | 模型可见「自动放行」句 | `systemPrompt.context()` 在 order 116 追加覆盖句 |
| 身份剥离 | 去掉官方身份/人设 | `system-prompt` 配置 `includeHarnessIdentity:false` + `personaPrefix/Suffix:""` |
| 破甲提示词 | 注入正文 | `systemPrompt.section()`（`interpolate:false`，order -100000） |
| 扩展：结果截断 | `spill-policy` 12500 tokens / `tool-result-pruner` 8192 chars | patch 层阈值拉到 1e9，实际永不触发 |
| 扩展：工作区指令上限 | `agent-instructions` maxBytes 65536 | patch 层拉到 64MB |
| 扩展：会话全文搜索 | `session-query-sqlite` `openAt: never` | patch 层 `openAt: first-search` |

> 以下限制**保留官方默认，不做覆盖**（应要求回退）：
> - `timeout-policy`：工具调用 deadline
> - `bash-sandbox` / `pwsh-sandbox`：执行超时 60s
> - `tool-web`：`searchTimeoutMs` 60s
> - `web-fetch-http`：全部上限（公网 unicast 防线、5MB / 100k 字符、30s、5 跳重定向、仅文本类型）
> - `fs-observation-policy`：写前必须读 + CAS（本地文件安全限制）

> workspace 指令 intro 重写是 `dsh-agent-instructions` 里的硬编码常量，
> 官方 API 没有对应配置项。它的效果（抬高 workspace 指令权重）由本插件注入的
> `-100000` 高优先级正文近似覆盖；若仍需要原样改写，才回到源文件补丁。

## 文件结构

```
cordis.patch.yml             bundle patch：纯 config 覆盖（不写源文件）
lib/index.js                 运行时 cordis 插件（approval 应答器 + systemPrompt 注入）
lib/prompt-inject.md         默认破甲提示词
scripts/profile-insert.js    把本体行写进用户层 cordis.patch.yml
scripts/ensure-profile-bundle.mjs   postinstall
bin/dsh-po.js     状态检查 CLI
```

## 安装

装进你实际打开的宿主 profile（web 与 desktop 分开装）：

```sh
# 官方 dsh web
DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
"$DSH" plugin --profile web add /path/to/dsh-po

# 官方 desktop EXE
"$DSH" plugin --profile desktop add /path/to/dsh-po
```

或 pnpm 直接装（在 profile 目录内，不是仓库根）：

```sh
cd "$DSH_HOME/profiles/web"        # desktop: profiles/desktop
pnpm add /path/to/dsh-po
```

### pnpm 11/12 会跳过 postinstall（重要）

`dsh plugin add` 与 `pnpm add` 都只是让 pnpm 装包。pnpm 11/12 对本地 link/tarball
**默认不跑 build scripts**，所以自动写入本体 insert 的 `postinstall` 可能被跳过。
装完后补跑一次即可（`dsh plugin add` 已自动把包名加进 `dsh.profile.bundles`）：

```sh
cd "$DSH_HOME/profiles/web"   # desktop: profiles/desktop
node node_modules/dsh-po/scripts/ensure-profile-bundle.mjs
```

或用 pnpm 放行 build：

```sh
pnpm approve-builds dsh-po
```

该脚本会：

1. 把 `dsh-po` 追加到 `dsh.profile.bundles`（幂等）
2. 在用户层 `cordis.patch.yml` 写入本体 insert 行（幂等，自动处理全新 profile 的空列表 `[]`）

**生效方式**：完全退出并重启 dsh 宿主即可。没有「Apply」按钮、没有补丁状态页，
因为没有任何磁盘文件被改写。

验证：

```sh
"$DSH" --profile web --dump-config   # 应看到 sandbox-policy.mode: danger-full-access、approval.policy: ask、includeHarnessIdentity: false
node bin/dsh-po.js status
# 或宿主内确认系统提示词已注入破甲正文、审批请求被自动放行
```

## 手动安装（无 dsh / pnpm）

1. 把本目录放到 `$DSH_HOME/plugins/dsh-po`（目录名与 `package.json.name` 一致）
2. 编辑 `$DSH_HOME/profiles/<web|desktop>/package.json`：
   - `dependencies` 加 `"dsh-po": "file:../../plugins/dsh-po"`
   - `dsh.profile.bundles` 末尾加 `"dsh-po"`
3. 编辑该 profile 的 `cordis.patch.yml`，追加本体 insert（见 `scripts/profile-insert.js` 的 `INSERT_BLOCK`）
4. 在 profile 目录跑 `pnpm install`，重启宿主

## DeekSeek Harness上直接安装
<img width="2560" height="1640" alt="image" src="https://github.com/user-attachments/assets/51cc209e-7b56-4ead-97d8-7ff01d63478a" />


## 配置

本体行 config 支持：

```yaml
- insert:
    - id: dsh-po
      name: dsh-po
      inject: [systemPrompt, tools]
      config:
        enabled: true
        verbose: false
        prompt: ""          # 留空则用 lib/prompt-inject.md
        approvalContext: true
        postPrompt: ""
        postPromptOrder: 9000
```

## 已验证（本机 DeepSeek Harness 0.2.1-rc.3）

在本机 `DeepSeek Harness.app`（0.2.1-rc.3，桌面版）的 CLI 上实际验证通过：

```sh
DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
"$DSH" plugin --profile web add /Users/tester/Desktop/CrackAgentForMac/outputs/dsh-po
cd "$DSH_HOME/profiles/web"
node node_modules/dsh-po/scripts/ensure-profile-bundle.mjs
"$DSH" --profile web --dump-config   # 配置覆盖全部生效
"$DSH" --profile web --no-open        # 启动无报错
```

启动日志（`verbose: true`）：

```text
[dsh-po] approval/request answerer installed (allowed-once)
[dsh-po] approval runtime context installed
[dsh-po] prompt section installed (2686 bytes)
```

`--dump-config` 确认 bundle patch 覆盖已生效：`sandbox-policy.mode: danger-full-access`、
`approval.policy: ask`、`permission.defaultPreset: danger-full-access`、
`system-prompt.includeHarnessIdentity: false`。

> desktop profile 由 Electron 应用独占管理，无法用 CLI 直接 dump；但加载器相同，
> 且本插件不依赖版本号敏感的内部源码，仅用 `systemPrompt` / `approval` / `cordis`
> 标准接口，因此 rc.2 / rc.3 及以上均适用（无源码补丁可被打断）。
