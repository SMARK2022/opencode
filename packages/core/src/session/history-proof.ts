export * as HistoryProof from "./history-proof"

// 两代保留各自完整JSON/tuple编码，只无损压缩常驻key，不以hash或字段裁剪代替精确比较。
export function encodeProofKey(json: string) {
  return Buffer.from(Bun.zstdCompressSync(Buffer.from(json), { level: 1 })).toString("latin1")
}
