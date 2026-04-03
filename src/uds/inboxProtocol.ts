/**
 * UDS Inbox 线路协议 (Wire Protocol)
 *
 * ===== 为什么需要"帧 (frame)"？=====
 *
 * TCP 和 Unix Domain Socket 都是"流式协议 (stream protocol)"——
 * 数据像水流一样连续传输，没有天然的"消息边界"。
 *
 * 例如，发送方依次发送 "Hello" 和 "World"，
 * 接收方可能收到:
 *   - "HelloWorld"      (粘包: 两条消息粘在一起)
 *   - "Hel" + "loWorld" (拆包: 一条消息被拆成两次接收)
 *   - "Hello" + "World" (恰好: 但不能依赖这种行为)
 *
 * 解决方案是"消息帧 (message framing)"——在消息前面加一个长度前缀:
 *
 *   [4 字节: 消息长度 N][N 字节: JSON 消息体]
 *
 * 接收方先读 4 字节得到长度 N，再读 N 字节得到完整消息。
 * 如果还没收到 N 字节的数据，就等待更多数据到来。
 *
 * 这是网络编程中最经典的帧格式之一，
 * 常见于 MySQL 协议、PostgreSQL 协议、gRPC 等。
 *
 * ===== 长度前缀格式 =====
 *
 * 使用 4 字节大端序 (Big-Endian) 无符号整数:
 * - 大端序: 最高有效字节在前（网络字节序）
 * - 4 字节: 最大表示 4GB 的消息，对 JSON 消息绰绰有余
 * - 无符号: 消息长度不可能为负数
 *
 * 示例: 长度 256 = 0x00000100
 *   字节 0: 0x00
 *   字节 1: 0x00
 *   字节 2: 0x01
 *   字节 3: 0x00
 */

import type { InboxMessage } from './types.js'

// ============================================================
// 常量
// ============================================================

/**
 * 长度前缀的字节数
 *
 * 4 字节 = 32 位，可以表示的最大值是 2^32 - 1 = 4,294,967,295 字节 ≈ 4GB。
 * 对于 JSON 文本消息来说，这个上限完全足够。
 */
const LENGTH_PREFIX_SIZE = 4

/**
 * 单条消息的最大长度 (10MB)
 *
 * 防止恶意或错误的客户端发送超大消息导致内存耗尽。
 * 10MB 对于 JSON 消息来说已经非常大了，
 * 正常的文本/命令消息通常只有几 KB。
 */
const MAX_MESSAGE_SIZE = 10 * 1024 * 1024

// ============================================================
// 帧编码
// ============================================================

/**
 * 将消息编码为线路格式的帧
 *
 * 编码过程:
 * 1. 将消息对象序列化为 JSON 字符串
 * 2. 将 JSON 字符串编码为 UTF-8 字节
 * 3. 计算字节长度
 * 4. 创建 [4字节长度 + JSON字节] 的 Buffer
 *
 * @param msg - 要编码的消息
 * @returns 包含长度前缀和 JSON 数据的 Buffer
 * @throws 如果消息超过最大尺寸限制
 *
 * 内存布局示例 (消息 {"type":"ping"}):
 *   偏移 0-3:  [0x00, 0x00, 0x00, 0x0F]  (长度 = 15)
 *   偏移 4-18: {"type":"ping"}             (JSON 数据)
 */
export function encodeFrame(msg: InboxMessage): Buffer {
  // 步骤 1: 序列化为 JSON
  // JSON.stringify 生成紧凑的 JSON 字符串（无缩进、无多余空格）
  const jsonStr = JSON.stringify(msg)

  // 步骤 2: 编码为 UTF-8 字节
  // 注意: JSON 字符串的"字符数"和"字节数"可能不同！
  // 例如中文字符 "你好" 是 2 个字符但 6 个字节 (UTF-8)。
  // 长度前缀记录的是字节数，不是字符数——这一点至关重要。
  const jsonBytes = Buffer.from(jsonStr, 'utf-8')

  // 步骤 3: 校验尺寸
  if (jsonBytes.length > MAX_MESSAGE_SIZE) {
    throw new Error(
      `消息尺寸 ${jsonBytes.length} 字节超过限制 ${MAX_MESSAGE_SIZE} 字节`
    )
  }

  // 步骤 4: 组装帧
  // 分配 4 字节 (长度前缀) + N 字节 (JSON 数据) 的 Buffer
  const frame = Buffer.alloc(LENGTH_PREFIX_SIZE + jsonBytes.length)

  // 写入长度前缀 (大端序无符号 32 位整数)
  // writeUInt32BE = Write Unsigned Int 32-bit Big-Endian
  frame.writeUInt32BE(jsonBytes.length, 0)

  // 将 JSON 数据复制到长度前缀之后
  jsonBytes.copy(frame, LENGTH_PREFIX_SIZE)

  return frame
}

// ============================================================
// 帧解码
// ============================================================

/**
 * 尝试从 Buffer 中解码一个完整的帧
 *
 * 这是一个"非阻塞"的解码函数:
 * - 如果 Buffer 中的数据不足以构成一个完整帧，返回 null
 * - 如果数据足够，返回解码的消息和消耗的字节数
 *
 * 返回 bytesConsumed 是因为 Buffer 中可能有多条消息:
 *   [帧1][帧2][帧3的前半部分...]
 * 调用者可以用 bytesConsumed 来切掉已处理的部分，继续解码剩余数据。
 *
 * @param buf - 包含待解码数据的 Buffer
 * @returns 解码结果，或 null（数据不足）
 */
export function decodeFrame(
  buf: Buffer
): { message: InboxMessage; bytesConsumed: number } | null {
  // 检查 1: Buffer 是否至少有 4 字节（长度前缀的大小）？
  // 如果连长度都读不出来，说明数据还没到齐，返回 null 等待更多数据。
  if (buf.length < LENGTH_PREFIX_SIZE) {
    return null
  }

  // 读取长度前缀
  const payloadLength = buf.readUInt32BE(0)

  // 检查 2: 长度是否合法？
  // 防御性编程: 如果长度值异常（比如被篡改或传输错误），
  // 抛出错误而非尝试分配巨量内存。
  if (payloadLength > MAX_MESSAGE_SIZE) {
    throw new Error(
      `帧长度 ${payloadLength} 字节超过限制 ${MAX_MESSAGE_SIZE} 字节，可能是协议错误`
    )
  }

  // 检查 3: Buffer 中是否有完整的帧数据？
  // 总帧大小 = 4字节长度前缀 + payloadLength 字节数据
  const totalFrameSize = LENGTH_PREFIX_SIZE + payloadLength
  if (buf.length < totalFrameSize) {
    // 数据还没收完，等待更多数据
    return null
  }

  // 提取 JSON 数据部分
  const jsonBytes = buf.subarray(LENGTH_PREFIX_SIZE, totalFrameSize)
  const jsonStr = jsonBytes.toString('utf-8')

  // 解析 JSON
  // 注意: 这里可能因为无效 JSON 而抛出异常，调用者需要处理
  let message: InboxMessage
  try {
    message = JSON.parse(jsonStr) as InboxMessage
  } catch (err) {
    throw new Error(
      `帧 JSON 解析失败: ${err instanceof Error ? err.message : String(err)}`
    )
  }

  return {
    message,
    bytesConsumed: totalFrameSize,
  }
}

// ============================================================
// 帧读取器 (有状态)
// ============================================================

/**
 * 帧读取器的类型定义
 *
 * push(chunk) - 将从 socket 收到的原始数据喂给读取器
 *               返回所有已完整接收的消息
 * reset()    - 清空内部缓冲区（通常在连接断开时调用）
 */
export interface FrameReader {
  push(chunk: Buffer): InboxMessage[]
  reset(): void
}

/**
 * 创建一个有状态的帧读取器
 *
 * ===== 为什么需要有状态的读取器？=====
 *
 * 网络数据是"流式"到达的——一次 socket.on('data') 回调
 * 可能收到:
 *   1. 恰好一条完整消息
 *   2. 多条完整消息粘在一起
 *   3. 一条消息的前半部分
 *   4. 上一条消息的后半部分 + 下一条消息的前半部分
 *
 * 帧读取器维护一个内部缓冲区 (internal buffer)，
 * 将每次收到的数据 chunk 追加到缓冲区，
 * 然后尝试从缓冲区中提取所有完整的帧。
 * 不完整的数据留在缓冲区，等下次 chunk 到来时继续拼接。
 *
 * 这个模式叫做"缓冲区累积 + 逐帧提取 (buffer accumulation + frame extraction)"，
 * 是流式协议解析的标准做法。
 *
 * 使用示例:
 *   const reader = createFrameReader()
 *   socket.on('data', (chunk) => {
 *     const messages = reader.push(chunk)
 *     for (const msg of messages) {
 *       handleMessage(msg)
 *     }
 *   })
 */
export function createFrameReader(): FrameReader {
  // 内部缓冲区: 存放尚未处理完的数据
  // 初始为空 Buffer，随着数据到来不断增长
  let buffer = Buffer.alloc(0)

  return {
    /**
     * 将新收到的数据块推入读取器
     *
     * @param chunk - 从 socket 收到的原始数据
     * @returns 本次提取出的所有完整消息（可能是 0 条、1 条或多条）
     */
    push(chunk: Buffer): InboxMessage[] {
      // 将新数据追加到内部缓冲区
      // Buffer.concat 创建一个新的 Buffer，包含旧数据 + 新数据
      //
      // 性能说明: 每次 concat 都会分配新内存并复制数据。
      // 对于高吞吐量场景，可以用环形缓冲区 (ring buffer) 优化。
      // 但对于 IPC 消息的吞吐量级别，concat 完全足够。
      buffer = Buffer.concat([buffer, chunk])

      const messages: InboxMessage[] = []

      // 循环: 尽可能多地从缓冲区中提取完整帧
      // 每次提取一帧，剩余数据保留在缓冲区
      while (true) {
        try {
          const result = decodeFrame(buffer)
          if (result === null) {
            // 缓冲区中没有完整帧了，等待更多数据
            break
          }
          messages.push(result.message)
          // 切掉已消费的数据，保留剩余部分
          // subarray 不复制内存，只创建视图 (view)，效率高
          buffer = buffer.subarray(result.bytesConsumed)
        } catch (err) {
          // 帧解析错误: 可能是数据损坏
          // 清空缓冲区以尝试恢复。在生产系统中，
          // 可能需要更复杂的错误恢复策略（比如扫描下一个有效帧头）。
          console.error('[InboxProtocol] 帧解析错误，清空缓冲区:', err)
          buffer = Buffer.alloc(0)
          break
        }
      }

      return messages
    },

    /**
     * 重置读取器状态
     *
     * 在连接断开或重连时调用，丢弃所有未处理的部分数据。
     * 因为断开后的残留数据已经没有意义——新连接会从头开始。
     */
    reset(): void {
      buffer = Buffer.alloc(0)
    },
  }
}

// ============================================================
// 辅助函数
// ============================================================

/**
 * 生成唯一的消息 ID
 *
 * 使用 crypto.randomUUID() 生成 UUID v4。
 * UUID v4 是随机生成的，碰撞概率极低 (约 2^-122)。
 * 格式: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
 */
export function generateMessageId(): string {
  return crypto.randomUUID()
}

/**
 * 创建一条消息
 *
 * 便利函数，自动填充 id 和 timestamp 字段。
 *
 * @param from - 发送者 session ID
 * @param to - 接收者 session ID 或 '*'（广播）
 * @param type - 消息类型
 * @param payload - 消息内容
 * @param replyTo - 可选，回复的消息 ID
 */
export function createMessage(
  from: string,
  to: string | '*',
  type: InboxMessage['type'],
  payload: any,
  replyTo?: string
): InboxMessage {
  return {
    id: generateMessageId(),
    from,
    to,
    type,
    payload,
    timestamp: Date.now(),
    replyTo,
  }
}
