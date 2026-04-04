# vim 模块阅读笔记

## 文件列表

```
src/vim/
├── types.ts        # 状态机类型定义（VimState、CommandState、RecordedChange）
├── motions.ts      # 光标移动函数（纯计算，无副作用）
├── operators.ts    # 操作符执行（delete/change/yank）
├── textObjects.ts  # 文本对象（word/quote/bracket）
└── transitions.ts  # 状态转换逻辑（按键 -> 状态变迁）
```

## 核心功能

vim 模块为 Ink TUI 输入框实现了**完整的 Vim 模式**，包含 INSERT/NORMAL 双模式和多级命令解析状态机。

核心能力：
- **状态机驱动**：`CommandState` 用 TypeScript discriminated union 建模 10+ 种子状态
- **Vim motion 全覆盖**：h/j/k/l、w/b/e/W/B/E、f/F/t/T、0/^/$、gg/G
- **操作符 + 动作组合**：d/c/y + motion/text-object，支持 count 前缀
- **dot-repeat**：`RecordedChange` 记录操作，`.` 键精确回放
- **寄存器**：yank/paste 支持行级/字符级模式

## 关键代码片段

状态机类型——TypeScript 穷举保证：

```typescript
export type CommandState =
  | { type: 'idle' }
  | { type: 'count'; digits: string }
  | { type: 'operator'; op: Operator; count: number }
  | { type: 'operatorCount'; op: Operator; count: number; digits: string }
  | { type: 'operatorFind'; op: Operator; count: number; find: FindType }
  | { type: 'operatorTextObj'; op: Operator; count: number; scope: TextObjScope }
  | { type: 'find'; find: FindType; count: number }
  | { type: 'g'; count: number }
  | { type: 'replace'; count: number }
  | { type: 'indent'; dir: '>' | '<'; count: number }
```

纯函数 motion 解析——无副作用，只计算目标位置：

```typescript
export function resolveMotion(key: string, cursor: Cursor, count: number): Cursor {
  let result = cursor
  for (let i = 0; i < count; i++) {
    const next = applySingleMotion(key, result)
    if (next.equals(result)) break  // 到达边界停止
    result = next
  }
  return result
}
```

## 设计亮点

1. **类型即文档**：types.ts 开头的 ASCII 状态图完整描述了所有状态转换路径
2. **纯函数架构**：motions.ts 零副作用，输入 Cursor 输出 Cursor，极易测试
3. **MAX_VIM_COUNT=10000**：防止用户输入 `99999dd` 导致性能问题
4. **INSERT 追踪**：`insertedText` 字段记录输入文本，用于 dot-repeat 重放插入操作
