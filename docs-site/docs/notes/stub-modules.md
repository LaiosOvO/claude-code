# Stub 模块合集阅读笔记

本文档覆盖多个小型 stub/轻量模块。

---

## voice (1 文件)

**文件**: `src/voice/voiceModeEnabled.ts`

语音模式的**三层门控**：
1. `isVoiceGrowthBookEnabled()`：GrowthBook kill-switch（`tengu_amber_quartz_disabled` 为紧急关闭）
2. `hasVoiceAuth()`：检查 Anthropic OAuth token 是否存在（语音依赖 claude.ai 的 voice_stream 端点）
3. `isVoiceModeEnabled()`：auth + kill-switch 组合检查

设计亮点：默认 false 的 kill-switch 意味着新安装无需等待 GrowthBook 初始化即可使用语音。

---

## proactive (1 文件)

**文件**: `src/proactive/index.ts` (stub)

主动式功能的开关 API：`isProactiveActive()` / `activateProactive()` / `deactivateProactive()` / `isProactivePaused()`。当前全部返回 false/no-op。

---

## jobs (1 文件)

**文件**: `src/jobs/classifier.ts` (stub)

任务分类器——`classifyAndWriteState()`。在 Kairos 模板任务执行后分类状态并写入 state.json。当前 stub。

---

## environment-runner (1 文件)

**文件**: `src/environment-runner/main.ts` (stub)

环境运行器入口——`environmentRunnerMain(args)`。用于在特定环境中执行 Claude Code。

---

## self-hosted-runner (1 文件)

**文件**: `src/self-hosted-runner/main.ts` (stub)

自托管运行器入口——`selfHostedRunnerMain(args)`。用于自托管部署场景���

---

## native-ts (3 文件)

**目录**: `src/native-ts/file-index/`, `src/native-ts/yoga-layout/`

原生 TypeScript 实现的性能关键模块。file-index 可能是文件索引的本地实现，yoga-layout 是 Yoga 布局引擎的 TS 绑定（Ink 使用 Yoga 做终端布局计算）。

---

## upstreamproxy (2 文件)

**文件**: `src/upstreamproxy/relay.ts`, `src/upstreamproxy/upstreamproxy.ts`

CCR 容器内的**上游代理**——在容器的出口网关后面，通过 WebSocket 隧道转发 CONNECT 请求。

核心流程：读取 session token -> prctl 禁止 ptrace -> 下载 CA 证书 -> 启动本地 CONNECT relay -> 注入 HTTPS_PROXY 环境变量。

设计亮点：手工编码 ProtoBuf（`encodeChunk`/`decodeChunk`），单字段 bytes 消息只需 10 行代码。

---

## outputStyles (1 文件)

**文件**: `src/outputStyles/loadOutputStylesDir.ts`

从 `.claude/output-styles/` 和 `~/.claude/output-styles/` 加载 Markdown 格式的输出风格配置。支持 frontmatter 元数据（name/description/keep-coding-instructions）。使用 lodash memoize 缓存。

---

## moreright (1 文件)

**文件**: `src/moreright/useMoreRight.tsx` (stub)

内部专用 React Hook——`useMoreRight()`。提供 `onBeforeQuery` 和 `onTurnComplete` 回调接口，外部构建版本返回透传 no-op。
