// ── 二进制零拷贝 Multipart 文件解析器 ───────────────────────
// 直接在 Buffer 上定位 boundary 分隔符，仅将头部转字符串解析 filename
// 正文使用 Buffer.subarray() 获取切片视图，杜绝超大字符串申请与 V8 OOM

export function parseMultipartFile(buf, boundary) {
  if (!buf || !buf.length || !boundary) return null
  const delimiter = Buffer.from(`--${boundary}`)
  const crlfCrlf = Buffer.from('\r\n\r\n')
  let searchIndex = 0

  while (searchIndex < buf.length) {
    const partStart = buf.indexOf(delimiter, searchIndex)
    if (partStart === -1) break

    const afterDelimiter = partStart + delimiter.length
    // 检查是否已到 multipart 结束界标 '--${boundary}--'
    if (buf[afterDelimiter] === 0x2D && buf[afterDelimiter + 1] === 0x2D) {
      break
    }

    const nextDelimiter = buf.indexOf(delimiter, afterDelimiter)
    if (nextDelimiter === -1) break

    // 头部区域查找 \r\n\r\n
    const headerEnd = buf.indexOf(crlfCrlf, afterDelimiter)
    if (headerEnd !== -1 && headerEnd < nextDelimiter) {
      const headerStr = buf.subarray(afterDelimiter, headerEnd).toString('utf8')

      if (/filename=/i.test(headerStr)) {
        let filename = 'upload.json'
        // 优先兼容 RFC 5987 filename*=utf-8''
        const rfcMatch = headerStr.match(/filename\*=(?:utf-8|UTF-8)''([^;\r\n]+)/i)
        if (rfcMatch) {
          try { filename = decodeURIComponent(rfcMatch[1]) } catch { /* 忽略 */ }
        } else {
          const nameMatch = headerStr.match(/filename="([^"]*)"/) || headerStr.match(/filename=([^;\r\n]+)/)
          if (nameMatch) filename = nameMatch[1].trim()
        }

        const bodyStart = headerEnd + 4
        let bodyEnd = nextDelimiter
        // 规范中 boundary 前面会有 \r\n
        if (bodyEnd >= bodyStart + 2 && buf[bodyEnd - 2] === 0x0D && buf[bodyEnd - 1] === 0x0A) {
          bodyEnd -= 2
        }

        // subarray 为零拷贝内存视图，不触发超大内存申请
        const fileBuf = buf.subarray(bodyStart, bodyEnd)
        return { fileBuf, filename }
      }
    }

    searchIndex = nextDelimiter
  }
  return null
}
