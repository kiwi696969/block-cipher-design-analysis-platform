/**
 * 十六进制与字节的转换、以及 S 盒数据的合法性校验。
 * 纯函数、不依赖 DOM —— 可以直接用 Node 跑测试（`node --test`）。
 */

/**
 * 宽松解析十六进制串。
 * 允许空白、逗号、换行、`0x` 前缀，以及 16 进制数字之间的任意分隔符。
 * @returns {number[]} 字节数组
 * @throws {Error} 含非法字符或长度为奇数时抛出
 */
export function parseHex(input) {
  const cleaned = String(input ?? '')
    .replace(/0[xX]/g, '')
    .replace(/[\s,;:_-]+/g, '')
    .toLowerCase()

  if (cleaned === '') return []

  const bad = cleaned.match(/[^0-9a-f]/)
  if (bad) throw new Error(`含非法字符 “${bad[0]}”，只接受 0-9 / a-f`)
  if (cleaned.length % 2 !== 0) throw new Error(`十六进制位数是奇数（${cleaned.length} 位），无法按字节解读`)

  const out = []
  for (let i = 0; i < cleaned.length; i += 2) {
    out.push(parseInt(cleaned.slice(i, i + 2), 16))
  }
  return out
}

/** 字节数组 → `d6 90 e9 fe …` 形式。 */
export function bytesToHex(bytes, separator = ' ') {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(separator)
}

/** 判断 n 是否为 2 的幂。 */
function isPowerOfTwo(n) {
  return n > 0 && (n & (n - 1)) === 0
}

/**
 * 校验一组字节能否当作 S 盒使用。
 * 判定标准：长度是 2 的幂（16 / 256 等），且所有取值构成一个置换（无重复、值域完整）。
 * 分组密码的 S 盒必须是双射，否则无法解密。
 * @returns {{ok: boolean, errors: string[], warnings: string[], isPermutation: boolean}}
 */
export function validateSbox(bytes) {
  const errors = []
  const warnings = []

  if (bytes.length === 0) {
    errors.push('数据为空')
    return { ok: false, errors, warnings, isPermutation: false }
  }

  if (!isPowerOfTwo(bytes.length)) {
    errors.push(`长度 ${bytes.length} 不是 2 的幂（合法值如 16、256）`)
  }

  const seen = new Set()
  let duplicated = false
  for (const v of bytes) {
    if (seen.has(v)) duplicated = true
    seen.add(v)
  }

  const isPermutation = !duplicated && Array.from(seen).every((v) => v < bytes.length)
  if (!isPermutation) {
    errors.push('取值不是置换：存在重复值或超出 0…' + (bytes.length - 1) + ' 的取值')
  }

  if (bytes.length === 256 && isPermutation) {
    const fixed = [...bytes].filter((v, i) => v === i).length
    const zeroMapsToSelf = bytes[0] === 0
    const identity = fixed === 256
    if (identity) warnings.push('这是恒等置换，作为 S 盒没有混淆效果')
    if (zeroMapsToSelf && !identity) {
      warnings.push('S(0) = 0，部分差分/线性分析中会退化，需注意')
    }
  }

  return { ok: errors.length === 0, errors, warnings, isPermutation }
}

/** 把 S 盒渲染成 rows × 16 的矩阵（元素为 `xx` 字符串），用于表格展示。 */
export function toMatrix(bytes, cols = 16) {
  const rows = []
  for (let i = 0; i < bytes.length; i += cols) {
    rows.push(Array.from(bytes.slice(i, i + cols)).map((b) => b.toString(16).padStart(2, '0')))
  }
  return rows
}
