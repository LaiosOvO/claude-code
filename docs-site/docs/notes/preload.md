# 阅读笔记：preload.ts

## 文件基本信息
- **路径**: `preload.ts`（项目根目录）
- **行数**: 17 行
- **角色**: 构建宏（MACRO）预加载脚本，在本地开发时替代构建工具注入的编译时常量

## 核心功能

`preload.ts` 是本地开发环境的启动前置脚本。在生产构建中，Bun 的 `bun:bundle` 功能会在编译时将 `MACRO.VERSION`、`MACRO.BUILD_TIME` 等常量内联到代码中。但在本地开发时没有编译步骤，所以需要这个文件在运行时手动将这些宏注入到 `globalThis`。

简单来说，这个文件解决了"本地开发时没有构建步骤，但代码中到处引用了编译时常量"的问题。

## 关键代码解析

```typescript
const version = process.env.CLAUDE_CODE_LOCAL_VERSION ?? '999.0.0-local';
const packageUrl = process.env.CLAUDE_CODE_LOCAL_PACKAGE_URL ?? 'claude-code-local';
const buildTime = process.env.CLAUDE_CODE_LOCAL_BUILD_TIME ?? new Date().toISOString();
```
从环境变量读取版本信息，如果没有设置则使用默认值。`999.0.0-local` 这个超大版本号确保本地开发版本在比较时总是"最新的"。

```typescript
process.env.CLAUDE_CODE_LOCAL_SKIP_REMOTE_PREFETCH ??= '1';
```
默认跳过远程预取（remote prefetch）。`??=` 是空值合并赋值，只有当该环境变量未设置时才赋值。这避免了本地开发时去拉取远程资源。

```typescript
Object.assign(globalThis, {
  MACRO: {
    VERSION: version,
    PACKAGE_URL: packageUrl,
    NATIVE_PACKAGE_URL: packageUrl,
    BUILD_TIME: buildTime,
    FEEDBACK_CHANNEL: 'local',
    VERSION_CHANGELOG: '',
    ISSUES_EXPLAINER: '',
  },
});
```
将 MACRO 对象挂载到全局对象上。代码中任何地方引用 `MACRO.VERSION` 时都能正常获取值。各字段含义：
- `VERSION`：版本号
- `PACKAGE_URL` / `NATIVE_PACKAGE_URL`：包下载地址
- `BUILD_TIME`：构建时间
- `FEEDBACK_CHANNEL`：反馈渠道标记为 `local`
- `VERSION_CHANGELOG` / `ISSUES_EXPLAINER`：更新日志和问题说明（本地开发为空）

## 数据流

```
环境变量 (.env)
  └─> preload.ts 读取
       └─> 注入到 globalThis.MACRO
            └─> 被项目各处代码通过 MACRO.xxx 引用
```

## 与其他模块的关系
- **依赖**: 仅依赖 `process.env`（环境变量）
- **被依赖**: 被 `scripts/dev.ts` 通过 Bun 的 `-d` flag 注入 MACRO defines，或通过 Bun 的 preload 机制加载
- **影响**: 整个项目中所有引用 `MACRO.xxx` 的地方都依赖此文件在本地开发时正确设置

## 设计亮点与思考

1. **编译时与运行时的统一**：生产环境使用 `bun:bundle` 在编译时内联常量（更高效），本地开发用运行时注入模拟相同行为。这种模式让两种环境的代码完全一致，无需条件判断。
2. **默认值策略**：使用 `??` 空值合并运算符，既允许通过环境变量覆盖，又保证了不配置时也能正常工作。
3. **版本号 999.0.0-local**：巧妙地使用超大版本号，确保 semver 比较时本地版本总是"最新"，避免触发自动更新等逻辑。
4. **跳过远程预取**：本地开发时默认不去拉取远程资源，减少网络依赖，加快启动速度。

## 要点总结

1. **解决编译时常量的本地开发问题**：通过 `globalThis.MACRO` 在运行时注入构建宏
2. **所有值都可通过环境变量覆盖**：灵活的配置机制
3. **安全的默认值**：确保不配置任何环境变量也能正常启动
4. **极简设计**：17 行代码，职责清晰——只做一件事
