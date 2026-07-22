// #534：PNG 首块必须是固定 13-byte IHDR；提前限定该结构可避免宽松 parser 把坏头当作可传递图片。
export function isPng(buffer: Buffer) {
  return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
}

export function hasPngHeader(buffer: Buffer) {
  return buffer.length >= 33 && buffer.readUInt32BE(8) === 13 && buffer.toString("ascii", 12, 16) === "IHDR"
}

export function isBmp(buffer: Buffer) {
  return buffer.length >= 2 && buffer.toString("ascii", 0, 2) === "BM"
}

// #534：对齐 Pi 的两类 DIB 布局：COREHEADER 的 planes/bpp 位于 22/24，其余支持的 INFOHEADER 位于 26/28。
// DIB 12 与 40..124 的字段偏移不同，混读会把宽高字节误判为 planes/bpp 并产生平台差异。
// offset 必须同时落在 DIB 之后和真实 buffer 内；声明长度存在时还不能越过声明末尾。
// planes 必须为 1，位深只接受 BMP 规范的离散集合——白名单来自 Pi 的 BMP predicate。
export function hasValidBmpHeader(buffer: Buffer) {
  if (buffer.length < 26) return false
  const declared = buffer.readUInt32LE(2)
  const dib = buffer.readUInt32LE(14)
  const offset = buffer.readUInt32LE(10)
  // declared size 为 0 是 Pi 接受的合法“未声明”形式，非零时才参与 offset 边界约束
  if (declared !== 0 && declared < 26) return false
  if (offset < 14 + dib || offset >= buffer.length || (declared !== 0 && offset >= declared)) return false
  const fields =
    dib === 12
      ? buffer.length >= 26
        ? { planes: buffer.readUInt16LE(22), bpp: buffer.readUInt16LE(24) }
        : undefined
      : dib >= 40 && dib <= 124 && buffer.length >= 30
        ? { planes: buffer.readUInt16LE(26), bpp: buffer.readUInt16LE(28) }
        : undefined
  return fields !== undefined && fields.planes === 1 && [1, 4, 8, 16, 24, 32].includes(fields.bpp)
}

