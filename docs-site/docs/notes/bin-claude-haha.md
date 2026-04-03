# 阅读笔记：CLI 入口

## 文件基本信息
- **构建入口**: `src/entrypoints/cli.tsx` → `dist/cli.js`
- **CLI 命令**: `ccb`（package.json 的 bin 字段）
- **开发运行**: `bun run scripts/dev.ts`
- **角色**: 项目的程序入口，是用户直接执行的命令行入口

## 核心功能

这是 Claude Code Best（claude-code-best）的最顶层入口。在 B 仓库中，入口不是 Shell 脚本，而是通过 `build.ts` 构建后的 `dist/cli.js`，或开发时通过 `scripts/dev.ts` 直接运行 `src/entrypoints/cli.tsx`。

### 开发模式入口：scripts/dev.ts

开发脚本的核心工作是注入 MACRO defines（版本号、构建时间等），然后运行 cli.tsx：
```bash
bun run scripts/dev.ts  # 等价于 bun -d MACRO_DEFS src/entrypoints/cli.tsx
```

### 构建模式入口：build.ts → dist/cli.js

```typescript
// build.ts
Bun.build({
  entrypoints: ['src/entrypoints/cli.tsx'],
  outdir: 'dist',
  splitting: true,  // 代码分割，生成 ~450 个 chunk
})
```

构建后 `package.json` 的 `bin` 字段指向 `dist/cli.js`：
```json
{ "bin": { "ccb": "dist/cli.js" } }
```

## cli.tsx 快速路径

`src/entrypoints/cli.tsx`（271行）是真正的程序入口，它做两件事：

1. **注入全局 polyfill**：`globalThis.MACRO`、`feature()` 函数等
2. **快速路径分发**：按开销从低到高检查参数

```
用户执行 ccb [args]
  └─> src/entrypoints/cli.tsx
       ├─ --version          → 输出版本号，退出
       ├─ --daemon-rpc       → 加载 daemon worker
       ├─ --bridge-worker    → 加载 bridge worker
       ├─ --bg               → 后台任务管理
       ├─ --mcp              → MCP 服务器模式
       ├─ --environment-runner → 环境运行器
       ├─ --self-hosted-runner → 自托管运行器
       └─ 默认               → import('../main') 加载完整应用
```

## 数据流

```
ccb 命令行
  └─> dist/cli.js (构建产物)
       └─> src/entrypoints/cli.tsx (源码入口)
            ├─ 快速路径命中 → 动态 import() 加载对应模块
            └─ 默认 → src/main.tsx (Commander.js CLI 定义)
                 └─> run() action handler
                      └─> showSetupScreens() → launchRepl()
                           └─> src/screens/REPL.tsx (交互界面)
```

## 与其他模块的关系
- **依赖**: Bun 运行时、scripts/defines.ts（MACRO 值）
- **被依赖**: package.json 的 bin 字段、build.ts 的 entrypoints
- **下游**: `src/main.tsx`（主应用）或各个快速路径模块

## 设计亮点

1. **快速路径优先**：简单命令（--version）不需要加载 4680 行的 main.tsx
2. **MACRO 注入**：编译时常量通过 Bun 的 -d flag 注入，支持 tree-shaking
3. **feature() 函数**：Feature flag 在编译时成为常量，死代码可被消除
4. **多入口设计**：daemon、bridge、mcp、environment-runner 等都有独立入口，互不干扰

## 要点总结

1. **B 仓库用构建系统替代了 Shell 脚本**：通过 `build.ts` + Bun.build() 产生 `dist/cli.js`
2. **开发时用 scripts/dev.ts**：注入 MACRO defines 后直接运行 cli.tsx
3. **CLI 命令是 `ccb`**：不是 claude-haha
4. **快速路径设计**：10+ 个快速路径，最小化不必要的模块加载
