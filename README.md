# nuoyis/dsh-context-reset · 上下文重置

作者：nuoyis ｜ npm 包名：`@nuoyis/dsh-context-reset`

给 DSH 长会话用的「交接简报 + 整段重置」插件。解决一个很实际的问题：
项目太大、一轮对话里塞了太多工具输出，token 一路涨到上限，越到后面越贵、越慢。

做法不是压缩、不是摘要调用模型，而是：

1. 让模型把**这一轮真正要传下去的东西**写成一份交接简报；
2. 落盘（`.dsh/context/state.md` + 项目 `AGENTS.md` 的托管块）；
3. 回合结束、agent 空闲时，把会话表面里**除系统提示之外的全部历史**替换成这一条简报。

重置这一步不调用任何模型，所以清空本身不花 token；下一轮请求直接以简报为起点，
体感就是「像新对话一样重新开始，但要求都还记得」。

## What it does (English)

Long DSH sessions pile every tool result up in the context window, so a big
project hits the token ceiling and keeps getting slower and more expensive.
This bundle adds a `context_save` tool and a `/handoff` command: the model
writes a short brief (goal / done / todo / key files and decisions), the plugin
stores it in the managed block of `<project>/AGENTS.md` and in
`.dsh/context/state.md`, then replaces every non-system node of the session
surface with that one handoff message. The reset writes session events only —
no model call, no tokens spent — so the next request restarts from a few
hundred tokens while keeping the requirements the project wrote down.

```
dsh plugin add @nuoyis/dsh-context-reset
```

MIT © nuoyis

## 装法

已在本机 profile `desktop` 安装（`@nuoyis/dsh-context-reset@0.2.0`）。
发布到 npm 之后，换机器只要：

```
dsh plugin add @nuoyis/dsh-context-reset
```

没网、或还没发布时，用本地包：

```
dsh plugin add  <tgz 的绝对路径>
```

或在 DSH 插件管理里选「安装本地包」。注意：**从目录安装会变成符号链接**，
插件在 profile 之外的真实路径下解析不到 `@deepseek-ai/*`；tarball 或 npm 安装才是
profile `node_modules` 下的真实目录。

## 用法

- **自动**：上下文压力（已用 token / 窗口）到 85% 时，插件给模型发一条系统请求，
  让它调用 `context_save` 写简报；这一轮结束、agent 空闲后自动重置。
- **手动工具**：模型自己判断「这个阶段做完了、历史没用了」时调用 `context_save`。
- **命令**：`/handoff [补充要求]`。已经有简报 → 立刻重置；没有 → 请模型先写简报。

工具参数只有一个必填的 `brief`（Markdown），建议结构：

```
## 目标
用户到底要什么（一句话）

## 已完成
做完的事、结论、产物绝对路径

## 待办
按顺序列，具体到下一步做什么

## 关键信息
文件路径:行、命令、配置值、接口签名、踩过的坑与原因

## 不要做
用户否掉的方向、试过失败的路
```

## 配置

在设置面板里直接改（插件装了 `@deepseek-ai/schemastery`，schema 可见）；
或者写进 profile 的 `cordis.patch.yml`：

```yaml
- id: context-reset
  name: '@nuoyis/dsh-context-reset'
  config:
    autoAtPercent: 80
    agentsFile: AGENTS.md
    stateDir: .dsh/context
    maxBriefChars: 6000
    writeAgentsFile: true
    enabled: true
```

`AGENTS.md` 里的托管块长这样，块外内容不受影响，重复保存只会替换块内：

```markdown
<!-- dsh-context:begin -->
（交接简报正文）
<!-- dsh-context:end -->
```

## 重置到底动了什么

- 会话日志上记一条 `compaction/prune`（只用于审计与统计，不改变可见表面）；
- 再追加一条 `user/message`，`surfaceOp: {op:'replace', startSeq, endSeq}`，
  `sourceEventSeqs` 列出被替换的全部事件。

原始事件仍在日志里（可以回查、可以审计），只是不再进入模型请求。
系统提示（surface 第一个节点）永远保留。

## 什么时候不该用

- 同一轮里还在做一件事、上下文里全是当前正在用的内容 → 重置会让你重新读一遍文件，反而更贵；
- 需要模型记住对话里的语气、细节、临时约定 → 这些不会进简报，重置即丢失。
  所以简报要自己写清楚「不要做」和关键约束。

## 已知限制

- 只有 `context_save` 被调用、或压力达阈值时才会重置；没有简报绝不盲目清空。
- 从目录（软链接）安装时拿不到 `@deepseek-ai/schemastery`，此时设置面板不显示，
  配置只能写在 `cordis.patch.yml`；用 tarball 安装则正常显示。
- 依赖 `tokenMeter.contextPressure`，窗口大小由当前模型决定。
