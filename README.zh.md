# dsh-schedule-send

[English](README.md) | **中文**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![DeepSeek Harness plugin](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4B6BFB.svg)](https://github.com/deepseek-ai/deepseek-harness)
[![Release](https://img.shields.io/github/v/release/Zhiyi-Zhao/dsh-schedule-send?label=release)](https://github.com/Zhiyi-Zhao/dsh-schedule-send/releases)
[![verify](https://github.com/Zhiyi-Zhao/dsh-schedule-send/actions/workflows/verify.yml/badge.svg)](https://github.com/Zhiyi-Zhao/dsh-schedule-send/actions/workflows/verify.yml)

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的输入框加一个「定时发送」：现在写好内容、选一个时间，到点后这段文字会**以普通用户消息**的身份发进**同一个会话**——等同于你在那个时刻按下了发送，agent 会正常回复并继续对话。

## 功能

- 输入框工具栏（发送按钮左侧）出现一个时钟按钮。
- 快捷时间（30 分钟后、1 小时后、3 小时后、明天 09:00），也可选精确的本地日期时间。
- 确认后草稿立即清空；会话里出现一张持久卡片，显示发送时间、内容摘要，并带 **取消** 按钮。
- 队列落在工作区之外，支持补发：应用关闭期间到点的消息会在下次启动后送达。
- 送达的是真实用户消息（`source.kind = 'user'`），不是提醒、也不是系统通知。
- 失败按退避重试；发送 id 同时是 prompt 的 `requestId`，崩溃后重试不会重复投递。
- 无需构建，浏览器端只依赖页面共享的 `react` / `react-dom`。

## 为什么不直接用内置提醒？

DSH 内置的 Schedule 子系统语义是"提醒"：它注入 `[SCHEDULE REMINDER]` 框架，要求模型把内容**展示**给用户，而不是把它当作指令执行。定时发送需要相反的语义——内容必须变成用户的消息并开启一轮回复。因此本插件维护自己的持久队列，通过公开的 `ctx.sessionController.prompt(...)` 投递：目标会话未打开时会自动 resume，并生成一条普通用户消息。

## 安装

这个包同时声明了宿主半（`index.js`，负责队列、命令与投递）和浏览器半（`client.js`）。没有构建脚本，所有安装方式拿到的都是可直接运行的成品文件。

### 方式 1：发布页的 tarball（推荐）

从 [Releases](https://github.com/Zhiyi-Zhao/dsh-schedule-send/releases) 下载 `dsh-schedule-send-0.1.0.tgz`，然后：

```sh
dsh plugin --profile desktop add ./dsh-schedule-send-0.1.0.tgz
```

### 方式 2：直接从 GitHub 安装

```sh
dsh plugin --profile desktop add github:Zhiyi-Zhao/dsh-schedule-send
```

`dsh web` profile 用同样的 spec，把 profile 换成 `web`：

```sh
dsh plugin --profile web add github:Zhiyi-Zhao/dsh-schedule-send
```

### 方式 3：从本地目录安装

```sh
git clone https://github.com/Zhiyi-Zhao/dsh-schedule-send.git
dsh plugin --profile desktop add /absolute/path/to/dsh-schedule-send
```

### 方式 4：在 Web 界面里安装

打开侧边栏 **Plugins** 页面，选择安装 bundle，粘贴上面的 spec（`github:Zhiyi-Zhao/dsh-schedule-send`、tarball 地址或绝对路径）。从运行中的应用里安装需要 `danger-full-access` 权限或当次审批。

> `--profile desktop` 是桌面应用的 profile 名；`dsh web` 部署使用 `--profile web`。只要 profile 组合了 Web 客户端，这个 bundle 就能用。把下文命令里的 `desktop` 换成你的 profile 名即可。

安装到 desktop profile 后，新 bundle 可能通过 HMR 立刻生效；若没有出现，重启 DeepSeek Harness。卸载：

```sh
dsh plugin --profile desktop remove dsh-schedule-send
```

## 使用

1. 在任意会话里输入消息（纯文本）。
2. 点发送按钮左边的时钟按钮。
3. 选一个快捷时间，或设置精确的本地日期时间。
4. 点「定时发送」确认：草稿清空，会话里出现「定时发送」卡片。
5. 到点后消息以普通用户消息进入该会话，agent 正常回复。到点前可以点卡片上的 **取消**。

卡片会作为历史留在对话里；投递后再点取消，会提示消息已经离开队列。

> 插件还注册了两个内部会话命令（`schedule-send`、`schedule-send-cancel`），因为浏览器插件只能通过会话命令通道调用自己的宿主半。它们会出现在斜杠菜单里，但不需要手动输入——真正的入口是时钟按钮。

## 工作原理

| 步骤 | 位置 | 发生了什么 |
|---|---|---|
| 创建 | 浏览器 | 输入框控件调用 `ctx.remote.commands.execute('/schedule-send <json>')`，携带正文、目标时间戳、发送 id 和浏览器 IANA 时区。 |
| 持久化 | 宿主 | 命令处理函数校验参数，把记录原子写入 `$DSH_HOME/schedule-send/queue.json`（临时文件 + rename）。 |
| 扫描 | 宿主 | 每 5 秒扫描到期记录，调用 `ctx.sessionController.prompt({ requestId: id, sessionId, mode: 'queue', content, clientTimeZone })`。 |
| 投递 | 宿主 | 该公开方法按需 resume 会话并提交普通用户消息；发送 id 就是去重键，重试幂等。 |
| 反馈 | 浏览器 | 命令生命周期通过按命令名分发的 `conversation.chat.commandview` 渲染成持久卡片。 |

## 实测记录

一次真实的定时发送，从宿主队列读回（本地时间，Europe/Copenhagen）：

| 字段 | 值 |
|---|---|
| 状态 | `delivered` |
| 创建 | 2026-10-19 12:22:16 |
| 目标 | 2026-10-19 12:24:00 |
| 投递 | 2026-10-19 12:24:03 |
| 延迟 | 3.2 秒（在 5 秒扫描周期内） |

送达的文字以普通用户消息出现在会话里，agent 正常回复。

## 限制

- **到点时应用必须在运行**：DSH 没有后台调度器。应用关闭时会等到下次启动后补发；完全关闭的应用无法发送。
- **仅支持纯文本**：草稿带附件时按钮禁用。
- **投递会 resume 目标会话并跑一轮回复**，即使那个对话没有打开；会消耗 token、可能调用工具，审批仍按该会话的策略等待你确认。
- **精度约 ±5 秒**（扫描间隔）。
- **只做一次性发送**：不支持周期任务，也不支持原地改时间；取消后重新安排即可。
- 投递失败（会话已不存在、会话没有可路由的模型等）会退避重试，最多 60 次，然后以 `failed` 和 `lastError` 记录在队列里，并在宿主日志里留一条警告。
- 队列文件损坏时会被改名为 `queue.json.corrupt-<时间戳>`，插件以空队列启动。

## 兼容性

已在桌面版 DeepSeek Harness **0.2.1-rc.2** 上验证。

- 宿主半：`ctx.commands.register`、`ctx.sessionController.prompt`、`ctx.sessions.flush`、`ctx.agents`，全部是公开服务。
- 浏览器半：slot API（`conversation.input.right`、`conversation.chat.commandview`）、locale 服务和 `ctx.remote.commands.execute`；只 import `react` 与 `react-dom`，不依赖 DSH 的 UI primitives，因此 UI 包的小改动不会破坏它。
- 如果 `ctx.sessionController` 不存在，定时消息会留在队列里并记一条警告，而不是让整个 profile 失败。

## 开发

```
index.js              宿主半：命令、持久队列、扫描、投递
client.js             浏览器半：输入框控件、卡片、本地化字典
cordis.patch.yml      安装时插入的 Loader 行
locale/{en,zh}.json   插件清单读取的显示元数据
icon.svg              bundle 图标
scripts/verify.mjs    `npm run verify` 与 CI 使用的静态检查
```

- 无构建、无安装步骤：浏览器产物是一个纯闭包工厂。
- `npm run verify` 校验 manifest、导出、locale 元数据、两个入口文件和工厂 id。
- 本地试用：`dsh plugin --profile <profile> add /absolute/path/to/dsh-schedule-send`。

## 许可

MIT © 2026 Zhiyi Zhao
