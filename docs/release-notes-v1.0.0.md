首个公开版本，验证于 DeepSeek Harness `0.2.1-rc.2`。

## 它解决什么问题

输入框旁边点一下，把随手写的草稿改写成结构完整、要求明确的提示词，再写回输入框。不用切窗口、不用复制粘贴。

## 与同类插件的区别：提示词不出你的机器

有些提示词增强插件内置一条「免费模型通道」，让你零配置就能用。代价很直接：你写下的每一段草稿，都要先发给一个第三方服务器。

这个插件不走这条路：

- **不内置任何模型通道** —— 复用你在 dsh 里已经配好的模型，走 `ctx.llm.stream`
- **不发起任何外部请求** —— 没有遥测、没有回传，可以在浏览器开发者工具的网络面板自行核实
- **提示词只在你和自己的模型供应商之间流动** —— 中间没有多出来的第三方

如果你本来就配好了模型，这条免费通道对你是多余的风险，不是便利。

## 安装

```powershell
# 完全退出 DeepSeek Harness（含托盘图标）后执行
dsh plugin --profile desktop add https://github.com/zd5610982/dsh-prompt-enhancer-pro/releases/download/v1.0.0/dsh-prompt-enhancer-pro-1.0.0.tgz

# 重启 DeepSeek Harness，然后刷新页面
```

## 这个版本包含什么

- **运行时零依赖**，纯 JavaScript，没有构建步骤
- **198 项离线测试**：core 73 / client 55 / host 45 / profile 25
- **可共存**：包名、bundle id、HTTP 路由（`/plugins/dsh-prompt-enhancer-pro`）、日志路径统一带 `-pro` 后缀，可与同类的 prompt-enhancer 插件同时安装而不冲突
- **可回滚**：不改动宿主任何源码或系统提示词，卸载后无残留

## 已知限制

- 仅验证 `0.2.1-rc.2`，其他 `0.2.x` 未逐一验证
- 两套 cold-boot 测试需要宿主自带的 Cordis 才能执行，找不到时会打印 SKIPPED 并以 0 退出
- 尚未发布到 npm，安装需使用上面的 Release 链接

完整说明见 [README](https://github.com/zd5610982/dsh-prompt-enhancer-pro#readme)。

---

First public release, verified against DeepSeek Harness `0.2.1-rc.2`. A one-click
prompt-enhancement button for the composer that runs on the model you already
configured: no bundled third-party channel, no outbound requests, nothing between
you and your own model provider. MIT licensed.
