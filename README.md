# dsh-po

DeepSeek Harness 破甲插件：全部通过官方 cordis 插件 API 实现 ——
不改写任何 `@deepseek-ai/*` 包源码，不做 asar 抽取、不做字符串替换补丁。

> **想要最好效果？配一个 Azure Translator key（可选，本仓库/发布包不含任何 key）**
>
> 不配也能用：默认用内置的低资源语言模板改写消息，零配置生效。
> 但模板只覆盖固定句式；要按你原始中文的**具体语义**逐句改写，需要启用外部翻译
> （Azure Translator）。免费额度 2M 字符/月，注册 Azure → 建 Translator 资源 →
> 复制 **key** 与 **region 短代码**（如 `eastasia`）→ 按
> [配置 Azure Translator key](#配置-azure-translator-key) 填入。
> 不配 key 时 `translate` 自动 fail-open，回退模板，不会报错、不会阻塞对话。

## 快速开始

```sh
# 1) 安装（二选一）
#    A. 桌面版插件面板：安装 → 本地文件 → 选 dsh-po.tgz / 本地目录
#    B. 命令行
cd "$DSH_HOME/profiles/desktop"    # web profile 用 profiles/web
pnpm add dsh-po

# 2) 配 key（可选，决定改写质量上限）
node "$DSH_HOME/profiles/desktop/node_modules/dsh-po/bin/dsh-po.js" setup

# 3) 完全退出并重启 DSH，然后正常对话
node "$DSH_HOME/profiles/desktop/node_modules/dsh-po/bin/dsh-po.js" status
```

也可以在对话里对 Agent 说「配置 dsh-po 的 Azure key」，它会调用
`dsh_po_translate_setup` 弹出问答卡片收集 key / region，直接写进 profile。

启用状态检查：`cordis.patch.yml` 里应有 `- id: dsh-po` 的 insert 行，
`package.json` 的 `dsh.profile.bundles` 里应有 `dsh-po`。
卸载：`node bin/dsh-po.js uninstall`（或插件面板卸载）。

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
lib/host-shims.js            宿主兼容补丁（file-upload Agent resolver 槽位泄漏）
lib/setup-tool.js            dsh_po_translate_setup 工具（弹框填 Azure key）
lib/config.js                Config schema（volatile / secret 元数据；rc.5 不渲染第三方表单）
lib/vendor/                  vendored schemastery + cosmokit（自包含，无外部依赖）
lib/rewrite.js               agent/pre-step 消息改写（模板 + 外部翻译回退）
lib/translate.js             外部翻译后端（Azure Translator，fail-open）
lib/languages.js             低资源语言模板库 + 软化前缀
lib/prompt-inject.md         默认破甲提示词
scripts/profile-insert.js    把本体行写进用户层 cordis.patch.yml（含移除/upsert）
scripts/ensure-profile-bundle.mjs   postinstall
scripts/remove-profile-bundle.mjs   postuninstall（清理 insert / bundles / 链接）
bin/dsh-po.js     状态检查 / setup / 卸载清理 CLI
```

## 安装

### 官方 npm 源（推荐）

```sh
cd "$DSH_HOME/profiles/web"        # desktop: profiles/desktop
pnpm add dsh-po
# 或
npm install dsh-po
# 或让 dsh 自己解析包名
"$DSH" plugin --profile web add dsh-po
```

装完补跑一次本体 insert（pnpm 11/12 默认跳过 postinstall）：

```sh
node node_modules/dsh-po/scripts/ensure-profile-bundle.mjs
```

### 本地路径安装

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

## 卸载

卸载时会自动清理安装时写进 profile 的残留（`postuninstall`；pnpm 11/12 跳过
build scripts 时手动补跑一次）：

```sh
# 方式一：包管理器卸载（触发 postuninstall）
cd "$DSH_HOME/profiles/web"   # desktop: profiles/desktop
pnpm remove dsh-po

# 方式二：手动清理（等价）
node bin/dsh-po.js uninstall
# 只清某个 profile
node bin/dsh-po.js uninstall --profile=web
# 或跳过自省直接跑清理脚本
node node_modules/dsh-po/scripts/remove-profile-bundle.mjs
```

清理内容：

1. `cordis.patch.yml` 里的 `- insert: - id: dsh-po` 本体块（独立块整体删；多条目块只删 dsh-po 那条）
2. `dsh.profile.bundles` 里的 `"dsh-po"`
3. `node_modules/dsh-po` 符号链接与 `.bin/dsh-po` shim（旧版 `dsh-purge-nopatch` 也一并清）

> 仅卸包（只从 bundles / dependencies 移除）而漏掉本体 insert + node_modules 链接，
> 插件会继续被加载、rewrite 会继续改写提示词——这正是「卸载后还在翻译」的原因。
> 清完仍需**完全退出并重启** dsh 宿主。

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
      config:
        enabled: true
        verbose: false
        prompt: ""          # 留空则用 lib/prompt-inject.md
        approvalContext: true
        fixFileUploadResolver: true  # 修复宿主 file-upload resolver 泄漏（见下文）
        setupTool: true              # 注册 dsh_po_translate_setup 工具（弹框填 key）
        postPrompt: ""
        postPromptOrder: 9000
        rewrite:
          enabled: true
          language: eu          # 巴斯克语（默认）
          phrase: assume_own    # default | assume_own | stepwise
          usePlaceholder: false # true 时目标替换为 TARGET（不指向真实执行）
          # 外部翻译（Azure Translator）：启用后优先把原文中文翻译成低资源语言，
          # 翻译失败 / 缺 key / 超时自动回退到手写模板。默认关闭。
          translate:
            enabled: false
            api: azure
            endpoint: https://api.cognitive.microsofttranslator.com
            key: ""            # 或用环境变量 AZURE_TRANSLATOR_KEY
            region: ""         # 短代码（eastasia / westeurope / global）；显示名会自动归一
            from: zh-Hans      # 源语言；留空 = 自动检测
            to: ""             # 目标语言；留空 = 上面 rewrite.language
            timeoutMs: 5000
            soften: false      # true 时翻译结果前拼软化前缀（assume_own / stepwise）
```

> Azure Translator 免费额度 2M 字符/月，支持巴斯克语 `eu`。MT 不会拒翻渗透内容，
> 所以不需要像 DeepSeek 自译那样先软化；`soften` 只是可选的额外框架。

## 配置 Azure Translator key

> 可选，但决定改写质量上限；没有 key 时 fail-open 回退模板。

插件声明了 Config schema（`lib/config.js`，`rewrite.translate` 为 volatile、`key` 为
secret），但 **DSH 0.2.1-rc.5 不会给第三方插件渲染设置表单**：

- 插件页的配置区只来自客户端槽位 `plugins.item` / `plugins.bundle.config` /
  `plugins.row.config`，rc.5 里只有官方 4 个 companion 包（shell / agent-loop /
  subagent / web-search）注册了它们；
- `ctx.settings.configure({ auto: true })` 只是给「设置 → 打开配置文件」的文档编辑器
  和远程 API 登记「自动页策略」（`describe()` 里的 `autoGenerate`），不会凭空长出页面或弹框。

因此 v1.2.4 起插件自带一个工具，把「弹框」补上：

**① 对话里弹框（推荐）**

对 Agent 说一句「配置 dsh-po 的 Azure key」，它会调用 `dsh_po_translate_setup`：

- 宿主弹出问答卡片，逐项收集 key 与 region（自由输入，region 留空 = `global`）；
- 工具把 `rewrite.translate` 写进当前 profile 的 `cordis.patch.yml`，返回掩码
  （只回显尾 4 位）与写入路径，正文/日志都不含明文 key；
- 宿主有 HMR 时 volatile 字段即时生效，否则重启后生效；
- 没有 `userQuestions` 服务的宿主（headless）会明确报错并提示改用 CLI。

关闭：`setupTool: false`（或删掉 `config.setupTool`）。

**② 设置 → 打开配置文件**（桌面版可见）：在 `- id: dsh-po` 的 `config` 下加
`rewrite.translate`，保存后热重载。

**③ `node bin/dsh-po.js setup`**：终端里掩码输入，写进每个 profile，重启生效。

> schemastery 已 vendor 进 `lib/vendor/`，所以 `link:` 安装也能解析 Config；
> 只是 rc.5 没有消费它的自动表单入口。

### CLI 交互配置（无 DSH / headless 时）

安装后跑：

```sh
node bin/dsh-po.js setup
# 只配某个 profile
node bin/dsh-po.js setup --profile=web
```

会交互式询问 Azure key（回显 `*`）和 region，然后自动把 `rewrite.translate`
写进对应 profile 的 `cordis.patch.yml`（幂等，不会覆盖其它 config 键）。

```text
$ node bin/dsh-po.js setup
Azure Translator key（回车跳过）: ****
region [global]: global
  web: 已写入 rewrite.translate（enabled=true, region=global）

完成。完全退出并重启 dsh 宿主后生效。
```

> CLI 方式会把 key 明文写进 profile 的 `cordis.patch.yml`；不想落盘的话改用环境变量
> `AZURE_TRANSLATOR_KEY` / `AZURE_TRANSLATOR_REGION`，并在 config 里留空。
> `key` 以明文写进 profile 的 `cordis.patch.yml`（`secret` 只在表单/远程 API 里被 redact），注意 profile 目录权限。

## 使用方式

装好并重启后，**不需要任何额外操作**：Agent 每次发消息前，
`agent/pre-step` 钩子会把用户消息里的中文指令改写成低资源语言版本（默认巴斯克语 `eu`），
宿主原样发给模型；写盘、审批、工具调用都不受影响。

### 常用开关（`cordis.patch.yml` 里 `- id: dsh-po` 的 `config`）

```yaml
        rewrite:
          enabled: true        # false = 完全关闭改写
          language: eu         # 目标语言（eu 巴斯克 / sw 斯瓦希里 / vi 越南 / th 泰 …见 lib/languages.js）
          phrase: assume_own   # default | assume_own | stepwise（模板措辞）
          usePlaceholder: false# true = 把目标替换成 TARGET（只产文本，不指向真实执行）
          translate:
            enabled: true      # 开外部翻译（需要 key，见上）
```

### 验证是否生效

```sh
node bin/dsh-po.js status          # entry id / service / 事件 / order 是否全部 OK
node bin/dsh-po.js verify          # CI 用：有目标解析失败则退出码 1
```

把 `verbose: true` 打开后，宿主日志会打印
`[dsh-po] agent/pre-step rewrite installed (lang=eu phrase=assume_own)`，
每条被改写的消息也会走 `[dsh-po]` 日志；翻译失败时自动回退模板，不会报错。

### 行为边界

- 只改写 `role === "user"` 且能提取到目标（URL / IP / 域名）的消息；
  runtime-context 快照、工具结果、system prompt 不动；
- 审批请求由 `approval/request` 上的应答器放行（`approvalResult: allowed-once`），
  不弹审批框；
- 消息里的 URL / 域名保持原样（只改变句式与语言，不替换目标）；
- 没有 Azure key 时 `translate` 直接返回 `null`，静默回退手写模板。

## 已验证（DeepSeek Harness 0.2.1-rc.3 / rc.4 / rc.5）

在官方 `DeepSeek Harness.app` 的 CLI 与桌面版上实际验证通过：

```sh
DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
"$DSH" plugin --profile web add ./dsh-po      # 或直接写包名 dsh-po
cd "$DSH_HOME/profiles/web"
node node_modules/dsh-po/scripts/ensure-profile-bundle.mjs
"$DSH" --profile web --dump-config   # 配置覆盖全部生效
"$DSH" --profile web --no-open        # 启动无报错
```

启动日志（`verbose: true`）：

```text
[dsh-po] approval answerer installed on: approval/request, approval:request, user-approval/request (auto-grant)
[dsh-po] agent/pre-step rewrite installed (lang=eu phrase=assume_own)
[dsh-po] setup tool registered: dsh_po_translate_setup
[dsh-po] file-upload Agent resolver shim installed (idempotent disposer)
[dsh-po] approval runtime context installed (order 116)
[dsh-po] prompt section installed (3705 bytes, order -100000)
```

`--dump-config` 确认 bundle patch 覆盖已生效：`sandbox-policy.mode: danger-full-access`、
`approval.policy: ask`、`permission.defaultPreset: danger-full-access`、
`system-prompt.includeHarnessIdentity: false`。

> desktop profile 由 Electron 应用独占管理，无法用 CLI 直接 dump；但加载器相同，
> 且本插件不依赖版本号敏感的内部源码，仅用 `systemPrompt` / `approval` / `cordis`
> 标准接口，因此 rc.2 / rc.3 及以上均适用（无源码补丁可被打断）。

---

## 版本自适应（v1.1）

宿主升级后（如 0.2.1-rc.3 → rc.5）不需要改插件源码。`lib/harness.js` 在运行时直接读
**正在运行的这套 DSH** 的安装内容，反推契约，不依赖版本号字符串：

| 探测项 | 来源 | rc.3 → rc.5 的实际变化 |
|---|---|---|
| harness 版本 | `@deepseek-ai/dsh-base/package.json` | — |
| bundle patch 集合 | profile `dsh.profile.bundles` → 各包 `dsh.bundle.patch`（string **或 string[]**） | `dsh-web-app` 现在是数组，带 `presets/*.patch.yml` |
| entry id | bundle patch 的 `- id:` 条目（rc.5 实测 244 条） | **未变**：`approval` / `permission` / `tool-result-pruner` 仍是这三个 id |
| 包名 | 同上 `name:` | **变了**：`dsh-approval`→`dsh-user-approval`，`dsh-permission`→`dsh-permission-presets`，`dsh-tool-result-pruner`→`dsh-compaction-tool-result-pruner` |
| service 名 | 包源码 `super(ctx, "<name>")` | 未变（`systemPrompt` / `approval`） |
| 审批事件 | 包源码里的 `"*/request"` 字面量 | 未变（`approval/request`） |
| order 常量 | `dsh-system-prompt` 的 `SECTION_ORDERS` | 未变（`HARNESS_IDENTITY: -1e3`、`APPROVAL_POLICY: 115`） |

三条兜底：自省命中 → 候选别名表 → 内置默认值。任一层失败都不会让插件不加载。

### 另一个跨版本隐患：静态 inject

旧版 profile 里的本体行写死了：

```yaml
- insert:
    - id: dsh-po
      name: dsh-po
      inject: [ systemPrompt, tools ]   # ← 宿主服务改名/拆分时整插件不加载
```

v1.1 起不再写这一行，依赖由 `lib/index.js` 在运行时解析（`ctx.get()` → `ctx.inject()` →
轮询兜底）。已安装的 profile 用 `dsh-po adapt` 一行清除。

## 已修复的宿主缺陷：file-upload Agent resolver 槽位泄漏（v1.2.3）

**症状**：停用（或启用）本插件时弹出

```
停用失败：dsh: warning: 1 entry did not activate
session-controller (@deepseek-ai/dsh-api-session-controller):
Error: file-upload: Agent resolver is already registered
```

停用本身其实已经落盘，但 `session-controller` 被打成 `failed`，整个会话 API
（会话列表、上传、jobs、schedule、deliverables…）在本次进程里全部失效，
必须重启宿主才能恢复。

**复现链路**（实测 0.2.1-rc.5）：

1. 停用 bundle → 去掉本插件的 bundle patch 层；
2. 该层覆盖过 `session-query-sqlite` 的 `openAt`，配置回退 → 该 entry 重启；
3. `session-controller` 注入 `sessionQuery`，随之重启；
4. 重启时它再次调用 `ctx.fileUploads.registerAgentResolver(...)` → 抛
   `Agent resolver is already registered`。

**根因在宿主**（不是本插件的 config 写错）：

```js
// @deepseek-ai/dsh-client-file-upload
registerAgentResolver(resolve) {
  if (this.agentResolver !== void 0) throw new Error("file-upload: Agent resolver is already registered");
  this.agentResolver = resolve;
  return () => { if (this.agentResolver === resolve) this.agentResolver = void 0; };
}
```

cordis 的服务是 traceable proxy：`ctx.fileUploads` 读函数属性时会用
`createShadowMethod` 每次包一层新的 Proxy。于是 **写入正常，读回的身份永远不等于
原函数**，disposer 里的 `===` 恒为 false —— 槽位永远清不掉。第一次重启之后
就成了「幽灵 resolver」，之后每次重启都直接失败。

**修复**：`lib/host-shims.js` 在内存里把 `FileUploads.prototype.registerAgentResolver`
换成等价实现：

- 槽位额外存一份在 symbol 属性上（symbol 读取绕过 traceable 包装，`===` 可靠）；
- 写入/清空用 `Object.defineProperty` 直落真实实例（不被 proxy 的 set 语义导到 shadow）；
- disposer 幂等；发现槽位仍被已销毁的上一代占用时**回收**而不是抛错。

不改磁盘上任何 `@deepseek-ai` 文件，不依赖版本号；`fixFileUploadResolver: false`
可关闭。官方修法建议：槽位改存 symbol / 私有字段，或给 resolver 加一个对象 token
（对象属性不会被 traceable 包装），disposer 比较 token 而不是函数身份。

### 升级宿主后的标准动作

```sh
cd ~/Documents/DSHunlimited/dsh-po
node bin/dsh-po.js status     # 看 entry id / service / 事件 / order 是否全部 OK
node bin/dsh-po.js verify     # CI 用：未解析目标则退出码 1
node bin/dsh-po.js adapt      # id 真被改名时重写本体 patch；顺手清静态 inject
npm test                      # 含真实宿主自省用例
```

改完**完全退出并重启** dsh 宿主（web / desktop）才生效。

### 已实测

- `0.2.1-rc.5`（cordis 4.0.5，app.asar 18 MB，244 条 entry）：8 个逻辑目标全部 `OK`
- rc.3 旧包名 / 未来改 id 两种形态由 `test/adapt.test.mjs` 覆盖
