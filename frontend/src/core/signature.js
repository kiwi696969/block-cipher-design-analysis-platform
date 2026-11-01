/**
 * 结构指纹 / 结构语义记号 —— 「这张图是不是同一张图」的**唯一**判定口径。
 *
 * 三个用途共用这一份实现（从前散落在 store 里，对比栏又需要一份，必然漂移）：
 *   1. 会话恢复：结果必须对得上它算出来的那个结构，指纹不符就整份丢弃；
 *   2. 对比栏：判断两份结果是「同结构不同参数」还是「结构真的改了」；
 *   3. 结构差异：逐记号比对，说出**改了哪一处**（S 盒？线性层？轮数？）。
 *
 * 指纹的两个要点（踩过坑）：
 *   · **不含节点坐标** —— 拖动只改布局，不改语义，带上会导致「挪一下节点结果就没了」；
 *   · **不含 node.id** —— id 由 newId() 随机生成，每次 build() 都不同，
 *     带上就永远对不上（这个坑踩过一次：指纹恒不相等，恢复从不生效）。
 */

/**
 * 结构指纹。
 *
 * `props` 一律 JSON 化后排序 —— 语义相同、字段顺序不同也算同一个结构。
 * 末尾带上边数：只删连线不删节点时，单看节点集合是察觉不到的。
 */
export function structureSignature(g) {
  if (!g) return ''
  const nodes = [...(g.nodes || [])]
    .map((n) => `${n.type}:${JSON.stringify(n.props || {})}`)
    .sort()
    .join('|')
  return `${g.meta?.name || ''}#${g.meta?.structure || ''}#${nodes}#E${(g.edges || []).length}`
}

/**
 * FNV-1a 32bit → 8 位十六进制。
 *
 * 只用来把长指纹压成界面上能看的一小串（「a3f19c02」），
 * **不承担安全语义**，也**不用于判定相等** —— 判定一律用完整 `structureSignature`。
 */
export function shortHash(s) {
  let h = 0x811c9dc5
  const str = String(s ?? '')
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    // FNV 质数 16777619，用移位凑（JS 位运算是 32bit，乘法会溢出到浮点）
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/**
 * 结构语义记号：每个节点一枚 `类型({属性})`，排序后返回。
 *
 * 对比栏靠它回答「改了什么」：两份快照的记号做集合差，
 * 多出来的就是新增/改动的那一类节点。刻意保留**全部** props ——
 * 只比节点类型的话，「把 SM4 的 S 盒换成 AES 的」这种最关键的改动会看不见。
 */
export function structuralTokens(g) {
  if (!g) return []
  return [...(g.nodes || [])]
    .map((n) => `${n.type}(${JSON.stringify(n.props || {})})`)
    .sort()
}

/** 记号的粗标签：把 `SBOX({"ref":"sm4",...})` 显示成 `SBOX` */
export function tokenKind(tok) {
  const i = String(tok).indexOf('(')
  return i > 0 ? String(tok).slice(0, i) : String(tok)
}

/**
 * 两份结构记号的多重集差（不是简单集合差 —— 同一类型可能有多个节点）。
 *
 * @returns {{added:string[], removed:string[]}} 只出现在 B 的 / 只出现在 A 的
 */
export function diffTokens(a = [], b = []) {
  const count = (list) => {
    const m = new Map()
    for (const t of list) m.set(t, (m.get(t) || 0) + 1)
    return m
  }
  const ca = count(a)
  const cb = count(b)
  const added = []
  const removed = []
  for (const [t, n] of cb) {
    const d = n - (ca.get(t) || 0)
    for (let i = 0; i < d; i++) added.push(t)
  }
  for (const [t, n] of ca) {
    const d = n - (cb.get(t) || 0)
    for (let i = 0; i < d; i++) removed.push(t)
  }
  return { added: added.sort(), removed: removed.sort() }
}
