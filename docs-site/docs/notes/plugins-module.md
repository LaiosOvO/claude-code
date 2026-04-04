# plugins 模块阅读笔记

## 文件列表

```
src/plugins/
├── builtinPlugins.ts   # 内置插件注册表
└── bundled/            # 内置插件实现（子目录）
```

## 核心功能

plugins 模块管理 Claude Code 的**内置插件系统**——与 bundled skills 的区别在于：
- 插件出现在 `/plugin` UI 的 "Built-in" 区域
- 用户可以通过 UI 开关启用/禁用（持久化到 settings）
- 插件可以提供多个组件（skills + hooks + MCP servers）

插件 ID 格式为 `{name}@builtin`，与市场插件 `{name}@{marketplace}` 区分。

## 关键代码片段

启用状态三级判定——用户偏好 > 插件默认 > true：

```typescript
const userSetting = settings?.enabledPlugins?.[pluginId]
const isEnabled = userSetting !== undefined
  ? userSetting === true
  : (definition.defaultEnabled ?? true)
```

插件可用性检查：

```typescript
for (const [name, definition] of BUILTIN_PLUGINS) {
  if (definition.isAvailable && !definition.isAvailable()) continue
  // ...按 enabled/disabled 分组
}
```

## 模块关系

```
builtinPlugins.ts
  ├── 导入 BundledSkillDefinition (from skills/bundledSkills.ts)
  ├── 导入 BuiltinPluginDefinition, LoadedPlugin (from types/plugin.ts)
  └── 导入 getSettings_DEPRECATED (from utils/settings)
```

与 skills 模块的区分：
- skills 模块管理**单个斜杠命令**的注册和加载
- plugins 模块管理**插件包**（可包含多个 skill + hook + MCP server）

## 设计亮点

1. **source 语义**：Skill 的 `source` 设为 `'bundled'` 而非 `'builtin'`——因为 `'builtin'` 在 Command 中表示硬编码斜杠命令（/help），用 `'bundled'` 保持 Skill 工具列表和分析日志的一致性
2. **isAvailable 门控**：插件可声明运行时可用条件（如需要特定环境变量），不可用时从列表中完全隐藏
3. **Map 注册表**：使用 `Map<string, BuiltinPluginDefinition>` 管理，支持 `clearBuiltinPlugins()` 测试清理
4. **组合能力**：单个插件可同时提供 skills、hooks 和 mcpServers 三类扩展
5. **三级启用判定**：用户设置 > 插件默认值 > true，优先尊重用户选择
