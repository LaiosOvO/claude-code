# 模块说明：工具系统 (Tool System)

## 概述

工具系统是 Claude 与外部世界交互的接口层。每个工具定义了一种能力（读文件、执行命令、搜索代码等），Claude 通过工具调用来完成实际任务。系统设计遵循"安全优先"原则——默认假设工具不安全。

## 核心文件

| 文件 | 作用 |
|------|------|
| `src/Tool.ts` | 工具类型定义 + `buildTool()` 工厂函数 (~800行) |
| `src/tools.ts` | 工具注册表 + 工具池组装 (~390行) |
| `src/tools/*/` | 60+ 工具实现目录 |

## 架构设计

```
工具定义层                    工具注册层                  工具执行层
┌────────────┐          ┌─────────────┐          ┌──────────────┐
│ BashTool   │          │             │          │ QueryEngine  │
│ ReadTool   │──────────│ getAllBase   │──────────│              │
│ EditTool   │ 注册     │ Tools()     │ 组装     │ executeTool()│
│ GrepTool   │          │             │          │              │
│ AgentTool  │          │ assemble    │          │ 权限检查     │
│ ...60+     │          │ ToolPool()  │          │ → 执行      │
│            │          │             │          │ → 收集结果   │
│ MCP Tools  │──────────│ + MCP 工具  │          │              │
└────────────┘          └─────────────┘          └──────────────┘
```

## 每个工具的三文件结构

```
src/tools/BashTool/
├── BashTool.ts   # 工具定义：inputSchema、call()、checkPermissions()
├── prompt.ts      # Claude 看到的工具使用说明
└── UI.tsx         # 用户在终端看到的渲染组件
```

## 安全属性

| 属性 | 默认值 | 含义 |
|------|--------|------|
| `isEnabled()` | true | 工具是否可用 |
| `isConcurrencySafe()` | **false** | 能否并行执行（安全优先） |
| `isReadOnly()` | **false** | 是否只读（安全优先） |
| `isDestructive()` | undefined | 是否破坏性操作 |

## 设计模式

- **工厂模式**：`buildTool()` 提供安全的默认值
- **Schema 驱动**：Zod schema 同时用于验证、类型推导、API 描述生成
- **关注点分离**：逻辑/提示词/UI 三层独立
- **权限前置**：任何执行前必须通过权限检查
