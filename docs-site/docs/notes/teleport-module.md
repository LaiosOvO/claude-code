# teleport-local 模块阅读笔记

## 文件列表

```
src/teleport-local/
├── index.ts      # 统一导出
├── types.ts      # 完整类型定义（包、会话、工作区、传输）
├── packer.ts     # 打包器（序列化 + Git 状态 + 压缩）
├── unpacker.ts   # 解包器（验证 + Git 恢复 + 文件还原）
└── transfer.ts   # 传输层（file/http/direct 三种方式）
```

## 核心功能

teleport-local 实现了**把正在运行的会话连同上下文打包传输到另一台机器继续执行**。与云端 Teleport 不同，本模块完全离线，通过文件传输。

打包内容 = 会话（消息历史 + 系统提示 + 模型） + 工作区（Git diff + 文件快照） + 工具（权限 + MCP 配置） + 任务（运行中 + 待执行）

传输方式：
- **file**：导出 `.teleport.gz`，用 SCP/USB/AirDrop 手动传输
- **http**：通过 claude-code-haha-server 中转
- **direct**：同局域网 Bun.serve 临时 HTTP 直传

## 关键代码片段

打包的九步流水线：

```typescript
// 1. 序列化消息 → 2. 捕获 Git 状态 → 3. 快照修改文件
// 4. 记录工具配置 → 5. 组装会话 → 6. 组装包
// 7. SHA-256 校验和 → 8. Gzip 压缩 → 9. 原子写入（tmp+rename）
```

解包的冲突处理：

```typescript
if (current !== ws.gitBranch) {
  const { stdout: status } = await execAsync('git status --porcelain', { cwd })
  if (status.trim()) {
    result.warnings.push('目标机器有未提交更改，无法自动切换分支')
    return
  }
}
```

## 设计亮点

1. **敏感文件过滤**：`SENSITIVE_PATTERNS` 排除 .env/.ssh/*.pem 等文件
2. **原子写入**：先写 `.tmp` 再 rename，防止中途失败产生损坏文件
3. **大文件保护**：单文件 5MB、整包 100MB 上限，超大文件只记录路径引用
4. **渐进式恢复**：解包失败不中断，用 warnings 数组收集所有问题供用户排查
5. **版本兼容**：只检查主版本号是否匹配，允许次版本/补丁版本���异
6. **二进制检测**：���查前 8KB 是否包含 null 字节，简单高效的启发式方法
7. **冲突备份**：解包时若目标文件已存在，自动创建 `.teleport-bak` 备份
8. **直连传输**：Bun.serve 起临时 HTTP 服务器，同网段内一行命令拉取
9. **CLAUDE.md 迁移**：打包时自动包含 `.claude/CLAUDE.md`，在目标机器恢复项目级 AI 配置
10. **stash 保存**：打包时保存 git stash 的第一个条目内容，解包时可供参考
