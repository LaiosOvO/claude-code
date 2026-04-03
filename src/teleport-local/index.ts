/**
 * Teleport 本地模块 — 统一导出
 *
 * 使用示例：
 * ```typescript
 * import { packSession, unpackSession, exportToFile } from './teleport-local'
 *
 * // 打包当前会话
 * const result = await packSession({
 *   cwd: process.cwd(),
 *   sessionId: 'session-123',
 *   messages: conversationHistory,
 *   systemPrompt: '...',
 *   model: 'claude-3-opus',
 * })
 *
 * // 导出文件
 * await exportToFile(result.filePath, '/tmp/my-session.teleport.gz')
 *
 * // 在另一台机器上解包
 * const unpacked = await unpackSession('/tmp/my-session.teleport.gz', '/path/to/workspace')
 * ```
 */

// 打包
export { packSession, listPackages } from './packer'

// 解包
export { unpackSession, extractMessages, validatePackage } from './unpacker'

// 传输
export {
  exportToFile,
  importFromFile,
  uploadToServer,
  downloadFromServer,
  listServerPackages,
  startDirectServer,
  pullFromDirect,
  type ProgressCallback,
} from './transfer'

// 类型
export type {
  TeleportPackage,
  TeleportSession,
  TeleportWorkspace,
  TeleportToolState,
  TeleportTaskState,
  SerializedMessage,
  SerializedContentBlock,
  FileSnapshot,
  TeleportTokenUsage,
  TeleportMcpConfig,
  TeleportPermissionSnapshot,
  TeleportTaskSnapshot,
  TransferMethod,
  TransferProgress,
  TransferConfig,
  UnpackResult,
} from './types'

export { TELEPORT_VERSION, TELEPORT_EXTENSION, TELEPORT_DIR } from './types'
