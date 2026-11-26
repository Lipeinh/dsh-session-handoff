# Changelog

本项目的版本变更记录。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.2.0] - 2026-11-26

### 新增

- **交接成功后终止原会话**（配置项 `stopOldSession`，默认 `true`）。
  此前交接只做「接力」不做「交棒」：新会话已经开始干活，旧会话仍在继续回话、继续调工具、
  继续计费，两边同时改同一批文件。
- 配置项 `stopDelayMs`（默认 `300`）：按下停止前的让出时间，用来让本次 `tool/result` 先落盘。
- `handoff_now` 工具输出新增 `stopped`（终止情况）与 `stopError`（失败原因）字段。
- `GET /api/handoff/status` 新增 `stops`（累计成功终止次数）与 `lastResult.stopped`。
- 回归测试 `test/handoff-stop.test.mjs`（36 项断言，自包含，无需已安装 DSH）。
- README 新增「交接后原会话会被终止」一节，说明时序与副作用。

### 变更

- 交接流程的返回结果里带上 `stopped`，工具渲染文案会明确区分
  「已终止 / 本来就空闲 / 不在活跃表 / 配置关闭 / 终止失败」。
- 插件卸载时清理尚未触发的「终止原会话」计时器。

### 修复

- 修复 `setTimeout` 回退分支漏调用回调的问题（在未安装 cordis timer 服务的宿主上，
  停止永远不会发生）。

### 说明

- 终止使用 harness 自己的停止原语 `agent.cancel({ kind: 'user' }, { keepInbox: false })`，
  与界面「停止」按钮同一套语义；`keepInbox: false` 是刻意的——保留队列会让循环
  在回合中止后拿残留输入再开一个回合。
- 副作用是有意为之：`stopDelayMs` 窗口内原会话若已发出下一个模型请求，该请求也会被掐掉。

## [0.1.9]

改进前的版本（历史记录未逐条整理）。
