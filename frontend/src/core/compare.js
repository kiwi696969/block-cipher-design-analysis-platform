/**
 * 方案对比 —— 把多次分析结果并排放在一起的**纯逻辑**（无 Vue、无 DOM，可单测）。
 *
 * 为什么需要它：
 *   平台能「搭结构 → 跑分析」，但每次结果都会被下一次覆盖。于是「换了 S 盒之后
 *   到底变好还是变差」这个问题，只能靠人记数字 —— 记忆不可靠，也不可复现。
 *   这里做的事就是把一份结果冻成快照，最多存 3 份并排看。
 *
 * ★ 口径（与全站一致，这里不另立一套）：
 *   每份快照的数字都是**束搜索上界** —— 找到一条具体特征，其权重 ≥ 全空间最小权重。
 *   所以两张表横着比，比的是「已知最好的一条特征有多难」，**不是**「哪个结构更安全」。
 *   束宽不同还会让上界本身松紧不同，所以 `comparability()` 必须把这些差别说出来，
 *   而不是只把数字摆在一起让人自己下结论。
 */

import { structureSignature, shortHash, structuralTokens, diffTokens } from './signature.js';

export const COMPARE_MAX = 3

/** 引擎的显示名（与 store 里「引擎：…」日志同一套说法） */
export const ENGINE_LABEL = {
  sm4: 'SM4 专用迭代',
  aes: 'AES SPN 单元引擎',
  present: 'PRESENT SPN 单元引擎',
  graph: '通用图引擎',
}

export const MODE_LABEL = {
  differential: '差分',
  linear: '线性',
}

/**
 * 数值来源的两种口径 —— 这是整个对比栏最不能含糊的一处。
 *
 *   `bca`      = 后端 BCA 全空间 SAT，**精确值（真值）**：既可达又是下界。
 *   `frontend` = 浏览器束搜索，只给**上界**：找到的那条特征不一定是最优的。
 *
 * 两者混在一张表里比高低，会把「上界松紧」误读成「结构强弱」，
 * 所以 `comparability()` 必须点名，界面上也要逐列标出来。
 */
export const SOURCE_LABEL = {
  bca: '后端 BCA 精确值',
  frontend: '浏览器束搜索上界',
}

/** 后端通道下「束搜索参数」一栏的统一文案 */
const BACKEND_NA = '—（后端不用束搜索）'

/**
 * 从一次结果造一份快照。
 *
 * @param {object} input
 *   graph      当前结构图（取名字 / 分组长度 / 声明轮数）
 *   templateId 模板 id（仅作标注，不参与判定）
 *   result     store 里的 `result` 对象（`{at, mode, params, metrics, char, perRound}`）
 *   empirical  抽样验证结果（可空）
 * @returns {object|null} 纯 JSON 可存的快照
 */
export function snapshotOf({ graph = null, templateId = '', result = null, empirical = null } = {}) {
  if (!result || !result.metrics) return null

  const p = result.params || {}
  const mt = result.metrics
  const meta = graph?.meta || {}
  const mode = result.char?.mode || result.mode || p.mode || 'differential'
  const engine = p.engine || meta.engine || 'graph'

  /* 数值来源：`backend` 存在 ⇒ 这一份是后端全空间 SAT 求出来的精确值；
     没有 ⇒ 浏览器束搜索给出的上界（含本次改造之前存下的旧结果）。
     ⚠️ 这个判断不能靠猜（比如"有 engine 就是前端"）——
        后端同样带 engine，只是它只实现了标准 SM4 / AES。 */
  const be = result.backend || null
  const source = be ? 'bca' : 'frontend'
  const exact = source === 'bca'
  const complete = exact ? Boolean(be.complete) : true

  /* 结构记号与指纹：**在算结果的那个结构上**取。
     注意这里是「此刻的图」，会话恢复时结果已按指纹校验过一致性，
     所以拿它来标注不会出现「结果属于旧结构、标注写着新结构」。 */
  const tokens = structuralTokens(graph)
  const sig = structureSignature(graph)

  const perRound = (Array.isArray(result.perRound) ? result.perRound : [])
    .filter((r) => Number.isFinite(r.weight))
    .map((r) => ({
      round: r.round,
      weight: r.weight,
      roundWeight: r.roundWeight ?? 0,
      activeSboxes: r.activeSboxes ?? 0,
      cumActive: r.cumActive ?? 0,
    }))

  const snap = {
    at: result.at || 0,
    templateId,
    /* —— 结构身份 —— */
    structureName: meta.name || templateId || '（未命名结构）',
    engine,
    /* 「谁算的」比「用什么结构的引擎」更要紧：
       后端通道下 `engine` 只是这个算法在前端对应哪条引擎，真正算数的是 BCA。 */
    engineLabel: exact
      ? `后端 BCA · ${(be.task && be.task.cipher) || 'kissat'} SAT`
      : (ENGINE_LABEL[engine] || engine),
    structure: meta.structure || '',
    blockSize: meta.blockSize ?? null,
    declaredRounds: meta.rounds ?? null,
    fingerprint: shortHash(sig),
    sig,
    tokens,
    /* —— 分析口径 —— */
    mode,
    modeLabel: MODE_LABEL[mode] || mode,
    startRound: mt.startRound,
    endRound: mt.endRound,
    rounds: mt.rounds,
    /* —— 结果 —— */
    weight: mt.weight,
    bitsPerRound: mt.bitsPerRound,
    activeSboxes: mt.activeSboxes,
    activePerRound: mt.activePerRound,
    elapsedMs: mt.elapsedMs,
    /* —— 数值口径（比数字本身更要紧） —— */
    source,
    sourceLabel: SOURCE_LABEL[source],
    exact,
    complete,
    solvedThrough: exact ? (be.solvedThrough ?? mt.endRound) : mt.endRound,
    pendingRounds: exact && Array.isArray(be.pendingRounds) ? be.pendingRounds.length : 0,
    /* —— 搜索参数（决定上界松紧，必须一起摆出来） —— */
    model: p.model || '',
    beamWidth: p.beamWidth ?? null,
    branchLimit: p.branchLimit ?? 0,
    startVariants: p.startVariants ?? null,
    maxCandidates: p.maxCandidates ?? null,
    perRound,
    empirical: empirical?.feasible
      ? {
        samples: empirical.samples,
        measured: empirical.measured,
        expected: empirical.expected,
        level: empirical.level,
      }
      : null,
  }
  snap.id = configKey(snap)
  return snap
}

/**
 * 配置指纹：哪些维度相同就算「同一次配置」。
 *
 * **不含权重** —— 同一配置重跑应该给同一个数；真给了不同的数（时间预算、
 * 机器负载、束宽被自动抬高）那是需要被看见的事件，由 `addSnapshot` 判成 replaced。
 */
export function configKey(s) {
  if (!s) return ''
  return [
    s.sig || s.fingerprint,
    s.mode,
    `${s.startRound}-${s.endRound}`,
    s.model,
    s.beamWidth,
    s.branchLimit ?? 'auto',
    s.startVariants ?? '-',
  ].join('|')
}

/**
 * 加入对比栏。
 *
 * @returns {{list:object[], action:'added'|'replaced'|'duplicate'|'full'|'invalid', index?:number, prev?:number}}
 *   `added` 新增；`replaced` 同配置但数值变了（覆盖，`prev` 是旧权重）；
 *   `duplicate` 已存在且数值相同；`full` 已满（**不动原表**，由界面提示用户先移除）。
 */
export function addSnapshot(list = [], snap, max = COMPARE_MAX) {
  if (!snap || !Number.isFinite(snap.weight)) return { list, action: 'invalid' }
  const key = configKey(snap)
  const i = list.findIndex((s) => configKey(s) === key)

  if (i >= 0) {
    const prev = list[i].weight
    if (Math.abs((prev ?? 0) - snap.weight) < 1e-9) {
      return { list, action: 'duplicate', index: i, prev }
    }
    const next = list.slice()
    next[i] = snap
    return { list: next, action: 'replaced', index: i, prev }
  }
  if (list.length >= max) return { list, action: 'full', index: -1 }
  return { list: [...list, snap], action: 'added', index: list.length }
}

/** 按 id 移除；id 不存在时原样返回（不抛） */
export function removeSnapshot(list = [], id) {
  return list.filter((s) => s.id !== id)
}

/** 图例 / 表头用的短标题：`SM4 差分 1~4轮` */
export function titleOf(s) {
  if (!s) return ''
  const name = String(s.structureName).replace(/\s+/g, '')
  return `${name} ${s.modeLabel} ${s.startRound}~${s.endRound}轮`
}

/** 序列号（#1 #2 #3）—— 表格列头与曲线共用以避免"这条线是谁" */
export function indexLabel(i) {
  return `#${i + 1}`
}

/**
 * 逐轮曲线：`[{x: 轮次, y: 累计权重, active: 累计活跃}]`。
 *
 * x 用**绝对轮次**而不是"第几个点" —— 两份快照的起始轮可能不同，
 * 按绝对轮次对齐才不会把「第 1 轮」和「第 5 轮」画在同一个刻度上。
 */
export function curveOf(snap) {
  const pr = Array.isArray(snap?.perRound) ? snap.perRound : []
  return pr.map((r) => ({ x: r.round, y: r.weight, active: r.cumActive ?? 0 }))
}

/**
 * 口径一致性检查 —— 返回要显示在对比卡顶部的提示条目。
 *
 * 这些提示是这个功能的价值所在：**先说明能不能比，再给数字**。
 * 不这么做的后果和 SM4「5 轮起偏高」那次一样 —— 用户看到两组数不一样，
 * 第一反应是「平台算错了」，而不是「口径不同」。
 *
 * @returns {{level:'ok'|'info'|'warn', text:string}[]}
 */
export function comparability(snaps = []) {
  if (snaps.length < 2) return []

  const out = []
  const uniq = (f) => new Set(snaps.map(f))

  const modes = uniq((s) => s.mode)
  if (modes.size > 1) {
    out.push({
      level: 'warn',
      text: '差分与线性结果混在同一张表里 —— 这两类特征的权重不可比（差分看概率，线性看相关度的平方），'
        + '只能各自和自己的上一次比。',
    })
  }

  const ranges = uniq((s) => `${s.startRound}-${s.endRound}`)
  if (ranges.size > 1) {
    out.push({
      level: 'warn',
      text: '轮数区间不同 —— 累计权重随轮数单调增，表头的 −log₂p 不能横着比；'
        + '要看结构差异，请把曲线按同一轮次对齐读。',
    })
  }

  const beams = uniq((s) => s.beamWidth)
  if (beams.size > 1) {
    out.push({
      level: 'warn',
      text: '束宽不同 —— 束宽越大，束搜索给出的上界越紧（数值更小）。'
        + '所以这个差别反映的是搜索力度，不是结构强弱。',
    })
  }

  const bls = uniq((s) => s.branchLimit ?? 0)
  if (bls.size > 1) {
    out.push({
      level: 'warn',
      text: '分支上限不同 —— 它截断每个活跃单元保留的候选转移数，同样影响上界松紧。',
    })
  }

  const svs = uniq((s) => s.startVariants ?? null)
  if (svs.size > 1) {
    out.push({
      level: 'info',
      text: '起点集合大小不同（SPN 引擎）—— 起点越多越可能覆盖到最优入口，数字更小不代表结构更弱。',
    })
  }

  const engines = uniq((s) => s.engine)
  if (engines.size > 1) {
    out.push({
      level: 'info',
      text: '跨引擎比较（专用迭代 / SPN 单元 / 通用图）—— 三者都按同一套 DDT/LAT 算 −log₂p，'
        + '口径一致；差别来自结构本身，这正是"设计取舍"要看的。',
    })
  }

  /* ---- 数值来源：精确值 vs 上界 ---- */

  const sources = uniq((s) => s.source || 'frontend')
  const hasExact = sources.has('bca')
  const hasBound = sources.has('frontend')

  if (hasExact && hasBound) {
    out.push({
      level: 'warn',
      text: '精确值与上界混排 —— 后端 BCA 给的是全空间真值（既可达又是下界），'
        + '浏览器束搜索给的是上界（真实最优只可能更小）。'
        + '两者的高低差里有一半是搜索力度，不能当成结构强弱来读。',
    })
  } else if (hasExact) {
    out.push({
      level: 'ok',
      text: '两边都是后端全空间 SAT 的精确值（既可达又是下界）——'
        + '差值就是两者真实的差距，可以直接比。',
    })
  } else {
    out.push({
      level: 'info',
      text: '这些数字都是束搜索的上界：只保证「找到的这条特征，其权重 ≥ 全空间最小权重」。'
        + '上界之间比高低，比的是已知最好特征的难度，不是安全强度的证明。',
    })
  }

  /* ---- 部分求解：解到第 N 轮的数不能当整段结论 ---- */
  const partial = snaps.filter((s) => s.exact && s.complete === false)
  if (partial.length) {
    const which = partial
      .map((s) => `#${snaps.indexOf(s) + 1} 只解到第 ${s.solvedThrough} 轮`)
      .join('，')
    out.push({
      level: 'warn',
      text: `有 ${partial.length} 份快照是部分求解（${which}）——`
        + '后端逐轮递增，越往后越慢。这几列的累计权重只覆盖到已解轮次，'
        + '与整段区间的数不可比。',
    })
  }

  if (!out.some((x) => x.level === 'warn' || x.level === 'ok')) {
    out.unshift({
      level: 'ok',
      text: '口径一致（同模式、同轮数区间、同搜索参数）—— 表里的数字可以直接横着比。',
    })
  }
  return out
}

/**
 * 并排表的行定义。
 *
 * 数值行带 `delta: true` —— 相对**第 1 份**（基线）的差值。
 * 刻意不给「谁最好」的徽标：权重高只说明「已知最好那条也这么难」，
 * 换成「更好 / 更差」就是把上界当成了结论。
 */
export function compareRows(snaps = []) {
  if (!snaps.length) return []
  const base = snaps[0]
  const num = (s, key, digits = 2, unit = '') => (Number.isFinite(s[key])
    ? `${Number(s[key]).toFixed(digits)}${unit}`
    : '—')
  const delta = (s, key, digits = 2) => {
    if (!Number.isFinite(s[key]) || !Number.isFinite(base[key])) return ''
    const d = s[key] - base[key]
    if (s === base || Math.abs(d) < 1e-9) return ''
    return `${d > 0 ? '+' : ''}${d.toFixed(digits)}`
  }

  return [
    { key: 'structure', label: '算法 / 结构', kind: 'text', values: snaps.map((s) => s.structureName) },
    { key: 'source', label: '数值来源', kind: 'text', values: snaps.map((s) => s.sourceLabel || '—') },
    { key: 'complete', label: '求解完整性', kind: 'text',
      values: snaps.map((s) => (s.exact
        ? (s.complete ? `全区间已求解（到第 ${s.solvedThrough} 轮）` : `部分求解（只到第 ${s.solvedThrough} 轮）`)
        : '—（束搜索不涉及）')) },
    { key: 'engine', label: '求解通道', kind: 'text', values: snaps.map((s) => s.engineLabel) },
    { key: 'blockSize', label: '分组长度', kind: 'text',
      values: snaps.map((s) => (s.blockSize ? `${s.blockSize} bit` : '—')) },
    { key: 'mode', label: '分析模式', kind: 'text', values: snaps.map((s) => s.modeLabel) },
    { key: 'range', label: '轮数区间', kind: 'text',
      values: snaps.map((s) => `第 ${s.startRound}~${s.endRound} 轮（${s.rounds} 轮）`) },

    { key: 'weight', label: '累计权重 −log₂p', kind: 'num', delta: true, unit: 'bit',
      values: snaps.map((s) => num(s, 'weight')),
      deltas: snaps.map((s) => delta(s, 'weight')) },
    { key: 'bitsPerRound', label: '平均每轮权重', kind: 'num', delta: true, unit: 'bit/轮',
      values: snaps.map((s) => num(s, 'bitsPerRound')),
      deltas: snaps.map((s) => delta(s, 'bitsPerRound')) },
    { key: 'activeSboxes', label: '活跃 S 盒 / 单元', kind: 'num', delta: true, unit: '个',
      values: snaps.map((s) => String(s.activeSboxes ?? '—')),
      deltas: snaps.map((s) => delta(s, 'activeSboxes', 0)) },
    { key: 'activePerRound', label: '平均活跃 / 轮', kind: 'num',
      values: snaps.map((s) => num(s, 'activePerRound')) },

    /* 后端通道**不用束搜索**：束宽/分支/起点这些参数对它没有意义。
       照抄界面填的值会让人以为「后端用了束宽 8」—— 那是界面的参数，不是求解器的。
       这里必须明写「不适用」，而不是给一个看起来合理的数。 */
    { key: 'model', label: '搜索模型', kind: 'text',
      values: snaps.map((s) => (s.exact ? 'MAP（后端概率权重）' : (s.model || '—'))) },
    { key: 'beam', label: '束宽', kind: 'text',
      values: snaps.map((s) => (s.exact ? BACKEND_NA : String(s.beamWidth ?? '—'))) },
    { key: 'branch', label: '分支上限', kind: 'text',
      values: snaps.map((s) => (s.exact ? BACKEND_NA : (s.branchLimit ? String(s.branchLimit) : '自动'))) },
    { key: 'starts', label: '起点数', kind: 'text',
      values: snaps.map((s) => (s.exact ? BACKEND_NA
        : (s.startVariants != null ? String(s.startVariants) : '—'))) },
    { key: 'elapsed', label: '耗时', kind: 'text', values: snaps.map((s) => `${(s.elapsedMs ?? 0).toFixed(0)} ms`) },

    { key: 'sample', label: '抽样命中率', kind: 'text',
      values: snaps.map((s) => (s.empirical
        ? `${(s.empirical.measured * 100).toFixed(4)}%（${s.empirical.samples} 样本）`
        : '未抽样')) },
    { key: 'fp', label: '结构指纹', kind: 'mono', values: snaps.map((s) => s.fingerprint) },
  ].map((r) => ({ ...r, values: r.values.map((v) => (v == null ? '—' : v)) }))
}

/**
 * 结构差异：把 A 与 B 的结构记号做差，给出人能读的一句话。
 *
 * @returns {{changed:boolean, added:{kind:string,token:string}[], removed:{kind:string,token:string}[]}}
 */
export function structuralDiff(a, b) {
  const d = diffTokens(a?.tokens || [], b?.tokens || [])
  const pack = (list) => list.map((token) => ({
    token,
    kind: token.slice(0, Math.max(0, token.indexOf('('))) || token,
  }))
  return { changed: d.added.length > 0 || d.removed.length > 0, added: pack(d.added), removed: pack(d.removed) }
}

/**
 * 只按类型归并的结构差异（如 `改 SBOX`、`新增 SBOX×2`），用于一行摘要。
 *
 * ⚠️ 同一类型在两侧都出现，**不等于**「又增又删」—— 更常见的是「这个节点改了属性」
 *    （S 盒换了一个、轮数从 32 改成 10）。直接照搬「新增 X；移除 X」会让人
 *    以为结构被拆了重建，所以这里把它归并成「改 X」。
 */
export function structuralDiffSummary(a, b) {
  const d = structuralDiff(a, b)
  if (!d.changed) return '结构相同（差别只在参数或轮数）'

  const countByKind = (list) => {
    const m = new Map()
    for (const it of list) m.set(it.kind, (m.get(it.kind) || 0) + 1)
    return m
  }
  const add = countByKind(d.added)
  const rem = countByKind(d.removed)
  const fmt = (k, n) => (n > 1 ? `${k}×${n}` : k)

  const changed = []
  const addedOnly = []
  const removedOnly = []

  for (const [k, n] of add) {
    if (rem.has(k)) {
      const m = rem.get(k)
      const common = Math.min(n, m)
      changed.push(fmt(k, common))
      if (n > common) addedOnly.push(fmt(k, n - common))
      if (m > common) removedOnly.push(fmt(k, m - common))
    } else {
      addedOnly.push(fmt(k, n))
    }
  }
  for (const [k, n] of rem) if (!add.has(k)) removedOnly.push(fmt(k, n))

  const parts = []
  if (changed.length) parts.push(`改 ${changed.join('、')}`)
  if (addedOnly.length) parts.push(`新增 ${addedOnly.join('、')}`)
  if (removedOnly.length) parts.push(`移除 ${removedOnly.join('、')}`)
  return parts.join('；')
}

/**
 * 会话恢复用：校验一份从 sessionStorage 读回来的快照还是不是可用的形状。
 * 版本升级后旧结构缺字段，宁可丢掉一条，也不要拿半份数据画曲线。
 */
export function isValidSnapshot(s) {
  return !!(s && typeof s === 'object'
    && typeof s.id === 'string'
    && Number.isFinite(s.weight)
    && Number.isFinite(s.startRound)
    && Number.isFinite(s.endRound)
    && Array.isArray(s.perRound))
}
