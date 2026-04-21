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
  // TIFF byte order alone ("II"/"MM") is also valid plain text.
  if (
    (bytes.length >= 8 &&
      (startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a]))) ||
    (bytes.length >= 16 &&
      (startsWith(bytes, [0x49, 0x49, 0x2b, 0x00, 0x08, 0x00, 0x00, 0x00]) ||
        startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2b, 0x00, 0x08, 0x00, 0x00])))
  )
    return "image/tiff"
  // ISO BMFF: inspect major and compatible brands, never a filename extension.
  if (bytes.length >= 16 && startsWith(bytes.subarray(4), [0x66, 0x74, 0x79, 0x70])) {
    const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const size = header.getUint32(0)
    if (size >= 16 && size <= bytes.length && size % 4 === 0) {
      const brands = [
        header.getUint32(8),
        ...Array.from({ length: (size - 16) / 4 }, (_, index) => header.getUint32(16 + index * 4)),
      ]
      // avif/avis take precedence over the generic HEIF container brands.
      if (brands.some((brand) => brand === 0x61766966 || brand === 0x61766973)) return "image/avif"
      // heic/heix/hevc/hevx encode HEVC images; mif1/msf1 denote HEIF containers.
      if (brands.some((brand) => [0x68656963, 0x68656978, 0x68657663, 0x68657678].includes(brand)))
        return "image/heic"
      if (brands.some((brand) => brand === 0x6d696631 || brand === 0x6d736631)) return "image/heif"
    }
  }
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf"
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50])) {
    return "image/webp"
  }

  return fallback
}
