# 阅读笔记：bin/claude-haha

## 文件基本信息
- **路径**: `bin/claude-haha`
- **行数**: 13 行
- **角色**: 项目的 Shell 入口脚本，是用户直接执行的命令行入口

## 核心功能

这是整个 Claude Code 本地化项目（claude-code-haha）的最顶层入口。它是一个 Bash 脚本，负责将用户的命令行调用路由到正确的 TypeScript/TSX 入口文件。

脚本做了两件事：
1. 定位项目根目录（通过 `BASH_SOURCE` 反推）
2. 根据环境变量决定启动哪个运行时入口——恢复模式或完整 TUI 模式

## 关键代码解析

```bash
#!/usr/bin/env bash
set -euo pipefail
```
- `set -e`：任何命令失败立即退出
- `set -u`：使用未定义变量时报错
- `set -o pipefail`：管道中任何命令失败都算失败

```bash
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
```
定位到项目根目录。`BASH_SOURCE[0]` 是当前脚本路径，`/..` 回到上一级即项目根。

```bash
if [[ "${CLAUDE_CODE_FORCE_RECOVERY_CLI:-0}" == "1" ]]; then
  exec bun --env-file=.env ./src/localRecoveryCli.ts "$@"
fi
```
恢复模式分支：当环境变量 `CLAUDE_CODE_FORCE_RECOVERY_CLI` 为 `1` 时，启动一个简单的 readline REPL（无 Ink TUI），用于在主 TUI 出问题时紧急恢复。

```bash
exec bun --env-file=.env ./src/entrypoints/cli.tsx "$@"
```
默认路径：使用 Bun 运行时启动完整的 CLI 入口（带 Ink TUI 界面）。`--env-file=.env` 会加载项目根目录的 `.env` 文件。

## 数据流

```
用户在终端输入 `claude-haha` 命令
  └─> bin/claude-haha (Bash 脚本)
       ├─ CLAUDE_CODE_FORCE_RECOVERY_CLI=1 → src/localRecoveryCli.ts
       └─ 默认 → src/entrypoints/cli.tsx
```

命令行参数 `"$@"` 被原封不动传递给下游入口文件。

## 与其他模块的关系
- **依赖**: 无代码依赖，依赖 Bun 运行时和 `.env` 配置文件
- **被依赖**: 这是用户直接调用的入口，`package.json` 的 `bin` 字段指向此文件
- **下游**: `src/entrypoints/cli.tsx`（主入口）或 `src/localRecoveryCli.ts`（恢复模式）

## 设计亮点与思考

1. **双入口策略**：提供了一个"恢复模式"入口，当主 TUI（Ink）出现问题时，用户可以通过设置环境变量切换到简单的 readline REPL。这是一种优雅的降级策略。
2. **exec 替换进程**：使用 `exec` 而非直接运行，这样 Bun 进程会替换当前 Shell 进程，不会多占一个进程号，信号处理也更干净。
3. **env-file 加载**：通过 `--env-file=.env` 统一管理环境变量，避免在代码中散落 dotenv 加载逻辑。

## 要点总结

1. **入口脚本只做路由**：13 行代码，职责单一——定位根目录并分发到正确的 TS 入口
2. **两种运行模式**：正常模式（Ink TUI）和恢复模式（简单 REPL），通过环境变量切换
3. **使用 Bun 作为运行时**：不是 Node.js，而是 Bun——性能更好，原生支持 TypeScript
4. **exec 替换进程**：避免产生不必要的父进程
