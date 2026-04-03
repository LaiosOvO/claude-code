# 阅读笔记：src/entrypoints/cli.tsx

## 文件基本信息
- **路径**: `src/entrypoints/cli.tsx`
- **行数**: 302 行
- **角色**: CLI 的 TypeScript 入口文件，是从 `bin/claude-haha` 调用的第一个 TS 文件，负责快速路径分发和主流程引导

## 核心功能

`cli.tsx` 是整个应用的 TypeScript 层真正入口。它的核心设计理念是"快速路径优先"——对于一些不需要加载完整 CLI 的场景（如 `--version`、`mcp serve`、`remote-control` 等），尽早分发并返回，避免加载大量模块带来的延迟。

文件做了三件关键事情：
1. **环境初始化**：设置 corepack 和堆内存限制等环境变量
2. **快速路径分发**：根据命令行参数判断是否需要走特殊快速路径（版本查询、MCP 服务、桥接模式、守护进程等）
3. **主流程引导**：对于正常的交互式/非交互式使用，动态导入 `main.tsx` 并调用其 `main()` 函数

## 关键代码解析

### 顶层环境设置

```typescript
process.env.COREPACK_ENABLE_AUTO_PIN = '0';
```
禁止 corepack 自动 pin 包管理器版本，避免意外修改用户的 `package.json`。

```typescript
if (process.env.CLAUDE_CODE_REMOTE === 'true') {
  process.env.NODE_OPTIONS = existing 
    ? `${existing} --max-old-space-size=8192` 
    : '--max-old-space-size=8192';
}
```
远程模式（CCR 容器）下设置 8GB 堆内存限制（容器共 16GB）。

### 快速路径分发

```typescript
async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // 快速路径：--version 零模块加载
  if (args.length === 1 && (args[0] === '--version' || args[0] === '-v')) {
    console.log(`${MACRO.VERSION} (Claude Code)`);
    return;
  }
  // ...更多快速路径
}
```

文件中定义了大量快速路径，按优先级排列：

| 快速路径 | 触发条件 | 加载量 |
|---------|---------|-------|
| `--version` | `-v` / `--version` | 零加载 |
| `--dump-system-prompt` | ant-only，导出系统提示词 | 最小加载 |
| `--claude-in-chrome-mcp` | Chrome 扩展 MCP 服务器 | 仅 MCP 模块 |
| `--daemon-worker` | 守护进程工作线程 | 精简加载 |
| `remote-control` | 桥接模式 | 桥接模块 |
| `daemon` | 守护进程主进程 | 守护进程模块 |
| `ps/logs/attach/kill` | 后台会话管理 | 后台会话模块 |

### 主流程引导

```typescript
// 对于不匹配任何快速路径的情况，加载完整 CLI
const { main: fullMain } = await import('../main.js');
await fullMain();
```

实际代码中，当所有快速路径都不匹配时，才会动态导入 `main.tsx` 中的 `main()` 函数——这就是完整 CLI 的启动入口。

### Ablation Baseline（实验性消融基线）

```typescript
if (feature('ABLATION_BASELINE') && process.env.CLAUDE_CODE_ABLATION_BASELINE) {
  for (const k of ['CLAUDE_CODE_SIMPLE', 'CLAUDE_CODE_DISABLE_THINKING', ...]) {
    process.env[k] ??= '1';
  }
}
```
这是一个实验控制机制——通过禁用各种高级功能（思维链、自动压缩、自动记忆等），得到一个"基线版本"用于 A/B 测试。

## 数据流

```
bin/claude-haha
  └─> src/entrypoints/cli.tsx
       ├─ --version → 直接输出版本号退出
       ├─ --daemon-worker → daemon/workerRegistry.js
       ├─ remote-control → bridge/bridgeMain.js
       ├─ daemon → daemon/main.js
       ├─ ps/logs/attach/kill → cli/bg.js
       └─ 默认 → main.tsx::main()
            └─> run() → Commander 命令解析 → action handler
```

## 与其他模块的关系
- **上游**: `bin/claude-haha` 通过 `exec bun` 调用
- **核心下游**: `src/main.tsx` —— 完整 CLI 功能的入口
- **快速路径下游**: 
  - `bridge/bridgeMain.js` —— 远程控制/桥接模式
  - `daemon/main.js` —— 守护进程模式
  - `cli/bg.js` —— 后台会话管理
  - `utils/claudeInChrome/mcpServer.js` —— Chrome MCP 服务器

## 设计亮点与思考

1. **快速路径模式**：所有非核心路径都使用动态 `import()`，确保 `--version` 这样的简单命令只需 0 次模块加载，延迟极低。这是 CLI 工具常见的性能优化策略。
2. **feature() 编译时消除**：`feature('ABLATION_BASELINE')` 等调用在构建时会被 Bun 的 tree-shaking 优化为常量，整个 if 块在外部构建中被彻底移除。
3. **环境变量作为能力开关**：`CLAUDE_CODE_REMOTE`、`CLAUDE_CODE_ABLATION_BASELINE` 等环境变量控制运行时行为，实现了灵活的特性门控。
4. **进程安全**：CCR 环境下设置内存限制、禁用 corepack 自动 pin——这些都是在大规模部署中遇到的实际问题的解决方案。

## 要点总结

1. **快速路径优先设计**：针对 `--version`、MCP、桥接等场景，跳过重量级模块加载
2. **动态 import 延迟加载**：只在需要时才加载对应的模块，减少启动时间
3. **feature() 编译时 DCE**：ant-only 功能在外部构建中被完全移除
4. **多种运行模式**：支持交互式 CLI、桥接模式、守护进程、后台会话等多种模式
5. **环境适配**：根据运行环境（本地/远程/容器）动态调整运行参数
