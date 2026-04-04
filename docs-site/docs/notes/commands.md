# src/commands/ 模块阅读笔记

**文件数量**: 约 209 个  
**模块定位**: REPL 斜杠命令（Slash Commands）系统 — 用户在交互界面中通过 `/command` 触发的操作

---

## 目录结构

命令按功能分组为独立目录，每个目录通常包含 `index.ts`（命令注册）和可选的测试文件：

```
src/commands/
├── 会话管理
│   ├── clear/             # /clear — 清除对话历史
│   ├── compact/           # /compact — 手动触发上下文压缩
│   ├── context/           # /context — 查看当前上下文信息
│   ├── cost/              # /cost — 查看会话费用
│   ├── exit/              # /exit — 退出 REPL
│   ├── export/            # /export — 导出对话
│   ├── resume/            # /resume — 恢复会话
│   ├── session/           # /session — 会话管理
│   ├── rename/            # /rename — 重命名会话
│   ├── share/             # /share — 分享对话
│   └── stats/             # /stats — 查看统计
│
├── 代码操作
│   ├── commit.ts          # /commit — Git 提交
│   ├── commit-push-pr.ts  # /commit-push-pr — 提交、推送、创建 PR
│   ├── diff/              # /diff — 查看差异
│   ├── review.ts          # /review — 代码审查
│   ├── security-review.ts # /security-review — 安全审查
│   └── branch/            # /branch — 分支操作
│
├── 配置与设置
│   ├── config/            # /config — 配置管理
│   ├── color/             # /color — 颜色主题
│   ├── theme/             # /theme — 主题切换
│   ├── effort/            # /effort — 努力级别调整
│   ├── fast/              # /fast — 快速模式切换
│   ├── model/             # /model — 模型切换
│   ├── permissions/       # /permissions — 权限管理
│   ├── output-style/      # /output-style — 输出风格
│   ├── vim/               # /vim — Vim 模式
│   └── keybindings/       # /keybindings — 键绑定
│
├── 工具集成
│   ├── mcp/               # /mcp — MCP 服务器管理 (5 文件)
│   ├── ide/               # /ide — IDE 集成
│   ├── chrome/            # /chrome — Chrome 集成
│   ├── desktop/           # /desktop — Desktop 集成
│   └── hooks/             # /hooks — Hooks 管理
│
├── 插件生态
│   ├── plugin/            # /plugin — 插件管理
│   ├── skills/            # /skills — 技能管理
│   ├── install-github-app/ # /install-github-app
│   └── install-slack-app/  # /install-slack-app
│
├── 协作
│   ├── buddy/             # /buddy — 伙伴模式
│   ├── bridge/            # /bridge — 桥接/远程控制
│   ├── peers/             # /peers — 对等连接
│   ├── teleport/          # /teleport — 远程传送
│   └── agents/            # /agents — Agent 管理
│
├── 高级功能
│   ├── tasks/             # /tasks — 任务模式
│   ├── plan/              # /plan — 计划模式
│   ├── memory/            # /memory — 记忆管理
│   ├── files/             # /files — 文件管理
│   ├── copy/              # /copy — 复制到剪贴板
│   ├── doctor/            # /doctor — 诊断工具
│   ├── usage/             # /usage — 使用量查看
│   ├── feedback/          # /feedback — 反馈
│   └── voice/             # /voice — 语音模式
│
├── 系统命令
│   ├── help/              # /help — 帮助信息
│   ├── version.ts         # /version — 版本号
│   ├── init.ts            # /init — 初始化钩子
│   ├── login/             # /login — 登录
│   ├── logout/            # /logout — 登出
│   ├── upgrade/           # /upgrade — 升级
│   ├── onboarding/        # /onboarding — 引导流程
│   └── release-notes/     # /release-notes — 更新日志
│
├── 内部/实验
│   ├── ant-trace/         # 内部追踪（ant-only）
│   ├── backfill-sessions/ # 回填会话
│   ├── bughunter/         # Bug 猎人
│   ├── ctx_viz/           # 上下文可视化
│   ├── debug-tool-call/   # 调试工具调用
│   ├── extra-usage/       # 额外使用量
│   ├── heapdump/          # 堆转储
│   ├── insights.ts        # 洞察分析 (116KB)
│   ├── mock-limits/       # 模拟限制
│   ├── rate-limit-options/ # 速率限制选项
│   ├── perf-issue/        # 性能问题
│   └── stickers/          # 贴纸
│
├── 核心注册文件
│   ├── init.ts            # 初始化命令
│   ├── init-verifiers.ts  # 初始化验证器
│   ├── install.tsx        # 安装命令 (React 组件)
│   ├── createMovedToPluginCommand.ts # 迁移到插件的命令包装
│   └── statusline.tsx     # 状态栏命令 (React 组件)
│
└── src/                   # 内部共享代码
```

---

## 命令系统的组织方式

### 命令注册入口

**文件**: `src/commands.ts`  
**关键类型**:
```typescript
interface Command {
  name: string;
  description: string;
  isEnabled?: (context) => boolean;
  action: (args, context) => Promise<CommandResult>;
  // ...
}
```

**关键函数**:
- `getCommands(cwd)` — 获取所有可用命令列表
- `getCommandName(command)` — 获取命令显示名称
- `isCommandEnabled(command, context)` — 检查命令是否在当前上下文中可用
- `filterCommandsForRemoteMode(commands)` — 远程模式过滤

`commands.ts` 通过静态 import 加载所有命令模块，每个模块导出一个或多个 `Command` 对象。

### 命令结构约定

典型命令目录结构：
```
src/commands/compact/
├── index.ts       # 导出 Command 对象
├── compact.ts     # 命令实现逻辑
└── __tests__/     # 测试文件
    └── compact.test.ts
```

### 条件加载

部分命令通过 feature flag 条件加载（死代码消除）：

```typescript
const proactive = feature('PROACTIVE') || feature('KAIROS')
  ? require('./commands/proactive.js').default : null;

const voiceCommand = feature('VOICE_MODE')
  ? require('./commands/voice/index.js').default : null;
```

这确保实验性功能在生产构建中被完全移除。

---

## 核心命令详解

### 会话管理类

| 命令 | 说明 | 文件 |
|------|------|------|
| `/clear` | 清空对话历史，重新开始 | `clear/` |
| `/compact` | 手动触发上下文压缩 | `compact/` |
| `/resume` | 恢复之前的会话 | `resume/` |
| `/export` | 导出对话为文件 | `export/` |
| `/cost` | 查看当前会话费用 | `cost/` |

### 代码操作类

| 命令 | 说明 | 文件 |
|------|------|------|
| `/commit` | 生成 commit message 并提交 | `commit.ts` |
| `/diff` | 查看代码差异 | `diff/` |
| `/review` | 触发代码审查 | `review.ts` |

### 配置类

| 命令 | 说明 | 文件 |
|------|------|------|
| `/model` | 切换 AI 模型 | `model/` |
| `/permissions` | 管理工具权限 | `permissions/` |
| `/vim` | 切换 Vim 输入模式 | `vim/` |

---

## 与其他模块的关系

```
commands.ts (注册中心)
    |
    +-- 各 commands/xxx/index.ts (命令实现)
    |       |
    |       +-- services/* (调用服务层)
    |       +-- utils/* (使用工具函数)
    |
    +-- screens/REPL.tsx (命令触发入口)
    |       用户输入 /xxx -> 查找命令 -> 执行 action()
    |
    +-- cli/print.ts (非交互模式下的命令执行)
    |
    +-- hooks/useMergedCommands.ts (合并内置命令和 MCP 命令)
```

---

## 设计模式

1. **声明式注册**: 每个命令导出 `Command` 对象，由 `commands.ts` 集中注册
2. **Feature Flag 守卫**: 实验性命令通过 `feature()` 条件加载
3. **上下文感知**: `isEnabled()` 函数根据当前上下文（权限、模式、功能开关）决定命令可用性
4. **createMovedToPluginCommand**: 将已迁移到插件的命令保留为存根，引导用户安装插件
5. **React 组件命令**: 部分命令（`install.tsx`、`statusline.tsx`）返回 React 组件而非纯文本
