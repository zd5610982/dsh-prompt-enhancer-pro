# dsh-prompt-enhancer

> **说明**：这是公开发布前的内部工程记录，保留了当时的原始命名（`@local/dsh-prompt-enhancer`、
> 路由 `/plugins/dsh-prompt-enhancer`、日志 `prompt-enhancer-boot.log`）。
> 公开发布版已改名为 `dsh-prompt-enhancer-pro`，对应路由与日志路径均加 `-pro` 后缀，
> 原因见 [`../README.md`](../README.md)。下文的技术结论依然有效，只是标识符不同。

把 **WorkBuddy 的「增强提示词」** 做成 DeepSeek Harness 原生插件：在输入框旁边点一下，
把随手写的草稿改写成结构完整、要求明确的提示词，再写回输入框。

- 改写引擎在**宿主半**（`lib/index.js`，走 `ctx.llm.stream`）
- 按钮在**浏览器半**（`lib/client.js`，注册进 `conversation.input.right`）
- 纯逻辑抽在 `lib/core.js`，零依赖、可单测

> **说明**：WorkBuddy 本体（`D:\WorkBuddy`）在本机已不存在，因此原版那段 2425 字符的
> 指令无法逐字取得。本插件的提示词是按同一目标重写的独立版本，不是复刻原文。
> 引擎里的关键行为（首尾引号清理、语言一致、只输出改写结果）与 WorkBuddy 一致。

## 当前状态（本机实测）

已装进 `~/.dsh/profiles/desktop`：

| 环节 | 状态 | 证据 |
|---|---|---|
| 宿主半挂载 + 路由 | ✅ | `~/.dsh/prompt-enhancer-boot.log` 有 `apply() entered` / `HTTP routes mounted` |
| `status` 接口 | ✅ | `GET /plugins/dsh-prompt-enhancer/status` → 200 |
| 真实改写（三种风格） | ✅ | 返回中文强化提示词；`provider=deepseek-account model=deepseek-flash` 自动解析成功 |
| 浏览器半进入模块图并被服务 | ✅ | 复算 combo URL → 200，正文含 `factory` / `exports.apply`（字节数以实测为准，随源码变化） |
| 服务端脚本可执行 | ✅ | 在 vm 沙箱执行：只注册 1 个模块、id 正确、只有 React 可用时 factory 正常 |
| 离线测试 | ✅ | 全套通过（core 73 / client 55 / host 45 / profile 25；跑 `run-all.mjs` 看实测数字） |
| 宿主半冷启动（真实 Cordis） | ✅ | `test/cordis.test.mjs` 6 项：entry 达到 ACTIVE、服务后到时正确等待、disposer 契约、重复挂载防护 |
| 浏览器半冷启动（真实 Cordis） | ✅ | `test/cordis-client.test.mjs` 5 项：达到 ACTIVE、重复执行是 no-op、teardown 后可重挂 |
| 运行实例已服务修复版 bundle | ✅ | 复算 combo URL 取的响应里含两个守卫与 `inject = ['slots','locale']`（与磁盘一致） |
| 在线测试 | ✅ | `node test/live.test.mjs --enhance` → 10 项全过 |
| 冷启动不再报错 | ⏳ | **待重启验证**（我无法重启宿主） |
| 界面上的按钮 | ⏳ | 需**刷新页面**（浏览器半在页面启动时注册进模块图）；刷新后见输入框工具栏、模型选择器左侧 |

> 浏览器半是在**页面加载时**进入启动模块图的，所以插件生效后要刷新一次页面。

### ⚠️ 已修复：冷启动时条目激活失败（两次事故，两个不同的根因）

**症状**（两次完全相同的报错）：重启 DSH 后弹出「禁用插件并重启」，崩溃日志
（`%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*-web-boot.log`）写着：

```
Error: web boot: 1 entry did not activate
@local/dsh-prompt-enhancer: failed
```

这条消息来自**渲染端 boot 内核**的检查函数（`dsh-web-frontend`）：

```js
const u = A7[s.fiber.state]                       // 状态名
if (u !== "active")
  if (u === "pending") o.push(`${a}: pending (waiting for service: …)`)
  else o.push(`${a}: ${u}`)                       // → "@local/...: failed"
```

要点：它打印的是**条目的 fiber 状态**。`fiber === undefined` 会打印
`import failed: <详情>`；而这里走 else 分支，说明 **fiber 存在但 `_error` 被设了** ——
即**插件体 `apply()` 抛错**。

#### 根因一（宿主半）：用裸 `ctx.inject` 去够尚未就绪的服务

插件原来导出 `inject = []`，用**裸 `ctx.inject(['webServer'], …)`** 等后来才挂载的 web
服务。`ctx.inject(inject, callback)` 在 Cordis 里是**创建一个子 plugin fiber**
（源码 `context.ts`：`inject()` → `this.plugin({ inject, apply: callback })`）。父条目注入集
为空时它的 epoch 永不变化，服务只能靠这个子 fiber 去够，条目最终被判 inactive。
**修法**：`export const inject = ['webServer']`，让 Cordis 自己等；不再用裸 `ctx.inject`。

#### 根因三（浏览器半 · 控件不可见）：`useInput` 必须传 selector

槽位 props 里的 `useInput` 不是普通 hook，而是 `useSyncExternalStoreWithSelector` 的派生
选择器钩子 —— 它会**调用**你交给它的 selector，空参调用时在 React 内部抛：

```
TypeError: l is not a function
  at Object.useSyncExternalStore
  at exports.useSyncExternalStoreWithSelector
  at useSelector
  at PromptEnhancer
```

真实前端里每一处调用都是 `useInput((s) => s)`。这个异常会被**槽位运行时的 ErrorBoundary
捕获**，只留下一个空的 `data-slot-error` div —— 界面上什么都没有、控制台只有压缩过的堆栈、
日志里没有记录。这就是「心跳说 `control=yes`（注册成功）但按钮看不见」的原因。

**修法**：`useInput((state) => state)`，并把它包在 `readInput()` 里兜底。

```html
<div data-slot="conversation.input.right" style="display: contents;">
  <div data-slot-error="conversation.input.right"></div>
</div>
```

**教训**：测试桩里的 `useInput: () => state` 太宽松，把这个 bug 盖住了。现在桩改成忠实模拟
`useSyncExternalStoreWithSelector`（**不传 selector 就抛**），去掉修复后 7 项测试立刻失败：

```
FAIL the component reads input through a selector, as the real hook requires
     useInput was called without a selector
TypeError: useSyncExternalStoreWithSelector: selector must be a function
```

#### 根因二（浏览器半）：重复注册 locale 命名空间

`dsh-client-locale` 的 `register()` **明确拒绝重复注册同一个命名空间**：

```js
for (const [locale] of pairs)
  if (locales.has(localeKey(locale)))
    throw new Error(`locale namespace "${ns}" already has locale "${locale}"`);
```

原实现每次 `apply` 都注册一遍 `promptEnhancer` 命名空间。第二次注册就会**抛错** →
fiber 变 FAILED → **渲染端**启动审计失败 → 整个页面启动中止（这也解释了为什么两次事故
弹出的都是「禁用插件并重启」而不是宿主警告）。

**因果验证**（不是推测）：把守卫从 bundle 里去掉后重跑测试，**精确复现**了原错误 ——
在离线测试与**真实 Cordis 引擎测试**里都是同一条消息：

```
FAIL a repeat activation pass does not throw on the locale registry
     the repeat pass threw: Error: locale namespace "promptEnhancer" already has locale "zh"
```

加上守卫后通过。

**诚实说明边界**：我证明了「重复注册会精确产生该错误，且守卫能消除它」；我也用真实
Cordis 实测了 `apply` 的正常执行次数 —— 正常生命周期里 Cordis **只调用一次** `apply`
（首次执行就等到全部注入就绪；epoch 退回 INACTIVE 后插件即 DISPOSED，不再有第二次）。
所以「冷启动必然触发第二次 `apply`」这一步**我无法在离线环境复现**。为此又加了两道防线：

- **兜底 try/catch**：浏览器半的 `apply` 整体包在 `try/catch` 里。注册 UI 是 best-effort，
  **一个加按钮的插件绝不该有能力阻止整个应用启动**。
- **诊断回传**：兜底捕获到的错误会 `console.error`，并 POST 到宿主半的
  `/plugins/dsh-prompt-enhancer/client-error`，写进
  `~/.dsh/prompt-enhancer-boot.log`（`CLIENT FAILURE: …`）。这样下一次若还有问题，
  真实原因会直接落在日志里，不必再去翻渲染端控制台。

> **为什么热加载时看不出来**：热加载路径下客户端 `apply` 从未执行过；只有冷启动才会走到
> 客户端注册。这就是「边跑边装正常、一重启就炸」的原因。

#### 全部修法（宿主半 + 浏览器半）

| # | 位置 | 修法 |
|---|---|---|
| 1 | 宿主半 | `export const inject = ['webServer']` —— 让 Cordis 自己等服务，不再用裸 `ctx.inject` |
| 2 | 宿主半 | `apply` 全程不抛错；webServer 不可用时只记日志并降级 |
| 3 | 宿主半 | `apply` 返回 disposer（Cordis 惯用法） |
| 4 | 宿主半 | 按**模块级单一槽位**做幂等（不能用服务对象当 Map 键，见下） |
| 5 | 浏览器半 | 字典注册与槽位注册都加**一次性守卫**，重复激活是 no-op |
| 6 | 浏览器半 | `exports.inject = ['slots', 'locale']` —— 同样交给 Cordis 等服务 |
| 7 | 浏览器半 | **兜底 `try/catch`：注册失败只上报，绝不逃逸**（加按钮的插件不该能阻止应用启动） |
| 8 | 宿主半 | 新增 `POST /plugins/dsh-prompt-enhancer/client-error`，把浏览器端失败写进 boot log |

> 另一个坑：**不能拿服务对象当 Map 键**做去重。Cordis 每次读取服务都返回**新的 Proxy**
> （实测 `root.webServer === root.webServer` 为 `false`），对象键永远匹配不上，会静默地
> 重复注册。所以宿主半的幂等用的是模块级单一槽位。

**顺带的发现**：点「禁用插件并重启」时，DSH 会把 profile 的
`dsh.profile.bundles` 和 `cordis.patch.yml` 重写成一套默认值。本例中就因此**丢掉了另外三个
experimental bundle 和几项设置**（已恢复）。备份在 `package.json.bak-*`、
`cordis.patch.yml.bak-*`。

---

## 一、功能

| 功能 | 说明 |
|---|---|
| **增强按钮** | 挂在 `conversation.input.right` 槽，渲染在模型选择器**左侧** |
| **一键改写** | 读当前草稿 → 调模型改写 → 写回输入框 |
| **恢复原文** | 增强后按钮变「恢复原文」，一键退回改写前内容 |
| **可取消** | 增强进行中再点一次即取消请求（AbortController） |
| **风格选择** | 右键按钮打开菜单：默认改写 / 结构化 / 精简 / 扩充 |
| **安全护栏** | 空草稿不调模型；改写期间你若继续打字，结果自动丢弃，绝不覆盖新内容 |
| **状态反馈** | 空闲 / 进行中 / 可恢复 / 出错 四态 |

## 二、结构

```
dsh-prompt-enhancer/
├── package.json          dsh.bundle.patch + dsh.client 声明，exports["./client"]
├── cordis.patch.yml      插件自己的加载层（一个 insert）
├── lib/
│   ├── core.js           引擎：风格、提示词组装、流式收集、结果清理（零依赖）
│   ├── schema.js         Standard Schema v1 配置校验 + 配置解析
│   ├── patch-yaml.js     patch 层用的极简 YAML 解析（预检用）
│   ├── index.js          宿主半：HTTP 路由、provider 解析、调 ctx.llm.stream
│   └── client.js         浏览器半：手写 lazy-CJS bundle，只 require('react')
└── test/
    ├── core.test.mjs          54 项：引擎、提示词分层、长度兜底、配置
    ├── client.test.mjs        27 项：bundle 契约、重复激活守卫、兜底、控件行为
    ├── host.test.mjs          45 项：真实 HTTP 往返、诊断路由、降级与错误路径
    ├── cordis.test.mjs         6 项：宿主半在真实 Cordis 下的冷启动 / 激活 / 幂等
    ├── cordis-client.test.mjs  5 项：浏览器半在真实 Cordis 下的激活 / 重复执行 / 守卫
    ├── profile.test.mjs       25 项：装载预检（bundle 解析、patch 层、YAML）
    ├── live.test.mjs          10 项：对正在运行的 DSH 做端到端验证
    ├── react-stub.js           无 React 依赖的测试桩
    ├── bundle-harness.js       按模块加载器的方式执行 client.js
    └── run-all.mjs             一次跑完离线六套
└── tools/
    └── after-restart.ps1       重启后的一键验证脚本（检查崩溃日志、激活、路由、诊断）
```

## 三、跑测试

```powershell
node test/run-all.mjs
```

期望输出：

```
### core.test.mjs
    core + schema: 73 passed, 0 failed
### client.test.mjs
    client bundle: 55 passed, 0 failed
### host.test.mjs
    host integration: 45 passed, 0 failed
### cordis.test.mjs
    cordis cold boot: 6 passed, 0 failed
### cordis-client.test.mjs
    cordis client boot: 5 passed, 0 failed
### profile.test.mjs
    profile pre-flight: 25 passed, 0 failed

ALL SUITES PASSED
```

合计 **198 项断言**（另有 11 项真实 Cordis 测试在引擎可解析时运行）。其中 `cordis.test.mjs` 与 `cordis-client.test.mjs` 需要能解析到
app 自带的 `@deepseek-ai/cordis`（插件本身不带依赖）；解析不到时它们打印 SKIPPED 并返回
成功。要跑这两套，让安装目录的 `node_modules` 出现在解析路径上即可，例如把 app 的
`node_modules` 暴露为插件旁边的 `node_modules`。

以上六套不需要 DSH 在运行。对**正在运行的 DSH** 做端到端验证用：

```powershell
node test/live.test.mjs
```

它会：探测 `status` 路由；用 DSH 自己的哈希算法（`framedHash` / `artifactRevision`）
复算出真实的 combo URL；请求该 combo 并在 vm 沙箱里执行，确认只注册一个模块、
id 正确、factory 在**只有 React 可用**时能跑通、导出 `apply` / `inject` / `PromptEnhancer`；
最后可选地发一次真实改写请求（加 `--enhance`）。

## 四、安装（两种方式）

插件是一个 **profile bundle**：`package.json` 里的 `dsh.bundle.patch` 指向自己的
`cordis.patch.yml`，profile 通过 `dsh.profile.bundles` 引用它。

### 方式 A：`dsh plugin install`（推荐，需先完全退出 DSH）

```powershell
# 1) 完全退出 DeepSeek Harness（托盘也要退出）
# 2) 安装（路径必须写绝对路径）
& "C:\Users\谢荣荣\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" `
    plugin --profile desktop install "C:\Users\谢荣荣\Documents\deepseek-harness\default-workspace\dsh-prompt-enhancer"

# 3) 重新启动 DeepSeek Harness
```

`dsh plugin` 会跑 pnpm 装依赖，并**自动**把 `@local/dsh-prompt-enhancer`
追加进 `~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles`
（见 `dsh-plugin-manager` 的 `reconcile()`：新增依赖若声明了 `dsh.bundle` 就登记为 profile 层）。

### 方式 B：手动接线（不想跑 pnpm）

```powershell
$plugin  = "C:\Users\谢荣荣\Documents\deepseek-harness\default-workspace\dsh-prompt-enhancer"
$profile = "$env:USERPROFILE\.dsh\profiles\desktop"

# 1) 建 junction，让 loader 的 createRequire(profile/package.json) 能解析到包
New-Item -ItemType Directory -Force -Path "$profile\node_modules\@local" | Out-Null
New-Item -ItemType Junction -Path "$profile\node_modules\@local\dsh-prompt-enhancer" -Target $plugin

# 2) 登记 bundle + link 依赖（只需做一次）
#    在 $profile\package.json 里加：
#      "dependencies": { "@local/dsh-prompt-enhancer": "link:<上面的 $plugin 绝对路径>" }
#      "dsh": { "profile": { "bundles": [ ...原有..., "@local/dsh-prompt-enhancer" ] } }
```

### 卸载

从 `~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles` 里删掉那一行，
重启 DSH；再删掉 `node_modules\@local\dsh-prompt-enhancer` junction。

## 五、配置项

`cordis.patch.yml` 里 `prompt-enhancer` 那一行的 `config`：

| 键 | 默认 | 说明 |
|---|---|---|
| `provider` | `''` | 改写用的 provider 路由；留空则读宿主的 `agentDefaultModel` |
| `model` | `''` | 改写用的模型 id；留空同上 |
| `defaultStyle` | `default` | 未指定风格时使用：`default` / `structured` / `concise` / `expand` |
| `debugLog` | `true` | 往 `~/.dsh/prompt-enhancer-boot.log` 追加启动与请求日志 |
| `enableRoute` | `true` | 关掉可完全禁用 HTTP 路由（按钮将报「无法连接增强服务」） |

环境变量：

| 变量 | 默认 | 作用 |
|---|---|---|
| `DSH_PROMPT_ENHANCER_TIMEOUT_MS` | `60000` | 单次模型调用的硬超时。到点即中止并返回「增强超时」，不留挂起请求。**按请求读取**，改完下一次调用就生效 |
| `DSH_PROMPT_ENHANCER_LOG` | `~/.dsh/prompt-enhancer-boot.log` | 覆盖日志路径；离线测试用它避免污染真实日志 |

> **为什么必须有超时**：`llm.stream` 若一直不出块，`for await` 永不 resolve —— 响应发不出去、
> 在途 controller 不释放，用户界面永久停在「正在增强…」，重试还会成倍消耗额度。Node 自带的
> `requestTimeout` 是 300 秒，对 UI 太宽松，所以这里自己定 60 秒。

> **provider/model 建议显式配置**。留空时插件会在**请求时**读
> `ctx.get('agentDefaultModel')?.currentSelection()`；若该服务在这个环境拿不到，
> 接口会返回明确提示「未解析到 provider：请在插件 config 里显式配置 provider/model」，
> 而不是发一个 `provider: undefined` 的请求。

风格行为：

| 风格 | 引擎行为 |
|---|---|
| `default` | 只做强化与去冗余 |
| `structured` | 额外要求按 目标/交付物/约束/验收标准 分节 |
| `concise` | 额外要求激进压缩，不砍需求 |
| `expand` | 额外要求把隐含需求显式化 |

## 六、验证已加载

一条命令做完整验证（对着正在运行的 DSH）：

```powershell
node test/live.test.mjs --enhance
```

它会验证：插件已装进 profile、已登记为 bundle、`status` 路由通、**浏览器半确实在模块图里且被服务**
（用 `framedHash` 复算出真实 combo URL 并请求）、服务出来的脚本只注册一个模块且 id 正确、
factory 在**只有 React 可用**时能跑通、注册的目标槽位正确；`--enhance` 再加一次真实改写往返。

本机实测结果：

```
installation
  ok   the plugin is installed into the desktop profile
  ok   the profile registers it as a bundle
  ok   the host route answers /status
browser half in the module graph
  ok   the advertised combo URL serves the bundle
  ok   the source map is served too
  ok   the served script registers exactly one module with the right id
  ok   the factory runs with only React available
  ok   the served bundle registers into conversation.input.right
real rewrite round-trip
  ok   a draft is rewritten by the model
live verification: 9 passed, 0 failed
```

也可以手工探测：

```powershell
curl.exe -s http://127.0.0.1:19387/plugins/dsh-prompt-enhancer/status
```

成功：

```json
{"ok":true,"styles":["default","structured","concise","expand"],"defaultStyle":"default","route":"/plugins/dsh-prompt-enhancer","maxDraftChars":4000}
```

`maxDraftChars` 是宿主端的草稿上限。浏览器半因为只能 `require('react')` 而**无法导入引擎**，
所以它自带一个同名回退值，但**优先采用这里发布的数字** —— 这样上限只有一处真值，改宿主
不会让客户端静默漂移。

未加载返回 404。

改写接口（POST）：

```powershell
curl.exe -s -X POST http://127.0.0.1:19387/plugins/dsh-prompt-enhancer/enhance `
  -H "content-type: application/json" `
  -d '{"draft":"写个爬虫脚本","style":"structured"}'
```

## 七、排错

| 现象 | 原因 | 处理 |
|---|---|---|
| 界面没按钮、status 404 | 插件未加载 | 看下面的 boot log；确认 bundle 已登记 |
| 重启后弹「禁用插件并重启」 | 条目 fiber 被判 FAILED（即 `apply()` 抛错）。两次事故：宿主半裸 `ctx.inject`、浏览器半重复注册 locale | 两处都已修（见上方「已修复」小节）。若仍出现，用崩溃日志里的 `failed` 详情 + `test/live.test.mjs` 定位 |
| 重启后仍 404 | `Config` 不是 Standard Schema | 确认 `Config['~standard'].validate` 存在（本插件用 `lib/schema.js`） |
| | `inject` 声明了拿不到的服务 | 宿主半只需 `webServer`；浏览器半需 `slots` + `locale`，都是 web 装配的必需服务 |
| | 浏览器半重复注册 locale 命名空间 | `dsh-client-locale` 对同一命名空间**直接 throw**；本插件已加一次性守卫 |
| | patch 的 `name` 写成文件路径 | 必须写**包名** `@local/dsh-prompt-enhancer` |
| | bundle 报 "declares no dsh.bundle" | `package.json` 缺 `dsh.bundle.patch` |
| | bundle 报 "cannot resolve profile bundle" | 包不在 profile 的 `node_modules` 下 |
| 按钮灰掉 | 草稿为空 | 输入内容即可 |
| 提示「未解析到 provider」 | 默认模型服务拿不到 | 在 `cordis.patch.yml` 显式写 provider/model |
| 提示「宿主未提供 llm 服务」 | 宿主没有 `llm` 服务 | 检查 profile 是否装配了 `@deepseek-ai/dsh-llm` |
| 提示「草稿已改动，未覆盖」 | 改写期间你继续打字了（**这是保护**） | 重新点一次 |

> **如果你点了「禁用插件并重启」**：DSH 会重写 profile 的 `dsh.profile.bundles` 和
> `cordis.patch.yml`（本例中还会连带丢弃另外三个 experimental bundle 和几项设置）。恢复办法：
> 从 `~/.dsh/profiles/desktop/package.json.bak-*` 与 `cordis.patch.yml.bak-*` 取回，
> 或按第四节重新登记。

**加载状态怎么看**：每次 `apply`、每次改写、以及浏览器端的失败上报都写一行带 pid 的日志。

```powershell
Get-Content "$env:USERPROFILE\.dsh\prompt-enhancer-boot.log" -Tail 10
```

| 日志行 | 含义 |
|---|---|
| `apply() entered` | 插件体开始执行（宿主半或浏览器半） |
| `HTTP routes mounted` | 路由挂上（**关键行**） |
| `webServer service is not usable` | 服务不可用，插件降级而不是抛错 |
| `route already mounted; reusing it` | 重复激活被幂等挡住 |
| `CLIENT FAILURE: …` | **浏览器端 `apply` 抛错**（被兜底捕获），后面跟堆栈 |
| `enhance start` / `enhance ok` | 一次真实改写 |

> `CLIENT FAILURE` 是排查启动问题的第一手线索：它说明浏览器半出过错。配合
> 崩溃日志里的 `crash-*-web-boot.log` 一起看。

## 八、实现要点

### 0. 引擎侧提示词设计（吸取 WorkBuddy 的成熟做法）

提示词**分两层**，规则与任务分开——单层约束在长输入下容易漂移：

| 层 | 内容 | 位置 |
|---|---|---|
| **system** | 角色、`ANALYSIS PROCESS`（标注 `never output`，让模型静默推理）、`ENHANCEMENT PRINCIPLES`、`IMPORTANT CONSTRAINTS`、few-shot | `SYSTEM_PROMPT` |
| **user** | 一句话任务 + 草稿原文 | `USER_TEMPLATE`（`{input}` 替换） |

**四个关键点的对应实现：**

| 目标 | 做法 |
|---|---|
| 意图识别 | `ANALYSIS PROCESS` 三步（识别主目标 / 找出歧义与缺口 / 评估清晰度），并明确 `internal, never output` |
| 上下文补全 | 正面：`include necessary context`、`Set explicit parameters, constraints, and expected output format`；负面：`do NOT invent requirements, facts, or technologies the user did not mention`、`Do NOT explain HOW ... focus on WHAT` |
| 结构化改写 | `Output only the enhanced prompt text` + `cleanResult()` 后处理 |
| 语言一致性 | system 里声明 `Language matching is the highest priority`（含混合输入保持自然混排、禁止输出语言分析），**再加中/英/混合三类 few-shot** |

**生成参数**（`buildRequest`）：

| 参数 | 值 | 理由 |
|---|---|---|
| `temperature` | `0` | 改写是确定性任务，同输入应得同输出 |
| `maxTokens` | `1024` | 约束输出 ≈ 800 字符，防止跑偏写长文 |
| system / user | 见上 | 双层 |

**`cleanResult()` 的清理顺序**（与 WorkBuddy 一致，并补了它没有的兜底）：

1. `trim`
2. 剥掉**首尾各一个**引号字符（直引号 + 弯引号）—— few-shot 示例带引号，模型有样学样
3. 剥掉一层包裹的 markdown 代码围栏
4. 剥掉**标签前缀**：`增强后：` / `改写结果:` / `Enhanced prompt:` / `Here's the enhanced prompt:` 等
   （正则要求标签后必须跟分隔符，所以「优化后性能提升明显的函数」这种正常句子不会被误删）
5. `clampToSentence()`：超过 `OUTPUT_CHAR_LIMIT`（1200 字符）时，在**最近的句末标点**处截断；
   没标点才硬截。正常结果远小于此，摸不到这条兜底

**失败路径**：空草稿直接拒绝不调模型；模型失败/空返回/超长异常都**不覆盖输入框**；改写期间
用户继续打字则丢弃结果（明文提示「草稿已改动，未覆盖」）。

**草稿上限** `MAX_DRAFT_CHARS = 4000`：超出直接拒绝并提示先精简，防止费用失控。

### 1. 六个真坑（都已在代码里规避，并有测试锁定）

1. **`Config` 必须是 Standard Schema**。Cordis 在 `apply()` 之前执行
   `runtime.Config['~standard'].validate(config)`；普通对象没有 `~standard` 会抛
   `TypeError`，插件静默不激活。本插件用 `lib/schema.js` 的 `standardSchema()`。
2. **要用的服务就声明 `inject`，别用裸 `ctx.inject` 去够**。`inject` 写进导出是让
   Cordis 自己等（fiber 保持 PENDING，服务就绪后 ACTIVE）；而 `ctx.inject(inject, cb)`
   是**创建子 plugin fiber**，父条目注入集为空时它的 epoch 永不变化，条目被判 inactive。

   > **两条启动路径的后果不同**（这点我们一度写错，已按平台源码修正）：
   > - **宿主半**：`dsh-app-boot` 的启动审计只对固定集合
   >   `requiredStartupEntryIds = [agent-loop, webserver, modules, connection, headless-runner, acp, sdk-jsonrpc-server]`
   >   抛 `StartupError`；本插件 id 是 `prompt-enhancer`，**不在集合内** → 失败只降级并
   >   warn（`N entries did not activate`），宿主照常启动。
   > - **客户端半**：渲染端审计**没有 required 概念**，任何非 active 的客户端条目
   >   （**包括 `pending (waiting for service: …)`**）都直接
   >   `throw new Error('web boot: … did not activate')` → **整个页面启动中止**。
   >
   > 所以「一重启就弹禁用提示」是**客户端半**造成的；宿主半的失败只会让按钮消失。
3. **`apply` 必须返回 disposer**，并按「已挂载」单一槽位做幂等：Cordis 会在 epoch 变化时
   **重新执行插件体**，而 `dsh-host-webserver` 对重复 `(kind, path)` 是直接 throw。
4. **不要拿服务对象当 Map 键**。Cordis 每次读取服务都返回**新的 Proxy**，对象键永远不相等，
   去重会静默失效。用模块级单一槽位。
5. **`apply` 会被重复执行，所有一次性注册都要幂等**。Cordis 在注入 epoch 变化时重跑插件体，
   而 bundle 的模块实例跨该次重跑存活。`dsh-client-locale` 的 `register()` 对同一命名空间
   **直接 throw**（`locale namespace "x" already has locale "y"`）—— 这正是第二次事故：
   重跑时重复注册 → 抛错 → fiber FAILED → 启动审计中止。字典与槽位注册都加了守卫。
6. **外部插件的浏览器半只能用平台静态模块表**。所以 `lib/client.js`
   **只 `require('react')`**，图标内联 SVG，其余全部内联——不碰
   `dsh-client-store`、`dsh-client-ui-primitives` 等内部包。

### 2. 浏览器半的 bundle 格式

```js
window.__ModuleLoader__.load({
  id: '@local/dsh-prompt-enhancer',   // 必须与包名一致
  factory: (require) => { /* ... */ exports.apply = apply; return module.exports },
})
```

### 3. 写回输入框

`conversation.input.right` 是 session-scoped list 槽，`ui-conversation` 通过
`ctx.uiSession.provide({ props: ['inputActions'] })` 提供：

```js
inputActions.setDraft(text)          // 整体替换（走编辑器撤销栈）
inputActions.captureInsertion()      // 取光标位置 + draftRev
inputActions.insertText(text, span)  // 仅在 draftRev 未变时插入
```

控件用 `useInput()` 读 `input.draft`，改写完成后比对该值是否仍是发起时的草稿，
不一致就丢弃结果并提示。

### 4. 调模型

```js
ctx.llm.stream({
  provider, model,
  temperature: 0,                            // 确定性改写
  maxTokens: 1024,
  signal,                                    // AbortController
  messages: [
    { id, role: 'system', content: [{ type: 'text', text: SYSTEM_PROMPT }] },
    { id, role: 'user',   content: [{ type: 'text', text: buildUserContent(draft, style) }] },
  ],
})
```

流里取 `{ type: 'text-delta', text }` 拼接；`{ type: 'finish', reason }` 且
`reason.kind !== 'stop'` 视为失败。（`reasoning-delta` 不计入结果。）

## 九、已知限制

- **按钮位置固定**：`conversation.input.right` 渲染在模型选择器左侧，这是槽位顺序决定的。
- **「恢复原文」只在本次挂载内有效**：备份存在组件状态里，切换会话或刷新页面后消失。
  **而且只在草稿仍是本插件写入的那份时可用** —— 你如果改过增强结果，再点「恢复原文」
  会拒绝并提示「草稿已改动，未恢复原文」，而不是静默丢掉你的编辑。
- **只改写、不执行**：插件不会替你提交，写回后你仍可编辑再发送。
- **风格菜单用右键打开**：左键是「增强/取消/恢复」这个主动作。
- **`lib/patch-yaml.js` 只支持块映射/块序列子集**：不支持流式集合（`{a: 1}`、`[1, 2]`）、
  块标量（`|` / `>`）、锚点与别名、引号转义、非 ASCII 键名；遇到不支持的构造会抛错或
  解析成字面字符串。它只用来预检本插件自己的 `cordis.patch.yml`（该文件实测与真实
  loader 的 `js-yaml` 解析结果**完全一致**）。要校验手写的其它 patch，请直接用 `js-yaml`。
- **日志只追加、不轮转**：`debugLog: true`（默认）时每个请求会追加若干行到
  `~/.dsh/prompt-enhancer-boot.log`，每行一次同步写。长期运行会持续增长，需要时手动清理，
  或设 `debugLog: false` 关闭。
- **非法配置值会被静默降级**：写错 `defaultStyle` / `debugLog` / `provider` 不会让插件
  不激活（这是刻意的：一个加按钮的插件不该能阻止启动），而是回落到默认值并在启动日志里
  记一行 `config: ignored invalid value for "x"`。但若你显式设了 `debugLog: false`，
  那一行也不会写。
