/**
 * 后端 BCA 全空间精确求解的适配层。
 *
 * ---------------------------------------------------------------- 为什么需要这一层
 *
 * 本平台原先由浏览器内引擎（束搜索）求特征 —— 它给出的是**权重（−log₂p）的上界**，
 * 因为搜索只走默认起点族。5 轮起这个上界必然劣于全空间最优（实测 30 vs 12），
 * 于是页面上会出现两个口径的数字，讲起来容易被追问「到底哪个是准的」。
 *
 * 现在改为：**页面只显示后端 BCA 的全空间精确值**（kissat SAT，概率权重从 0
 * 往上判定到第一个 SAT ⇒ 该值既可达、又是下界，即真值）。
 * 本模块负责把 `/api/bca/run/` 的响应（records / paths）翻译成页面认识的
 * `{ char, perRound }` 形状，让渲染层不必为「数据来自前端还是后端」分叉。
 *
 * ---------------------------------------------------------------- 支持范围（重要）
 *
 * 后端 `CIPHER_REGISTRY` 只有 SM4 / AES / DBlock-128/192/256 / Rijndael256；
 * 前端模板里的 PRESENT、类-AES 教学模型、用户自搭图**没有后端实现**，
 * 因此它们没有精确求解通道 —— 这种情况必须**明确报错**，绝不偷偷退回前端引擎，
 * 否则又会变成「界面显示的和实际算的不是一回事」。
 *
 * 模型同理：后端 MAP 才是「概率权重」口径（前端 weight ⇄ MAP 是唯一有实测对照的
 * 一一对应）。前端 map（概率映射期望）与 dual（双权 J）在后端没有对应模型，
 * 走后端时不能假装它们可用。
 *
 * ---------------------------------------------------------------- 依赖约定
 *
 * 本模块**不 import 任何 HTTP 客户端**：`run` / `progress` 由调用方注入
 * （store 传 `api.bcaRun` / `api.bcaProgress`）。这样它在 node 下可以直接被
 * 单测加载，不必给测试造一套路径别名解析。
 */

/** 前端模板（graph.meta.engine）→ 后端算法名。不在此表 = 无精确求解通道。 */
export const BCA_CIPHER_BY_ENGINE = {
  sm4: 'SM4',
  aes: 'AES',
}

/** 前端搜索模型 → 后端模型。只有概率权重有确证对应（MAP）。 */
export const BCA_MODEL_BY_SEARCH = {
  weight: 'MAP',
}

/**
 * 线性攻击必须换成 `LIN` 模型。
 *
 * 后端的模型与攻击是两个联合参数：`attack=linear` 只把**数据**换成 LAT
 * （CNF 里的禁止模式来自线性子句），而 `MAP` 仍然按**差分**的界推进；
 * `LIN` 才是「复用 AS 主循环 + 搜完逐盒查 |LAT| 回填线性权重」的那条路径。
 * 用 MAP 跑 linear 拿回来的数看着像结果，其实是错口径 —— 所以在这里定死。
 */
export const BCA_MODEL_BY_ATTACK = {
  linear: 'LIN',
}

/** 后端支持的攻击类型（BCA 页的 attack 取值） */
export const BCA_ATTACK = {
  differential: 'differential',
  linear: 'linear',
}

/**
 * 「运行分析」用的固定任务名。
 *
 * 与 BCA 页的默认值一致 ⇒ 两处共享同一个 `results/{task}/` 目录，
 * 断点续跑的产物互认（在 BCA 页预热过的轮次，结果页直接秒出）。
 */
export const BCA_ANALYSIS_TASK = 'web'

/** 默认求解模式：auto = 已有记录覆盖整段轮数就秒出，否则真跑（缺口由断点续跑补） */
export const BCA_ANALYSIS_MODE = 'auto'

/**
 * 判断当前「模板 + 模型 + 模式」有没有后端精确求解通道。
 *
 * @returns {{ok: true, cipher: string, model: string, attack: string}
 *          | {ok: false, reason: string}}
 */
export function bcaChannel({ engine, model, mode }) {
  const cipher = BCA_CIPHER_BY_ENGINE[engine]
  if (!cipher) {
    return {
      ok: false,
      reason: `「${engine || '当前图'}」没有后端 BCA 实现 —— 精确求解通道只覆盖 `
        + `${Object.values(BCA_CIPHER_BY_ENGINE).join(' / ')}。`
        + '（PRESENT、类-AES 教学模型、自定义图暂无精确求解，请改用内置 SM4 / AES 模板）',
    }
  }
  const backendModel = BCA_MODEL_BY_SEARCH[model]
  if (!backendModel) {
    return {
      ok: false,
      reason: '后端 BCA 精确求解只提供「概率权重」口径（MAP 模型）；'
        + '概率映射模型与双权优化模型没有后端实现，'
        + '请把搜索模型选为「概率权重模型」再运行。',
    }
  }
  const attack = BCA_ATTACK[mode] || BCA_ATTACK.differential
  return { ok: true, cipher, model: BCA_MODEL_BY_ATTACK[attack] || backendModel, attack }
}

/* ---------------------------------------------------------------- 响应解析 */

/** 终态结果：只有这两种才算「这一轮已经有答案」 */
const TERMINAL = new Set(['SATISFIABLE', 'UNSATISFIABLE'])

/**
 * 每轮取「最小 SAT 概率权重」的那一行（保留整行，后面要读变量数/子句数/耗时）。
 *
 * BCA 的工作方式是从小到大递增试探概率权重，一路 UNSAT 直到某个值 SAT ——
 * 所以同一轮里会有 `0,0,0,...,SAT` 这样一串记录。界面要的是那条 SAT 的值。
 * 同轮出现多条 SAT 时取最小（断点续跑可能留下历史行）。
 *
 * @returns {Map<number, {round: number, weight: number, raw: object}>}
 */
export function bestRows(records) {
  const best = new Map()
  /* ⚠️ `Number(null) === 0`、`Number('') === 0` —— CSV 里的空字段会一路变成
     "权重 0"，看起来像「免费轮」，实际是「没有这个数」。必须先判空再转换。 */
  const blank = (v) => v === null || v === undefined || v === ''
  for (const row of records || []) {
    if (String(row?.result || '').toUpperCase() !== 'SATISFIABLE') continue
    if (blank(row.round) || blank(row.prob)) continue
    const round = Number(row.round)
    const weight = Number(row.prob)
    if (!Number.isInteger(round) || !Number.isFinite(weight)) continue
    const cur = best.get(round)
    if (!cur || weight < cur.weight) best.set(round, { round, weight, raw: row })
  }
  return best
}

/** 每轮的最优权重（只要数值时用这个） */
export function bestPerRound(records) {
  const out = new Map()
  for (const [round, hit] of bestRows(records)) out.set(round, hit.weight)
  return out
}

/**
 * 解析后端落盘的路径明细（`details/path/R{n}-P{w}.txt`）。
 *
 * 格式（BCA 生成，逐轮一段）::
 *
 *     Round 1:
 *       state = 0x00000000 0x00008700 ...
 *       sbox 0: p=0 q=0  in=0x00 out=0x00
 *       active = []
 *     ...
 *     final state = 0x84929184 ...
 *
 * 只取页面需要的三样：每轮状态、每轮活跃 S 盒下标、末状态。
 * ⚠️ 状态字读回时**逐 32 位字位反转**（见 `stateWords` 的注释）—— 后端打印是低位在前。
 * 解析失败返回 null —— 路径明细只是补充信息，缺了不影响权重这个主数值。
 */
export function parsePathDetail(text) {
  if (typeof text !== 'string' || !text) return null
  const rounds = []
  let finalState = null
  let cur = null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    const mRound = /^Round\s+(\d+):$/i.exec(line)
    if (mRound) {
      cur = { round: Number(mRound[1]), state: null, active: [] }
      rounds.push(cur)
      continue
    }
    if (/^final\s+state\s*=/i.test(line)) {
      finalState = stateWords(line.split('=')[1])
      cur = null
      continue
    }
    if (!cur) continue
    if (line.startsWith('state')) {
      cur.state = stateWords(line.split('=')[1])
      continue
    }
    const mActive = /^active\s*=\s*\[(.*)\]$/.exec(line)
    if (mActive) {
      cur.active = mActive[1]
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s !== '')
        .map(Number)
        .filter(Number.isInteger)
    }
  }
  if (!rounds.length) return null
  return { rounds, finalState }
}

/**
 * 把一个 32 位字按位反转。
 *
 * ---------------------------------------------------------------- 为什么必须转
 *
 * 后端 `bca/util/path.py` 打印状态字时走的是**低位在前**的顺序（§4.37 记过这一条，
 * 当时的结论是「不改后端、读取端反转」）。页面如果照抄打印值：
 *
 *   · 抽样验证会拿一个错位的差分去真实加密，命中 0 次，
 *     而期望是 1.56%（4 轮 / 权重 6）—— 结论变成「特征未得到验证」，是**假否定**；
 *   · 逐轮表的「状态」列也会显示一个真实加密里不存在的值。
 *
 * 实测（`tests/_probe-bca-states.mjs`，SM4 R4-P6，40000 对真实加密）：
 *
 *   原样 0/40000 ｜ 字序反转 0/40000 ｜ **逐字位反 32 → 593/40000 = 1.48%** ｜
 *   位反 + 字序反转 0/40000（期望 1.56%，λ≈625）
 *
 * ⇒ 正确读法只有一种：**逐 32 位字位反转，字序不动**。
 */
function reverseBits32(v) {
  let x = v >>> 0
  let r = 0
  for (let i = 0; i < 32; i++) {
    r = ((r << 1) | (x & 1)) >>> 0
    x >>>= 1
  }
  return r >>> 0
}

/** `0x00000000 0x00008700 …` → [0, 0x8700, …]（已按 32 位位反转读回） */
function stateWords(side) {
  if (!side) return null
  const out = []
  for (const tok of side.trim().split(/\s+/)) {
    if (!/^0x[0-9a-f]+$/i.test(tok)) continue
    const hex = tok.slice(2)
    if (hex.length <= 8) {
      out.push(reverseBits32(Number.parseInt(hex, 16)))
      continue
    }
    /* 超过 32 位的字（当前后端不会出现，留个不丢精度的兜底）：
       按 8 位十六进制一段各自位反转，段序不变，结果用 BigInt 拼回字符串。 */
    const chunks = []
    for (let i = hex.length; i > 0; i -= 8) {
      const seg = hex.slice(Math.max(0, i - 8), i)
      chunks.unshift(reverseBits32(Number.parseInt(seg, 16)).toString(16).padStart(seg.length, '0'))
    }
    out.push('0x' + chunks.join(''))
  }
  return out.length ? out : null
}

/**
 * 从 `paths` 数组里挑出「第 round 轮、权重 weight」那一条路径明细。
 * 文件名是 `R{round}-P{weight}.txt`（BCA 的 `Task` 命名规则）。
 */
export function pickPath(paths, round, weight) {
  const name = `R${round}-P${weight}.txt`
  const hit = (paths || []).find((p) => p?.file === name)
  if (!hit) return null
  if (hit.truncated) return null // 截断的内容解析出来可能是错的，宁可不给
  return parsePathDetail(hit.content)
}

/**
 * 从 `summary.rounds` 的一行里取**权威权重**。
 *
 * 取用顺序：`linear_weight_exact`（LIN 搜完逐盒查 |LAT| 回填的精确线性权重）
 * → `linear_weight_bound`（AS 阶段的界）→ `prob`（差分的概率权重）。
 *
 * ⚠️ 不能统一读 `prob`：线性记录里的 `prob` 是 **AS 的 SAT 值**（活跃盒数下界），
 * 与真实线性权重不是同一个量（实测 SM4 线性 R4：prob=1 / exact=6.0）。
 */
function roundWeightOf(row) {
  for (const k of ['linear_weight_exact', 'linear_weight_bound', 'prob']) {
    const v = row?.[k]
    if (v === null || v === undefined || v === '') continue
    const n = Number(v)
    if (Number.isFinite(n)) return n
  }
  return null
}

/**
 * 把 BCA 响应组装成页面要的 `{ char, perRound, metrics }`。
 *
 * @param resp    `/api/bca/run/` 的响应体
 * @param opts.startRound / endRound  请求的区间（后端只回区间内的记录）
 *
 * 未求解的轮次**保留在 perRound 里并标 `pending: true`** —— 这样页面能把
 * 「第 9 轮还未求解」画成一行占位，而不是静默少一行让人以为只有 8 轮。
 */
export function buildFromBca(resp, { startRound, endRound }) {
  const best = bestRows(resp?.records)
  /* 逐轮摘要（`summary.rounds`）是**唯一同时覆盖差分与线性**的地方。
     ⚠️ 线性（LIN）记录里的 `prob` 是 **AS 阶段的 SAT**（活跃盒数下界），
     真正的线性权重在 `linear_weight_exact`（搜完逐盒查 |LAT| 回填）。
     实测 SM4 线性 R4：record.prob = 1，linear_weight_exact = 6.0 ——
     照 `prob` 显示会把线性强度说小 5 bit，是「口径冒充」的经典形态。 */
  const sumByRound = new Map()
  for (const row of resp?.summary?.rounds || []) {
    const rd = Number(row?.round)
    if (Number.isInteger(rd)) sumByRound.set(rd, row)
  }
  /* 线性**只认 summary**：`records.prob` 是 AS 阶段的活跃盒数，不是 −log₂p；
     而 `summary` 只在**真跑**时产出（`search=false` 的秒出通道返回 null）。
     ⇒ 线性拿不到 summary 时，只能如实标 pending，不许拿 prob 顶上。 */
  const isLinear = (resp?.task?.attack || resp?.records?.[0]?.attack) === 'linear'
  const perRound = []
  let prevWeight = 0
  let cumActive = 0

  for (let round = startRound; round <= endRound; round++) {
    const hit = best.get(round)
    const srow = sumByRound.get(round)
    const fromSummary = srow && String(srow.result || '').toUpperCase() === 'SATISFIABLE'
      ? roundWeightOf(srow)
      : null
    const weight = isLinear
      ? fromSummary                       // 线性：只有回填值可用
      : (fromSummary != null ? fromSummary : (hit ? hit.weight : null))
    if (weight == null) {
      perRound.push({
        round,
        weight: null,
        roundWeight: null,
        activeSboxes: null,
        cumActive: null,
        pending: true,
      })
      continue
    }
    /* 路径明细的文件名用的是 **AS 阶段那个 prob**（`R{n}-P{prob}.txt`），
       不是线性回填后的权重 —— 所以按 `hit.weight` 找文件，按 `weight` 报数。 */
    const detail = hit ? pickPath(resp?.paths, round, hit.weight) : null
    const roundActive = detail
      ? detail.rounds.reduce((n, x) => n + x.active.length, 0)
      : (Number.isFinite(Number(srow?.active_sboxes)) ? Number(srow.active_sboxes) : null)
    if (roundActive !== null) cumActive += roundActive
    perRound.push({
      round,
      weight,
      roundWeight: weight - prevWeight,
      activeSboxes: roundActive,
      cumActive: roundActive === null ? null : cumActive,
      state: detail?.rounds?.[detail.rounds.length - 1]?.state ?? null,
      pending: false,
    })
    prevWeight = weight
  }

  const done = perRound.filter((x) => !x.pending)
  const last = done.length ? done[done.length - 1] : null

  /* 首轮状态 = 第 1 段 state，末状态 = `final state`。
     ⚠️ 两者都可能缺（路径明细被截断或没落盘），此时给 null，页面显示「—」，
        不要用别的轮次的值顶替。 */
  const lastHit = last ? best.get(last.round) : null
  const lastSrow = last ? sumByRound.get(last.round) : null
  const firstDetail = last && lastHit
    ? pickPath(resp?.paths, last.round, lastHit.weight)
    : null
  const inputState = firstDetail?.rounds?.[0]?.state ?? null
  const outputState = firstDetail?.finalState
    ?? (firstDetail?.rounds?.length
      ? firstDetail.rounds[firstDetail.rounds.length - 1].state
      : null)

  /* 缺轮 = 后端还没跑到的那些。有缺轮时**不能**把已有轮的权重当整段区间的最优值
     —— 那会把「跑到第 8 轮」说成「32 轮的结果」。 */
  const pendingRounds = perRound.filter((x) => x.pending).map((x) => x.round)
  const complete = pendingRounds.length === 0

  /* 最后一轮的原始记录：变量数 / 子句数从这里取，不用前端建模统计补。
     两个数必须来自同一个求解器，否则「变量数」说的是前端模型、「权重」说的是
     后端结果，同一张卡片混两个来源。
     线性（LIN）在 AS 的 SAT 之后还会重建一次受限 CNF，规模以 `summary` 那行为准。 */
  const toInt = (v) => {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  /* 累计求解耗时：只累加真正出了结果的轮（UNSAT 的试探也耗时间，
     但那些行没有 prob、对"得到这个答案花了多久"没有解释力）。 */
  const solveTime = [...best.values()]
    .reduce((sum, h) => sum + (Number(h.raw?.solve_time) || 0), 0)

  const char = last
    ? {
      /* 攻击类型从响应里读：线性结果挂错 `mode` 会让结果页把它画成「差分特征」
         （标题、逐轮表头、中文解析全跟着错），比数字错更难发现。 */
      mode: ((resp?.task?.attack || resp?.records?.[0]?.attack) === 'linear')
        ? 'linear' : 'differential',
      startRound,
      endRound: last.round,
      rounds: last.round - startRound + 1,
      weight: last.weight,
      activeSboxes: last.cumActive ?? null,
      branchCount: null,
      inputState,
      outputState,
      /* 建模范畴的实测规模（该轮 CNF 的变量/子句数）—— 后端真实建出来的，
         不是前端估的 */
      varCount: toInt(lastSrow?.var_count) ?? (lastHit ? toInt(lastHit.raw?.var_count) : null),
      clauseCount: toInt(lastSrow?.clause_count) ?? (lastHit ? toInt(lastHit.raw?.clause_count) : null),
      solveTime: solveTime || null,
      /* 后端不提供这三种复杂度与映射指标 —— 明确 null，页面显示「—」。
         绝不用前端引擎算一份补进来：那会让同一页混两个来源。 */
      dataComplexity: null,
      timeComplexity: null,
      memoryComplexity: null,
      keyGuesses: null,
      mapWeight: null,
      diffusionWeight: null,
      dualScore: null,
      mapSizeLog10: null,
    }
    : null

  return {
    char,
    perRound,
    complete,
    pendingRounds,
    solvedThrough: last ? last.round : null,
    task: resp?.task || null,
    summary: resp?.summary || null,
    /* 线性且没有 summary ⇒ 页面要能解释「为什么全是还未求解」，
       而不是让人以为后端坏了 */
    linearMissingSummary: isLinear && !sumByRound.size,
  }
}

/* ---------------------------------------------------------------- 求解入口 */

/**
 * 把 `/api/bca/run/` 的响应归一成「能拿来渲染的那份数据」。
 *
 * ⚠️ **超时 ≠ 失败**。桥接层有子进程护栏（`BCA_DEFAULT_TIMEOUT`，默认 120s），
 * 32 轮这种区间**必然**在护栏处被掐断，此时返回的是
 * `{ok:false, reason:'timeout', timeout:120, partial:{records, paths, ...}}` ——
 * `partial` 里是**已经落盘的那些轮**。
 *
 * 若按 `ok === false` 直接抛错，页面就变成「点了没反应」，而真相是「已经跑到第 8 轮」。
 * 所以：有 `partial.records` 就照常渲染（其余轮标 `pending`），只有连一条记录都没有
 * 才算真失败。
 *
 * @returns {{data: object, timedOut: boolean, timeout?: number}|null}
 *          返回 null 表示「这次确实没拿到任何可渲染的数据」
 */
export function usableResponse(resp) {
  if (resp?.ok) return { data: resp, timedOut: false }
  const partial = resp?.reason === 'timeout' ? resp?.partial : null
  if (!partial?.records?.length) return null
  return {
    data: { ...partial, task: resp?.task || null },
    timedOut: true,
    timeout: resp?.timeout,
  }
}

/**
 * 已有搜索在跑（`reason === 'busy'`）时，转为**跟随它**，而不是报错。
 *
 * 为什么必须这样做：后端的搜索是进程内单例锁（`_RUN_LOCK`），同一时刻只允许
 * 一个 BCA 子进程。现场最常见的动作是「点了没反应 → 再点一次」，第二次就会
 * 拿到 `busy`。把它当失败，页面会写「运行失败」并把上一次的进度条留在 29%，
 * 而真实情况是第一次搜索正跑到第 9 轮 —— 用户会以为平台坏了。
 *
 * 跟随策略：读 `/api/bca/progress/`（不碰求解器）看轮次落盘进度；
 *   - 目标区间全覆盖 → 用 `mode=cache` 把结果读回来（毫秒级）
 *   - 长时间没有新轮落盘（默认 30s）或总时长超过上限（默认 120s）
 *     → 同样读回已有轮次，剩余轮次由调用方标「还未求解」
 * 任何情况下都只在拿到记录时返回 `ok:true`；一条都没有才让调用方报错。
 */
async function followRunning({
  payload, run, progress, onProgress,
  pollMs = 2000, maxMs = 120000, idleMs = 30000,
}) {
  const start = Number(payload.rounds[0])
  const end = Number(payload.rounds[1])
  const readCache = () => run({ ...payload, mode: 'cache' })
  const t0 = Date.now()
  let lastCount = -1
  let lastChange = Date.now()

  for (;;) {
    let p = null
    try {
      p = await progress({ task: payload.task, cipher: payload.cipher, model: payload.model })
    } catch {
      // 进度读取失败不算错，POST/cache 的返回才是权威
    }
    if (p) {
      onProgress(p)
      const done = new Set((p.finished || []).map(Number))
      const covered = []
      for (let r = start; r <= end; r++) if (done.has(r)) covered.push(r)
      if (covered.length > lastCount) {
        lastCount = covered.length
        lastChange = Date.now()
      }
      if (covered.length === end - start + 1) {
        const resp = await readCache()
        return { ...resp, followed: true, cached: true }
      }
    }
    if (Date.now() - lastChange > idleMs || Date.now() - t0 > maxMs) {
      const resp = await readCache()
      return { ...resp, followed: true, cached: true, stalled: true }
    }
    await new Promise((resolve) => { setTimeout(resolve, pollMs) })
  }
}

/**
 * 向后端要一次精确求解。
 *
 * `mode` 的语义完全交给后端（`cache` 只读已有产物、`auto` 有缓存就秒出、
 * `run` 强制重跑）—— 前端不再判断「有没有缓存」，避免两套规则漂移。
 *
 * @param opts.cipher / model / attack   见 bcaChannel() 的返回
 * @param opts.rounds                    [start, end]
 * @param opts.task                      输出目录名（同一 task 共享断点续跑产物）
 * @param opts.mode                      'auto' | 'cache' | 'run'
 * @param opts.run / opts.progress       注入的 HTTP 调用（见文件头的依赖约定）
 * @param opts.onProgress                轮询回调（长请求期间给界面反馈）
 * @param opts.pollMs                    轮询间隔，默认 2000
 * @param opts.maxMs / opts.idleMs       `busy` 跟随的时长上限 / 停滞判定（默认 120s / 30s）
 */
export async function solveWithBca({
  cipher, model, attack = 'differential',
  rounds, task = 'web', mode = 'auto',
  timeout, solveTimeout,
  run, progress,
  onProgress = () => {}, pollMs = 2000,
  maxMs = 120000, idleMs = 30000,
}) {
  if (typeof run !== 'function' || typeof progress !== 'function') {
    throw new Error('solveWithBca 需要注入 run / progress 两个 HTTP 调用')
  }
  const payload = {
    cipher,
    model,
    attack,
    rounds: [Number(rounds[0]), Number(rounds[1])],
    task,
    mode,
  }
  if (timeout !== undefined && timeout !== null && timeout !== '') {
    payload.timeout = Number(timeout)
  }
  if (solveTimeout !== undefined && solveTimeout !== null && solveTimeout !== '') {
    payload.solve_timeout = Number(solveTimeout)
  }

  /* 进度轮询：POST 是同步长请求（32 轮可能几小时），期间除了转圈什么都没有。
     这条 GET 不碰求解器，可以和未返回的 POST 并存（后端有明确说明）。 */
  let timer = null
  const tick = async () => {
    try {
      const p = await progress({ task, cipher, model })
      onProgress(p)
    } catch {
      // 进度是锦上添花，失败不打扰；POST 的返回才是权威
    }
  }
  timer = setInterval(tick, pollMs)
  tick()

  try {
    const resp = await run(payload)
    if (resp?.reason !== 'busy') return resp
    /* 已有搜索在跑 —— 跟随它，不当作失败（见 followRunning 的注释） */
    return await followRunning({
      payload, run, progress, onProgress, pollMs, maxMs, idleMs,
    })
  } finally {
    clearInterval(timer)
  }
}
