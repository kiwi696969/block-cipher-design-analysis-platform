/**
 * SM4 差分特征的「全空间精确下界」参照表 —— 同一组数据，两个口径。
 *
 * 为什么单独一个模块：这张表原先只长在教程页里，结果页要内联同一组对照数字时，
 * 就会出现**同一语义两处实现**（项目铁律）。所以数据 + 口径说明 + 跳转参数都收在这里，
 * 教程页与结果页都从这里取，改一处即可。
 *
 * ---------------------------------------------------------------- 两个口径
 *
 * 本平台（浏览器内引擎）：束搜索（启发式）在**默认起点集合**上找到的最优特征
 *   ⇒ **权重（−log₂p）的上界**（等价地，概率的**下界**）。
 *     权重只会偏高或相等，永远不会偏低。
 *     ⚠️ 别写成「概率的上界」—— 方向反了。上报的概率是**下界**：它只是
 *        「引擎找到的那条路径」的概率，真实最优路径只会**更容易**（概率更大）。
 *        安全含义：上报的 −log₂p 会把攻击难度说得比实际高 ⇒ **偏乐观**，
 *        不能当作安全性保证，只能当「存在一条不超过该难度的路径」的证明。
 * 后端 BCA：kissat 全空间 SAT，逐轮把 prob 从 0 往上判定到第一个 SAT
 *   ⇒ 全空间的 **精确下界**（而且是紧的：任何特征的权重都 ≥ 它，且它可达 —— 它就是真值）。
 *
 * ⚠️ 上界 ≥ 精确下界恒成立，相等才说明「这一档已经找到最优了」。
 *   实测：**只有 1~4 轮相等**；5 轮起前端每一条都劣于精确下界。
 *   根源**不是**搜索算法（束宽 8/24/64 结果全一样），而是默认起点族只覆盖了
 *   「前 3 轮免费（Δ=(a,a,a,0)）」这一族的入口 —— 把 BCA 5 轮那条 2 盒路径的起点
 *   手动喂给同一个引擎，立刻算出 12.00（见 frontend/tests/_probe-sm4-initfam.mjs）。
 *
 * ---------------------------------------------------------------- 数据来源
 *
 * 都是实测，不是抄文献：
 *   后端 —— 任务 `exact-r1-8`（SM4 / MAP / 1–8 轮，2026-10-15 实跑 584.6s），
 *           summary.prob_weight_bound = [0,0,0,6,12,12,30,38]；逐轮 SAT 记录在
 *           `backend/bca_light/results/exact-r1-8/SM4/MAP/results.csv`。
 *   前端 —— `frontend/tests/_probe-bca-cmp.mjs`（同一引擎、同一默认参数）。
 *   完整证据链 —— `outputs/BCA-平台SM4口径核对/`。
 *
 * ⚠️ 对照成立的前提（结果页据此决定是否展示对照）：同一密码（SM4）、同一模式（差分）、
 *   同一搜索模型（概率权重模型 weight，对应后端 MAP）、区间从第 1 轮打起。
 *   换这些条件后这张表**不再适用** —— 所以露出的入口都做了条件判断。
 */

/** 参照表覆盖的轮数范围（含端点） */
export const BCA_ROUND_MIN = 1
export const BCA_ROUND_MAX = 8

/**
 * 与 BCA 精确下界的逐轮对照。
 *
 * front = 本平台束搜索在默认起点集合上的结果（上界）
 * bca   = 后端全空间 SAT 的精确下界
 * same  = 两者是否相等（相等 ⇒ 前端这一档已经打到最优）
 */
export const BCA_CMP = [
  { r: 1, front: 0.00, bca: 0, same: true, note: '免费轮：轮函数输入差分恒为 0，无活跃 S 盒' },
  { r: 2, front: 0.00, bca: 0, same: true, note: '同上' },
  { r: 3, front: 0.00, bca: 0, same: true, note: '同上' },
  { r: 4, front: 6.00, bca: 6, same: true, note: '第 4 轮必然 ≥1 活跃盒（DDT 最大 4/256 ⇒ 单盒权重 ≥6）' },
  { r: 5, front: 30.00, bca: 12, same: false, note: '分岔：前端这族只能是「1 盒 + 4 盒」，精确下界只需 2 盒' },
  { r: 6, front: 49.00, bca: 12, same: false, note: '精确下界的 6 轮最优路径仍只要 2 个活跃盒' },
  { r: 7, front: 73.00, bca: 30, same: false, note: '前端 12 盒；精确下界 30 = 5 盒 × 6（该轮最少活跃盒 5）' },
  { r: 8, front: 92.00, bca: 38, same: false, note: '前端 15 盒；精确下界 38（最少 6 盒，其中有的盒未取得最大概率）' },
]

/** 取某一轮（1–N 轮区间、终点为 N）的对照行；超出参照范围返回 null */
export function bcaReference(round) {
  const r = Number(round)
  if (!Number.isFinite(r)) return null
  return BCA_CMP.find((c) => c.r === r) || null
}

/**
 * 后端 BCA 页的参数键 —— 构建链接（结果页）与解析链接（BCA 页）共用这一份，
 * 避免「一边写 start、一边读 from」这种静默错位。
 */
export const BCA_QUERY_KEYS = {
  cipher: 'cipher',
  model: 'model',
  start: 'start',
  end: 'end',
}

/**
 * 生成「去 /bca/ 精确校验 1–N 轮」的查询串（不含路径，路径由页面用 pages.js 的 href 拼）。
 * core 层不依赖路由，所以只回查询串。
 */
export function bcaCheckQuery(round) {
  const q = new URLSearchParams()
  q.set(BCA_QUERY_KEYS.cipher, 'SM4')
  q.set(BCA_QUERY_KEYS.model, 'MAP')
  q.set(BCA_QUERY_KEYS.start, String(BCA_ROUND_MIN))
  q.set(BCA_QUERY_KEYS.end, String(round))
  return `?${q.toString()}`
}
