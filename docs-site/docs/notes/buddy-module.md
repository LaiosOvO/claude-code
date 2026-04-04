# buddy 模块阅读笔记

## 文件列表

```
src/buddy/
├── companion.ts           # 伙伴生成算法（哈希 -> 属性）
├── CompanionSprite.tsx     # 伙伴精灵渲染组件
├── prompt.ts              # 伙伴介绍提示词
├── sprites.ts             # ASCII 精灵图库
├── types.ts               # 类型定义（稀有度、物种、属性）
└── useBuddyNotification.tsx # 伙伴通知钩子
```

## 核心功能

buddy 模块是一个**趣味伴侣系统**——基于用户 ID 确定性生成一个小宠物，显示在输入框旁边偶尔发表评论。

核心机制：
- **Mulberry32 PRNG**：用用户 ID 哈希作为种子，保证同一用户总是得到同一伙伴
- **稀有度抽卡**：common(60)/uncommon(25)/rare(10)/epic(4)/legendary(1)
- **18 个物种**：duck/goose/blob/cat/dragon 等（用 charCode 构造避免字符串扫描）
- **属性系统**：DEBUGGING/PATIENCE/CHAOS/WISDOM/SNARK 五维属性

## 关键代码片段

确定性伙伴生成——哈希驱动的 PRNG：

```typescript
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return function() {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
```

伙伴人格注入系统提示：

```typescript
export function companionIntroText(name: string, species: string): string {
  return `A small ${species} named ${name} sits beside the user's input box...
  When the user addresses ${name} directly (by name), its bubble will answer.`
}
```

## 设计亮点

1. **Bones/Soul 分离**：外观（bones）从哈希重新生成，人格（soul）存配置——防止用户编辑出 legendary
2. **字符编码混淆**：物种名用 `String.fromCharCode` 构造，避免被构建工具的敏感字符串扫描误报
3. **Shiny 概率**：5% 的闪光个体，类似 Pokemon 色违机制
4. **不干扰 AI 主体**：提示词明确告诉主 AI "你不是它"，保持角色边界
5. **重复介绍跳过**：`getCompanionIntroAttachment` 检查历史消息，同一伙伴只介绍一次
6. **静音支持**：`config.companionMuted` 全局静音伙伴，不影响伙伴数据的生成和存储
7. **装饰系统**：8 种帽子（crown/tophat/propeller/halo/wizard/beanie/tinyduck/none）和 6 种眼睛样式
8. **Bun 优化哈希**：运行时检测 Bun 环境使用 `Bun.hash()`，否则回退到 FNV-1a 手工实现
