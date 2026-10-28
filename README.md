# dsh-prompt-enhancer-pro

> 输入框旁边点一下，把随手写的草稿改写成结构完整、要求明确的提示词，再写回输入框。

![license](https://img.shields.io/badge/license-MIT-blue)
![dsh](https://img.shields.io/badge/dsh-0.2.1--rc.2-4B6EF5)
![deps](https://img.shields.io/badge/runtime%20deps-0-brightgreen)

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）原生插件。

## 为什么选它：提示词不出你的机器

提示词增强这件事，有两种做法。

一种是在插件里内置一条"免费模型通道"，让你零配置就能用。代价很直接：**你写下的每一段草稿，都要先发给一个你不知道在哪、由谁运营的服务器。**

这个插件走另一条路：

- **不内置任何模型通道** —— 复用你在 dsh 里已经配好的模型，走 `ctx.llm.stream`。
- **不发起任何外部请求** —— 没有遥测、没有回传、没有第三方服务。你可以在开发者工具的网络面板里自行核实。
- **提示词只在你和自己的模型供应商之间流动** —— 中间没有多出来的第三方。

如果你本来就已经配好了模型（大多数人都是），这条免费通道对你是**多余的风险**，不是便利。

另外两点：

- **运行时零依赖**，纯 JavaScript，没有构建步骤。
- **可完整回滚** —— 一条命令卸载，不改动宿主任何源码。

> 包名带 `-pro` 后缀，是为了让它可以和其他 prompt-enhancer 类插件**同时安装**而不冲突：bundle id、HTTP 路由、日志路径全部加了同样的后缀。

---

## 安装

**前置条件**：DeepSeek Harness `0.2.x`，已至少配置一个可用模型。

```powershell
# 1) 完全退出 DeepSeek Harness（含系统托盘图标）
# 2) 安装
dsh plugin --profile desktop add dsh-prompt-enhancer-pro
# 3) 重新启动 DeepSeek Harness
```

> CLI 动词随 dsh 预览版有变化。若上面的 `add` 报错，改用 `install`：
> `dsh plugin --profile desktop install dsh-prompt-enhancer-pro`

**安装后必须刷新一次页面。** 浏览器半（按钮）是在页面加载时注册进模块图的，不刷新看不到按钮。

### 验证是否已加载

```powershell
# 宿主半：有 apply() entered 与 HTTP routes mounted 两行即为成功
Get-Content "$env:USERPROFILE\.dsh\prompt-enhancer-pro-boot.log" -Tail 10

# 路由：返回 200 与 JSON 即正常
curl.exe http://127.0.0.1:3080/plugins/dsh-prompt-enhancer-pro/status
```

---

## 使用

1. 在输入框里写草稿，不用讲究措辞。
2. 点输入框工具栏里的增强按钮（模型选择器左侧）。
3. 等待改写完成，结果会**替换**输入框内容。
4. 不满意就再点一次，或直接手动改——它只改内容，不会替你发送。

### 效果示例

**草稿**

```
帮我写个总结
```

**增强后**

```
请把下面这段会议记录整理成一份不超过 300 字的工作总结。要求：
1) 按「结论 — 进展 — 待办」三段组织，每段不超过 100 字；
2) 待办事项必须标注负责人与截止时间，缺失的写「待确认」，不要推测；
3) 保留原始数据与专有名词，不做同义替换；
4) 用中文输出，语气客观简洁，不使用比喻和形容词堆砌。
```

改写引擎会保留你原有的语言（中文进、中文出），不会自作主张翻译。

---

## 权限与副作用

dsh 插件加载后可以访问完整的 `ctx`。以下是这个插件的全部行为，请据此判断是否信任它：

| 行为 | 用途 | 能否关闭 |
|---|---|---|
| 读取当前输入框草稿 | 作为改写的输入 | 否（核心功能） |
| 调用宿主已配置的模型 | 执行改写 | 不点按钮即可 |
| 写入 `~/.dsh/prompt-enhancer-pro-boot.log` | 冷启动排错 | 是，`debugLog: false` |
| 监听 `/plugins/dsh-prompt-enhancer-pro/*` | 浏览器半与宿主半通信，同源校验 | 是，`enableRoute: false`（功能会失效） |
| 外部网络请求 | **无** | — |
| 执行 Shell / 读写工作区文件 | **无** | — |

除上述之外，插件不注册任何工具、不修改系统提示词、不动你的会话数据。

**一句话验收**：装好后打开浏览器开发者工具的网络面板，点一次增强按钮，你会看到只有一个发往本机 `127.0.0.1` 的请求——没有任何外部域名。

---

## 兼容性

| dsh 版本 | 状态 |
|---|---|
| `0.2.1-rc.2` | ✅ 实测通过（本版本据此发布） |
| 其他 `0.2.x` | ⚠️ 未逐一验证，`engines.dsh` 允许安装 |
| `< 0.2.0` | ❌ 未适配 |
| `>= 0.3.0` | ❌ 未适配，等 dsh 稳定后再跟进 |

dsh 处于 Developer Preview，preview 之间会有破坏性变更。**升级 dsh 后如果按钮消失，先看 [`docs/ENGINEERING.md`](docs/ENGINEERING.md) 的排错章节，再提 issue。**

---

## 配置项

在 `cordis.patch.yml` 的 `prompt-enhancer-pro` 行里改 `config`：

| 键 | 默认 | 说明 |
|---|---|---|
| `provider` | `''` | 留空表示用宿主的默认模型提供方 |
| `model` | `''` | 留空表示用宿主默认模型；两者都填时以显式值为准 |
| `defaultStyle` | `default` | 改写风格预设 |
| `debugLog` | `true` | 是否写 `~/.dsh/prompt-enhancer-pro-boot.log` |
| `enableRoute` | `true` | 是否挂载 HTTP 路由 |

> patch 是**整行替换**而非合并，所以列出的就是完整配置，别只写想改的那一项。

---

## 卸载

```powershell
# 1) 完全退出 DeepSeek Harness
# 2) 移除
dsh plugin --profile desktop remove dsh-prompt-enhancer-pro
# 3) 重启
```

**它没有改动宿主的任何源码或系统提示词**，卸载后不会残留行为。如果只想临时停用，把 `dsh.profile.bundles` 里对应那一行注释掉即可。

---

## 排错

| 现象 | 原因 | 处理 |
|---|---|---|
| 输入框没有按钮 | 浏览器半未加载 | 刷新页面（Ctrl+R） |
| 重启后仍无按钮 | 宿主未完全退出 | 托盘图标右键退出，确认进程结束再启动 |
| 按钮在但点了没反应 | 路由未挂载 | 看 boot log 有没有 `ROUTE MOUNT FAILED` |
| 改写报错/超时 | 模型不可用 | 先在宿主里正常对话一次，确认模型可调 |
| 输出被截断 | 模型 `max_tokens` 限制 | 换更长的模型，或缩短草稿 |

详细根因分析与测试方法见 [`docs/ENGINEERING.md`](docs/ENGINEERING.md)。

---

## 开发

```powershell
git clone https://github.com/zd5610982/dsh-prompt-enhancer-pro.git
cd dsh-prompt-enhancer-pro
node test/run-all.mjs                # 离线测试，198 项
node test/live.test.mjs --enhance    # 需要运行中的宿主
```

`run-all.mjs` 里有两套 cold-boot 测试需要宿主自带的 Cordis 才能跑，找不到时会**打印 SKIPPED 并以 0 退出**——看到 `ALL SUITES PASSED` 不等于它们真的执行过，这一点请留意。

纯 JavaScript，**没有构建步骤**：`lib/` 里的文件就是发布的文件。运行时零依赖。

架构三层：宿主半 `lib/index.js`、浏览器半 `lib/client.js`、纯逻辑 `lib/core.js`（零依赖、可单测）。

---

## English

A native plugin for **DeepSeek Harness** that adds a one-click prompt-enhancement
button to the composer. Your rough draft is rewritten into a structured prompt by
the model already configured in the harness, then written back in place.

**The point is what it does not do.** Some prompt-enhancer plugins ship a bundled
"free model channel", which means every draft you type is sent to a third-party
server of unknown provenance. This one has no such channel: it calls
`ctx.llm.stream` on your own configuration, makes no outbound requests, and adds
no third party between you and your model provider.

- **Zero runtime dependencies.** Plain JavaScript, no build step.
- **Trivially reversible.** No host source is patched; uninstalling leaves nothing behind.
- **Coexists safely.** Bundle id, HTTP route and log path all carry the `-pro`
  suffix, so it can be installed alongside other prompt-enhancer plugins.

```bash
dsh plugin --profile desktop add dsh-prompt-enhancer-pro
```

Verified against DeepSeek Harness `0.2.1-rc.2`. Refresh the page after installing —
the client half registers into the module graph at page load.

MIT licensed.

---

## License

[MIT](LICENSE) © 2026 zd5610982

This is a community plugin. It is not affiliated with or endorsed by DeepSeek.
