/**
 * 参数体系：默认值 + 解析 + 装配。
 *
 * **为什么单独抽成一个纯模块（而不是留在 stores/platform.js 里）：**
 * store 用了 `@/` 别名，Node 直接 import 不了，于是参数装配这块核心逻辑
 * 没法写回归测试 —— 而它恰恰是最需要测试的部分：这里曾经漏掉
 * 「字符串 → 数组」的转换，导致 `initDiffs` 一填内容整个分析就崩
 * （`TypeError: c.inputState.join is not a function`）。
 *
 * 抽出来之后：
 *   · 纯函数、零依赖、不碰 Vue、不碰 DOM
 *   · `node tests/verify-params.mjs` 可直接验证
 *   · store 只做一层薄包装（把响应式 state 传进来）
 */

import { MODE, SEARCH_MODEL, MODEL_SPEC } from './analysis.js'
import { graphBlockBits, graphEngine } from './graph.js'

/**
 * ⚠️ 默认值只在这里写一次。界面、教程示例、测试都从这里取。
 * 改这里的值会影响「全站权威结果」，改前先跑 `node tests/verify-core.mjs`。
 */
export const PARAM_DEFAULTS = {
  startRound: 1,
  endRound: 32,

  // 搜索模型（决定"用哪个目标函数挑候选"，不影响概率怎么算）
  model: SEARCH_MODEL.WEIGHT,
  lambda: 0.5,            // 双权优化模型的 λ
  weightThreshold: 0,     // 权重阈值：0 = 不限；超过则停止继续加轮

  // 搜索策略
  searchDepth: 'beam',    // greedy | beam | exact
  beamWidth: 8,           // ← 全站统一为 8
  branchLimit: 0,         // 0 = 自动
  maxCandidates: 24,
  timeBudgetMs: 12000,

  // 复杂度模型的辅助变量
  snr: 2,
  guessRounds: 4,
  initDiffs: '',          // 留空 = 自动遍历单比特起点

  // 建模统计的辅助变量
  auxVars: 0,
}

/** 参数被夹紧到合法范围（在装配时做，避免界面传进来越界值） */
export function clampInt(v, lo, hi, dflt) {
  const n = Math.round(Number(v))
  if (!Number.isFinite(n)) return dflt
  return Math.min(hi, Math.max(lo, n))
}

/* ================================================================ 起始差分 */

const HEX8 = /^[0-9a-fA-F]{8}$/

/**
 * 解析「起始差分 / 掩码」文本 → 引擎要的 `[[a,b,c,d], ...]`。
 *
 * ⚠️ 这个函数存在的唯一原因是一个真 bug：界面收的是**字符串**，而引擎的
 * `feistelCharacteristicSearch` 期望 `initDiffs` 是**四字向量的数组**
 * （`[[0x2,0,0,0]]`）。直接透传字符串，引擎会退化成「按字符遍历」，
 * `d.slice()` 得到单个字符，最后在 `inputState.join()` 处抛
 * `TypeError: c.inputState.join is not a function`，整个分析崩掉。
 * 所以转换必须在这里完成，**不能推给引擎**。
 *
 * 接受的写法（两种都认，用户不必记格式）：
 *   · 逗号/空格分隔的字列表：`0x2,0,0,0`、`2 0 0 1`
 *   · 一个 8 位十六进制字：`00000002`（此形式**按十六进制**解读）
 *   · 多个起点用分号分隔：`0x2,0,0,0; 0,0,0,1`
 *   不足 4 个字时右侧补 0，超过 4 个截断。
 *
 * 单字判定规则：恰好 8 个十六进制字符 → 按十六进制；否则按十进制。
 * （所以 `10` 是 10，`0x10` 和 `00000010` 才是 16。）
 *
 * @returns {Array<number[]>|null} null = 交给引擎自动遍历单比特起点
 */
export function parseInitDiffs(text) {
  const s = String(text ?? '').trim()
  if (!s) return null

  const out = []
  for (const group of s.split(';')) {
    const toks = group.split(/[,\s]+/).filter(Boolean)
    if (!toks.length) continue

    const words = toks.map((t) => {
      const tk = t.trim()
      let v
      if (/^0x/i.test(tk)) v = Number.parseInt(tk.slice(2), 16)
      else if (HEX8.test(tk)) v = Number.parseInt(tk, 16)
      else v = Number.parseInt(tk, 10)
      return Number.isFinite(v) ? (v >>> 0) : 0
    })

    while (words.length < 4) words.push(0)
    out.push(words.slice(0, 4))
  }

  return out.length ? out : null
}

/**
 * 解析回执，供界面做即时校验（红框 + 提示）。
 * @returns {{ ok: boolean, parsed: Array|null, count: number, text: string }}
 */
export function describeInitDiffs(text) {
  const raw = String(text ?? '').trim()
  if (!raw) {
    return { ok: true, parsed: null, count: 0, text: '留空 = 自动遍历单比特起点' }
  }
  try {
    const parsed = parseInitDiffs(raw)
    if (!parsed) return { ok: false, parsed: null, count: 0, text: '内容为空或无法识别' }
    return {
      ok: true,
      parsed,
      count: parsed.length,
      text: `${parsed.length} 个起点：` + parsed
        .map((w) => w.map((v) => (v >>> 0).toString(16).padStart(8, '0')).join(' '))
        .join(' ｜ '),
    }
  } catch (err) {
    return { ok: false, parsed: null, count: 0, text: `解析失败：${err.message}` }
  }
}

/* ================================================================ 装配 */

/**
 * 🔑 唯一的参数装配入口。
 *
 * 任何地方要调引擎 —— 运行分析、全轮扫描、教程示例、结果页的模型对比、
 * 回归测试 —— 都必须走这里，不要自己拼一份。
 * 历史上两条路径用过不同的 beamWidth，同一个轮数给出两个数，
 * 用户以为平台有两套结果。
 *
 * @param {object}  opts
 *   params   参数对象（可以是 Vue 的 reactive，也可以是普通对象）
 *   mode     'differential' | 'linear'
 *   graph    CipherGraph（用来读教学对照开关）
 *   overrides 允许调用方覆盖单项（仍以 base 为准做夹紧前的替换）
 * @returns {object} 可直接喂给引擎的选项对象
 */
export function buildSearchOptions({ params = {}, mode = MODE.DIFFERENTIAL, graph = null, overrides = {} } = {}) {
  const p = { ...PARAM_DEFAULTS, ...params }

  const startRound = clampInt(p.startRound, 1, 64, 1)
  const endRoundRaw = clampInt(p.endRound, 1, 64, 32)
  // 区间倒挂自动对齐到起始轮（但不回写输入框 —— 回写会让告警静默消失）
  const endRound = Math.max(startRound, endRoundRaw)

  const opts = {
    mode,
    startRound,
    endRound,
    model: MODEL_SPEC[p.model] ? p.model : SEARCH_MODEL.WEIGHT,
    lambda: Number(p.lambda) || 0,
    searchDepth: ['greedy', 'beam', 'exact'].includes(p.searchDepth) ? p.searchDepth : 'beam',
    beamWidth: clampInt(p.beamWidth, 1, 64, 8),
    maxCandidates: clampInt(p.maxCandidates, 1, 512, 24),
    timeBudgetMs: clampInt(p.timeBudgetMs, 200, 60000, 12000),
    snr: Number(p.snr) || 2,
    guessRounds: clampInt(p.guessRounds, 0, 32, 4),

    /* —— 以下三项从前是写死的，现在从图上派生 ——
     * `blockBits` 原为常量 32，`sboxRef` 原为常量 'sm4'，`engine` 根本没有：
     * 结果是「画布上选了 AES S 盒、位宽设成 24bit」也到不了引擎。 */
    blockBits: graphBlockBits(graph),
    structure: STRUCTURES.includes(graph?.meta?.structure) ? graph.meta.structure : 'spn',
    engine: graphEngine(graph),
    sboxRef: firstSBoxRef(graph) || 'sm4',

    ...overrides,
  }

  // 0 表示「自动」：交给引擎按策略决定（引擎里 null = 自动）
  const bl = clampInt(p.branchLimit, 0, 64, 0)
  if (bl > 0) opts.branchLimit = bl

  // ⚠️ 必须转成数组再交给引擎 —— 透传字符串会让引擎抛
  //    `inputState.join is not a function`（详见 parseInitDiffs 的注释）
  const init = parseInitDiffs(p.initDiffs)
  if (init) opts.initDiffs = init

  // 结构编辑器里的两个教学对照开关。
  // 只有 Feistel/SM4 迭代引擎认识它们；不在这里读过来，
  // 界面上就能勾但结果毫无变化 —— 那就是"哑开关"。
  const tt = findTTrans(graph)
  if (tt) {
    opts.tauOnly = !!tt.props?.tauOnly
    opts.linearS = !!tt.props?.linearS
  }

  return opts
}

function findTTrans(graph) {
  const nodes = graph?.nodes
  if (!Array.isArray(nodes)) return null
  return nodes.find((n) => n.type === 'TTRANS') || null
}

/**
 * 引擎**真正实现**的结构类型 —— 也就是结构编辑器下拉里能选的那两个。
 *
 * ⚠️ 别再往这里加没有引擎的值。加了就等于给用户一个「改了却不影响计算」的开关：
 * `platform.js` 只对 `'feistel'` 走图迭代（`feistelGraphProfile`），其余一律 SPN 单趟传播。
 * 曾经这里有过 `'gfn'`（广义 Feistel），而下拉里选它结果和不选一样 —— 正是要防的那类
 * 「界面与计算不一致」。
 */
export const STRUCTURES = ['spn', 'feistel']

export const STRUCTURE_LABELS = {
  spn: 'SPN（代换-置换网络）',
  feistel: 'Feistel（左右两半迭代）',
}

/**
 * 模型里认得、但**还没有专属引擎**的结构标记。
 * 下拉不提供，只可能从导入的 JSON（`meta.structure`）里出现；
 * 界面会明确提示它按 SPN 计算，而不是让它悄悄改不动计算。
 */
export const UNSUPPORTED_STRUCTURES = {
  gfn: '广义 Feistel（多分支）',
}

/**
 * 图上第一个 S 盒节点用的 S 盒 —— 供需要「单一 sboxRef」的调用方参考。
 * 通用图传播路径不看它（每个 S 盒节点各自带着自己的 sboxId），
 * 但报告/导出需要一个代表性的值。
 */
function firstSBoxRef(graph) {
  const nodes = graph?.nodes
  if (!Array.isArray(nodes)) return null
  const n = nodes.find((x) => x.type === 'SBOX' && x.props?.sboxId)
  return n ? String(n.props.sboxId) : null
}

/**
 * 教学对照开关的当前状态。null = 未打开（界面据此决定要不要显示警告）。
 */
export function teachingFlagsOf(graph) {
  const tt = findTTrans(graph)
  if (!tt) return null
  const tauOnly = !!tt.props?.tauOnly
  const linearS = !!tt.props?.linearS
  if (!tauOnly && !linearS) return null
  return { tauOnly, linearS }
}

/**
 * 区间是否倒挂（用于界面常驻告警，注意不要回写输入框）。
 * @returns {string|null}
 */
export function roundRangeIssueOf(params = {}) {
  const s = Number(params.startRound)
  const e = Number(params.endRound)
  if (!Number.isFinite(s) || !Number.isFinite(e)) return null
  if (s > e) return `起始轮 ${s} 大于结束轮 ${e}，已自动按 ${s}~${s} 处理（原输入保持不变）`
  if (s < 1) return '起始轮不能小于 1'
  return null
}

/** 实际生效的轮数区间（徽标展示用） */
export function effectiveRangeOf(params = {}) {
  const s = clampInt(params.startRound, 1, 64, 1)
  const e = Math.max(s, clampInt(params.endRound, 1, 64, 32))
  return { start: s, end: e, rounds: e - s + 1 }
}
