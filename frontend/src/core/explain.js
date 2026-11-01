/**
 * 中文解析引擎：把图结构、轮函数、搜索结果翻译成人话。
 *
 * 为什么要单独一个模块：这些文案要同时出现在
 * 结构编辑器、分析页、教程页三处。集中在这里，改一次全站一致；
 * 散落在各个 .vue 里必然会走样（技能文档里「哑开关」那条讲的就是这类问题）。
 */

import { NODE_TYPES, CATEGORY_LABELS } from './graph.js'

/* ============================================================
 * 一、算法结构解析
 * ============================================================ */

/**
 * 解析整张图，产出「这是什么算法、每部分干什么」的中文说明。
 * @returns {{ title, subtitle, structure, paragraphs, components, variables }}
 */
export function explainGraph(graph) {
  if (!graph) return null
  const meta = graph.meta || {}

  const structureText = {
    feistel: '广义 Feistel 结构：把状态切成若干字，每轮只用轮函数处理其中一部分，'
      + '再与另一部分异或后轮转位置。解密与加密结构相同（轮密钥逆序），硬件实现省面积。',
    spn: 'SPN 结构（代换-置换网络）：每轮对**整个**状态做 S 盒代换，再做线性扩散。'
      + '轮函数作用范围大，扩散更快，但加解密流程不同。',
    gfn: 'GFN 结构（广义 Feistel 网络）：Feistel 的多分支推广，兼顾扩散速度与实现成本。',
  }[meta.structure] || '未指定结构类型。'

  const paragraphs = []

  paragraphs.push({
    h: '算法概述',
    p: `${meta.name || '未命名算法'}${meta.standard ? `（${meta.standard}）` : ''}，`
      + `分组长度 ${meta.blockSize || '?'} bit，密钥长度 ${meta.keySize || '?'} bit，`
      + `共 ${meta.rounds || '?'} 轮。` + (meta.note ? ` ${meta.note}。` : ''),
  })

  paragraphs.push({ h: '整体结构', p: structureText })

  // 轮函数的组成 —— 按拓扑序描述数据怎么流
  const order = safeTopo(graph)
  const kinds = order
    .filter((n) => !['INPUT', 'OUTPUT', 'ROUND'].includes(n.type))
    .map((n) => NODE_TYPES[n.type]?.label)
    .filter(Boolean)

  if (kinds.length) {
    paragraphs.push({
      h: '轮函数数据流',
      p: `一轮的计算顺序是：${kinds.join(' → ')}。`
        + '差分/线性掩码就沿着这条路径逐节点传播，每个 S 盒处引入一次「不确定性」（概率由 DDT/LAT 查表决定），'
        + '线性层则确定性地重排比特位置。',
    })
  }

  // 逐组件解析
  const components = order.map((n, i) => {
    const t = NODE_TYPES[n.type]
    if (!t) return null
    return {
      index: i + 1,
      id: n.id,
      type: n.type,
      label: t.label,
      category: t.category,
      categoryLabel: CATEGORY_LABELS[t.category] || t.category,
      color: t.color,
      icon: t.icon,
      desc: t.desc,
      // 该组件在差分/线性分析中的意义 —— 这是初学者最需要的一层
      analysisRole: analysisRole(n.type, n.props),
      props: Object.entries(n.props || {}).map(([k, v]) => ({
        key: k,
        label: t.props.find((p) => p.key === k)?.label || k,
        value: typeof v === 'boolean' ? (v ? '是' : '否') : String(v),
      })),
    }
  }).filter(Boolean)

  return {
    title: meta.name || '未命名算法',
    subtitle: [meta.standard, meta.structure === 'feistel' ? '广义 Feistel' : 'SPN']
      .filter(Boolean).join(' · '),
    variables: graph.variables || [],
    paragraphs,
    components,
  }
}

/** 单个组件在差分/线性分析里扮演什么角色 */
function analysisRole(type, props = {}) {
  switch (type) {
    case 'INPUT':
      return '分析起点。这里选定「输入差分 Δin」——整条特征就是从这个扰动开始演化出来的。'
    case 'OUTPUT':
      return '分析终点。统计到这一轮为止的累计概率，就是这条特征的可利用程度。'
    case 'SBOX':
      return '**唯一的不确定性来源**。差分经过它时有多种可能输出，每种的概率由 DDT 查表给出。'
        + 'S 盒的差分均匀度 DU 越小，单个活跃 S 盒泄漏的概率越低。'
    case 'TTRANS':
      if (props.tauOnly) {
        return '⚠ 已开启「仅 τ」：跳过 L 线性扩散层。差分只会在字节内部扩散，'
          + '无法跨字节传播 —— 这是教学对照，安全性会大幅下降。'
      }
      if (props.linearS) {
        return '⚠ 已开启「线性化 S 盒」：S 盒被当作恒等映射，差分确定性直通，'
          + '概率退化为 1 —— 存在必然成立的差分路径，这是教学对照。'
      }
      return 'SM4 的 T 变换 = τ（4 个 SM4 S 盒并行）后接 L 线性变换。'
        + 'τ 提供非线性，L 负责把一个字节的扰动扩散到整个 32 位字。'
    case 'LINEAR':
      return '线性扩散层。**不引入不确定性**（概率恒为 1），但决定差分能铺多宽：'
        + '扩散越好，同样轮数下被激活的 S 盒越多，累计概率下降越快。'
    case 'XORKEY':
      return '轮密钥异或。对差分传播**没有影响**（两个明文都异或同一个密钥，差分不变）——'
        + '这正是差分分析成立的前提。'
    case 'PERM':
      return '位置重排。把比特/字节搬到别处，好让下一轮的 S 盒作用到不同的位上。'
    case 'SPLIT':
      return '把状态分成多路，是 Feistel 类结构的标志。'
    case 'MERGE':
      return '把多路合并回一路，通常与轮函数输出异或。'
    case 'ROUND':
      return '轮容器：其内部结构按「迭代轮数」重复执行。'
    default:
      return ''
  }
}

function safeTopo(graph) {
  try {
    const order = graph.topoOrder()
    return order.length ? order : graph.nodes
  } catch {
    return graph.nodes
  }
}

/* ============================================================
 * 二、逐轮特征解析（分析完成后）
 * ============================================================ */

/**
 * 把搜索结果翻译成逐轮 + 总结的中文说明。
 * @param {object} char  最优特征
 * @param {object} sboxStats  S 盒指标（来自 lib.stats()）
 */
export function explainCharacteristic(char, sboxStats = null) {
  if (!char) return null

  const isLinear = char.mode === 'linear'
  const kind = isLinear ? '线性逼近' : '差分特征'
  const steps = char.feistelSteps || char.steps || []
  const rounds = char.rounds

  const summary = []
  const r0 = char.startRound ?? 1
  const r1 = char.endRound ?? rounds

  summary.push({
    h: `这条${kind}是什么`,
    p: `起点：第 ${r0} 轮，输入${isLinear ? '掩码' : '差分'} `
      + `${fmtState(char.inputState, stateDigits(char))}。`
      + `终点：第 ${r1} 轮，输出${isLinear ? '掩码' : '差分'} ${fmtState(char.outputState, stateDigits(char))}。`
      + `整条路径的累计权重 −log₂p = ${char.weight.toFixed(2)}，`
      + `意味着${isLinear ? '线性相关' : '发生概率'}约为 2^${(-char.weight).toFixed(0)}。`,
  })

  summary.push({
    h: '怎么读这个数字',
    p: isLinear
      ? `线性分析的权重越小，说明「输入掩码与输出掩码的线性相关」越强，`
        + `攻击者可利用的偏差越大。${char.weight.toFixed(2)} bit 的权重对应相关度 2^-${(char.weight / 2).toFixed(1)}。`
      : `差分特征的权重越小，说明「按这个差分走」的概率越高，攻击需要的数据量越小。`
        + `权重的含义是概率的负二进制对数：权重 ${char.weight.toFixed(2)} → 概率 2^-${char.weight.toFixed(2)}。`,
  })

  summary.push({
    h: '活跃 S 盒',
    p: `整条路径共激活 ${char.activeSboxes} 个 S 盒（累计），平均每轮 `
      + `${(char.activeSboxes / rounds).toFixed(2)} 个。`
      + '活跃 S 盒越少，特征概率越高。密码设计者的目标就是让「任何特征的最少活跃 S 盒数」尽量大 ——'
      + '这叫**扩散层设计准则**（宽轨迹策略）。',
  })

  // 挑出最有信息量的几轮单独讲
  const notable = []
  if (steps.length) {
    const firstActive = steps.findIndex((s) => (s.activeSboxes || 0) > 0)
    if (firstActive >= 0) {
      notable.push({
        round: (steps[firstActive].round ?? firstActive + 1),
        text: `首个活跃 S 盒出现在这里 —— 在此之前差分只在比特/字节间平移，不产生概率损失。`
          + `从这轮起，每经过一个活跃 S 盒，概率就要乘上约 2^-6（SM4 的最大差分概率）。`,
      })
    }
    // 单轮权重最大的那几轮
    const sorted = [...steps].map((s, i) => ({ i, w: s.roundWeight || 0 }))
      .sort((a, b) => b.w - a.w).slice(0, 3)
    for (const { i, w } of sorted) {
      if (w <= 0) continue
      notable.push({
        round: steps[i].round ?? i + 1,
        text: `本轮权重 ${w.toFixed(2)} bit，激活 ${steps[i].activeSboxes || 0} 个 S 盒`
          + `（${(steps[i].activeSboxes || 0)} × 6 = ${((steps[i].activeSboxes || 0) * 6)} bit 是这一轮的主要开销）。`,
      })
    }
  }

  return { kind, isLinear, summary, notable, steps, rounds, startRound: r0, endRound: r1 }
}

/* ============================================================
 * 三、安全性解读
 * ============================================================ */

/**
 * 综合 S 盒指标与特征权重，给出「这个算法目前算不算安全」的通俗结论。
 */
export function explainSecurity(char, sboxStats, modelInfo = null) {
  const out = []
  if (!char) return out

  // 1. S 盒层面
  if (sboxStats) {
    const du = sboxStats.differentialUniformity
    const nl = sboxStats.nonlinearity
    out.push({
      h: 'S 盒的质量',
      level: sboxStats.grade?.level === 'A' ? 'good' : sboxStats.grade?.level === 'D' ? 'bad' : 'warn',
      p: `差分均匀度 DU = ${du}（越小越好），非线性度 NL = ${nl}（越大越好），`
        + `最大差分概率 2^${Math.log2(sboxStats.maxDifferentialProb).toFixed(1)}。`
        + `${sboxStats.grade?.text || ''}`,
    })
  }

  // 2. 特征层面
  const bitsPerRound = char.weight / char.rounds
  let level, verdict
  if (char.weight === 0) {
    level = 'bad'
    verdict = '存在概率为 1 的确定性路径 —— 该结构不具备任何差分/线性抵抗力，必须修正。'
  } else if (bitsPerRound < 1) {
    level = 'bad'
    verdict = '每轮仅损失不到 1 bit 熵，扩散严重不足，实际不可用。'
  } else if (bitsPerRound < 8) {
    level = 'warn'
    verdict = '每轮熵损失偏低。可能存在可利用的多轮特征，建议增加轮数或改进扩散层。'
  } else if (bitsPerRound < 16) {
    level = 'ok'
    verdict = '扩散水平中等，具备基本抵抗力但仍需关注更长的轮数。'
  } else {
    level = 'good'
    verdict = '每轮熵损失充分，长轮数下累计概率呈指数下降 —— 这是安全设计的正常表现。'
  }

  out.push({
    h: '该结构的抵抗力',
    level,
    p: `平均每轮损失 ${bitsPerRound.toFixed(2)} bit 熵（${char.activeSboxes} 个活跃 S 盒 / ${char.rounds} 轮）。${verdict}`,
  })

  // 3. 攻击代价
  if (char.dataComplexity) {
    out.push({
      h: '攻击者要付多大代价',
      level: 'info',
      p: `按这条最优特征估算：数据复杂度约 2^${char.dataComplexity} 对明密文，`
        + `时间复杂度约 2^${char.timeComplexity}，需猜测密钥 ${char.keyGuesses} bit。`
        + `${char.dataComplexity > 100 ? '这已远超任何现实算力，'
          + '说明该轮数下差分分析不可行。' : '数据集规模在理论可行范围内，需要配合其它技术（如截断差分）。'}`,
    })
  }

  if (modelInfo) {
    out.push({
      h: '搜索规模',
      level: 'info',
      p: modelInfo.summary,
    })
  }

  return out
}

/* ============================================================
 * 四、工具
 * ============================================================ */

/**
 * 状态数组 → 可读串。
 *
 * @param {number[]} state
 * @param {number} digits 每个单元的十六进制位数（默认 8 = 32bit 字）
 *
 * ⚠️ AES 是 16 个**字节**状态、PRESENT 是 16 个**半字节**状态。
 *    若一律按 8 位补零，界面上会出现 `0x00000055, 0x000000e5, …` 十六项 ——
 *    看起来像 16 个 32bit 字，读的人会直接误解成 512bit 状态。
 *    按单元位宽补零、且不加分隔符（当字节串读），才是它们该有的样子。
 */
export function fmtState(state, digits = 8) {
  if (!state || !state.length) return '(未记录)'
  const w = Math.max(1, Math.min(8, digits | 0 || 8))
  const items = state.map((v) => (v >>> 0).toString(16).padStart(w, '0'))
  // 字（8 位）按「字列表」显示；字节/半字节按连续串显示
  return '(' + (w >= 8 ? items.map((s) => '0x' + s).join(', ') : items.join('')) + ')'
}

/** 由特征决定状态该按几位十六进制显示 */
export function stateDigits(char) {
  if (!char) return 8
  if (char.cipher === 'present') return 1
  if (char.cipher === 'aes') return 2
  return 8
}

export function fmtBits(x) {
  if (x === null || x === undefined) return '-'
  const n = Number(x)
  if (!Number.isFinite(n)) return '-'
  if (n >= 1000) return `2^${n.toFixed(0)}`
  if (n >= 10) return `2^${n.toFixed(1)}`
  return `2^${n.toFixed(2)}`
}

/** 用于格式化运行时长 */
export function fmtMs(ms) {
  if (ms === null || ms === undefined) return '-'
  if (ms < 1000) return `${ms.toFixed(0)} ms`
  return `${(ms / 1000).toFixed(2)} s`
}

export function fmtInt(n) {
  if (n === null || n === undefined) return '-'
  return Number(n).toLocaleString('zh-CN')
}
