const startsWith = (bytes: Uint8Array, prefix: number[]) => prefix.every((value, index) => bytes[index] === value)

export function isPdfAttachment(mime: string) {
  return mime === "application/pdf"
}

export function isMedia(mime: string) {
  return mime.startsWith("image/") || isPdfAttachment(mime)
}

export function isImageAttachment(mime: string) {
  return mime.startsWith("image/") && mime !== "image/svg+xml" && mime !== "image/vnd.fastbidsheet"
}

export function sniffAttachmentMime(bytes: Uint8Array, fallback: string) {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png"
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg"
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif"
  if (startsWith(bytes, [0x42, 0x4d])) return "image/bmp"
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf"
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50])) {
    return "image/webp"
  }

  return fallback
}

// 图片 token 预算 - 约等于 1024x768 图片的 token 数
const IMAGE_TOKEN_BUDGET = 1600

// 图片处理结果
export interface ProcessedImage {
  data: string
  mime: string
  originalSize: number
}

// 动态导入 sharp（可选依赖） - 哨兵值模式避免无限重试
const SHARP_UNAVAILABLE = Symbol("SHARP_UNAVAILABLE")
let sharpCached: typeof import("sharp") | typeof SHARP_UNAVAILABLE | null = null

async function getSharp(): Promise<typeof import("sharp") | null> {
  if (sharpCached === SHARP_UNAVAILABLE) return null  // 失败后不重试
  if (sharpCached !== null) return sharpCached as typeof import("sharp")
  try {
    const mod = await import("sharp")
    // 处理 ESM/CJS 互操作
    sharpCached = (mod as any).default ?? mod
    return sharpCached as typeof import("sharp")
  } catch {
    sharpCached = SHARP_UNAVAILABLE  // 标记为不可用
    return null
  }
}

// 估算图片 token：byteLength * 4/3 / 750
function estimateImageTokens(byteLength: number): number {
  return Math.ceil((byteLength * 4) / 3 / 750)
}

// 格式化文件大小
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// 三级图片压缩策略
export async function processImageWithTokenBudget(
  bytes: Uint8Array,
  mime: string,
  maxTokens: number = IMAGE_TOKEN_BUDGET,
): Promise<ProcessedImage> {
  const originalSize = bytes.length
  const buffer = Buffer.from(bytes)

  // Level 0: 估算无需压缩的情况
  const estimatedTokens = estimateImageTokens(buffer.length)
  if (estimatedTokens <= maxTokens) {
    return {
      data: buffer.toString("base64"),
      mime,
      originalSize,
    }
  }

  // 尝试使用 sharp 进行压缩
  const sharp = await getSharp()
  if (!sharp) {
    // 无 sharp 时直接返回原始数据
    return {
      data: buffer.toString("base64"),
      mime,
      originalSize,
    }
  }

  try {
    const meta = await sharp(buffer).metadata()
    const maxDim = 1568
    const scale = Math.min(
      maxDim / (meta.width ?? maxDim),
      maxDim / (meta.height ?? maxDim),
      1,
    )

    // Level 1: 标准尺寸缩放（最长边 1568px，符合 Claude vision 最优分辨率）
    if (scale < 1) {
      const resized = await sharp(buffer)
        .resize(Math.floor((meta.width ?? maxDim) * scale), Math.floor((meta.height ?? maxDim) * scale), {
          fit: "inside",
          withoutEnlargement: true,
        })
        .jpeg({ quality: 85 })
        .toBuffer()

      const l1Tokens = estimateImageTokens(resized.length)
      if (l1Tokens <= maxTokens) {
        return { data: resized.toString("base64"), mime: "image/jpeg", originalSize }
      }
    }

    // Level 2: 质量递减压缩（无论是否缩放过都尝试）
    for (const [width, quality] of [
      [800, 60],
      [800, 40],
      [600, 20],
    ] as [number, number][]) {
      const compressed = await sharp(buffer)
        .resize(width, width, { fit: "inside", withoutEnlargement: true })
        .jpeg({ quality })
        .toBuffer()
      if (estimateImageTokens(compressed.length) <= maxTokens) {
        return { data: compressed.toString("base64"), mime: "image/jpeg", originalSize }
      }
    }

    // Level 3: 极限兜底压缩（只有前两级都超出预算才到这里）
    const fallback = await sharp(buffer)
      .resize(400, 400, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 20 })
      .toBuffer()

    return { data: fallback.toString("base64"), mime: "image/jpeg", originalSize }
  } catch {
    // 压缩失败时返回原始数据
    return {
      data: buffer.toString("base64"),
      mime,
      originalSize,
    }
  }
}

export { formatSize }
