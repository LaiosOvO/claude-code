# daemon 模块阅读笔记

## 文件列表

```
src/daemon/
├── index.ts           # 统一导出
├── types.ts           # 类型定义（状态机、配置、命令协议）
├── daemonManager.ts   # 生命周期管理（启停、检测、重启）
├── daemonClient.ts    # HTTP-over-UDS 客户端
├── daemonProcess.ts   # 后台进程主体（stub）
├── daemonLogger.ts    # 日志系统（轮转、缓冲、级别）
├── workerRegistry.ts  # Worker 注册（stub）
└── main.ts            # 进程入口（stub）
```

## 核心功能

daemon 模块实现了**后台守护进程**，让 Claude Code 像系统服务一样持续运行。它是 Kairos（24/7 Agent）的基础设施。

架构关系：`daemonManager`（用户终端侧）通过 UDS 控制 `daemonProcess`（后台侧），类似 systemctl 与 systemd 的关系。

核心能力：
- **三级停止策略**：UDS 命令 -> SIGTERM -> SIGKILL，确保总能终止
- **HTTP-over-UDS 通信**：利用 Bun fetch 的 `unix` 选项，天然请求/响应模型
- **日志轮转**：大小触发、Promise 链串行保证、缓冲写入减少 I/O
- **流式输出**：async generator 实现 `tail -f` 效果

## 关键代码片段

脱离终端的守护进程创建：

```typescript
const child = spawn(process.execPath, ['run', daemonProcessPath], {
  detached: true,          // setsid() 创建新会话
  stdio: ['ignore', logFd, logFd],  // stdout/stderr 重定向到日志
})
child.unref()  // 父进程不等待子进程
```

存活检测的三步法：

```typescript
// 1. PID 文件存在？ 2. 进程存活？ 3. UDS 可响应？
const pid = readPidFile(config.pidFile)
if (!isProcessAlive(pid)) return false
const client = new DaemonClient({ socketPath: config.socketPath })
await client.getStatus()
```

## 设计亮点

1. **命令协议**：TypeScript discriminated union 实现类型安全的命令分发
2. **幂等性**：`ensureDaemon()` 多次调用结果相同，先查后创建
3. **指数退避**：等待轮询间隔从 100ms 渐增到 500ms，平衡响应速度和 CPU 开销
4. **中文注释**：整个模块用详细中文注释编写，是极好的系统编程教学材料
5. **日志缓冲**：DaemonLogger 聚合日志条目，100ms 或 8KB 触发一次 flush，减少 I/O 调用
6. **unref 策略**：定时器和子进程统一 unref，确保父进程不被后台任务阻塞退出
7. **六态状态机**：stopped/starting/running/paused/stopping/error，paused 保持 socket 但停止新会话
