# migrations 模块阅读笔记

> 源码路径：`src/migrations/`
> 文件数量：约 12 个（含 `src/`）

## 概述

`migrations/` 模块包含 Claude Code 的 **数据迁移脚本**，负责在版本升级时将用户的设置、模型偏好等数据从旧格式迁移到新格式。每个迁移函数都是幂等的，可以安全地多次执行。

## 文件列表

| 文件 | 迁移方向 | 说明 |
|---|---|---|
| `migrateFennecToOpus.ts` | fennec-* → opus | 将 fennec 模型别名迁移到 Opus 4.6 |
| `migrateLegacyOpusToCurrent.ts` | 旧 opus → 当前 opus | 旧版 Opus 字符串标准化 |
| `migrateOpusToOpus1m.ts` | opus → opus[1m] | Opus 升级到 1M 上下文版本 |
| `migrateSonnet1mToSonnet45.ts` | sonnet[1m] → sonnet-4-5 | Sonnet 1M 迁移到 Sonnet 4.5 |
| `migrateSonnet45ToSonnet46.ts` | sonnet-4-5 → sonnet | Sonnet 4.5 迁移到 Sonnet 4.6（别名） |
| `migrateAutoUpdatesToSettings.ts` | globalConfig → settings.json | 自动更新偏好迁移到 settings.json env 变量 |
| `migrateBypassPermissionsAcceptedToSettings.ts` | — → settings | 绕过权限标志迁移 |
| `migrateEnableAllProjectMcpServersToSettings.ts` | — → settings | 项目 MCP 服务器启用标志迁移 |
| `migrateReplBridgeEnabledToRemoteControlAtStartup.ts` | — → settings | REPL 桥接启用标志迁移 |
| `resetAutoModeOptInForDefaultOffer.ts` | — | 重置自动模式选择提示 |
| `resetProToOpusDefault.ts` | — | 重置 Pro 用户的默认模型到 Opus |

## 迁移模式分析

### 模型迁移（典型：migrateFennecToOpus.ts）

```typescript
export function migrateFennecToOpus(): void {
  // 1. 门控检查（仅 ant 用户）
  if (process.env.USER_TYPE !== 'ant') return

  // 2. 读取用户设置
  const settings = getSettingsForSource('userSettings')

  // 3. 匹配旧模型字符串
  if (model.startsWith('fennec-latest[1m]')) {
    updateSettingsForSource('userSettings', { model: 'opus[1m]' })
  }
  // ... 其他映射
}
```

关键特征：
- **只读写 userSettings** — 不碰 project/local/policy 设置
- **幂等设计** — 每次运行都检查当前值，已迁移则跳过
- **门控条件** — 部分迁移仅对特定用户类型/订阅级别生效

### 配置迁移（典型：migrateAutoUpdatesToSettings.ts）

```typescript
export function migrateAutoUpdatesToSettings(): void {
  // 1. 检查 globalConfig.autoUpdates 是否被用户显式禁用
  // 2. 将偏好写入 settings.json 的 env.DISABLE_AUTOUPDATER
  // 3. 立即设置 process.env.DISABLE_AUTOUPDATER
  // 4. 清理 globalConfig 中的旧字段
}
```

### 模型升级链

按时间顺序，模型迁移形成了一条升级链：

```
fennec-latest → opus
sonnet[1m] → sonnet-4-5-20250929[1m]
sonnet-4-5-20250929 → sonnet (即 Sonnet 4.6)
legacy opus → current opus
opus → opus[1m]
```

## Sonnet 4.5 → 4.6 迁移详解

```typescript
export function migrateSonnet45ToSonnet46(): void {
  // 仅首方 API 用户
  if (getAPIProvider() !== 'firstParty') return
  // 仅 Pro/Max/Team Premium 订阅
  if (!isProSubscriber() && !isMaxSubscriber() && !isTeamPremiumSubscriber()) return
  // 匹配 4 种 Sonnet 4.5 字符串，映射到 sonnet / sonnet[1m]
}
```

## 设计亮点

1. **幂等性** — 所有迁移函数可安全重复调用，不会产生副作用
2. **最小作用域** — 只修改 userSettings，不越权修改 project/local 级别配置
3. **门控分层** — USER_TYPE、订阅级别、API 提供商三层门控确保精确生效
4. **日志追踪** — 迁移执行后通过 `logEvent()` 上报分析事件
5. **即时生效** — 迁移完成后立即更新 `process.env`，不需要重启

## 与其他模块的关系

- **entrypoints/** — 迁移函数在 `init.ts` 或启动流程中被调用
- **bootstrap/** — 部分迁移读取 `bootstrap/state.ts` 中的会话信息
- **constants/** — 模型别名映射与 `constants/` 中的模型定义对应
- **state/** — 迁移结果影响 `AppState` 中的模型选择
