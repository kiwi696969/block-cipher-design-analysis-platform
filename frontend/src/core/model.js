/**
 * 搜索模型建模统计：变量数 / 子句数。
 *
 * 这两项指标衡量的是「把密码算法翻译成约束求解问题后，问题有多大」——
 * 也就是搜索的最内层规模。本模块**遍历真实的图结构**逐节点计数，
 * 不是估一个数填上去；所以你在结构编辑器里拖入一个组件，
 * 这两个数字会真的跟着变。
 *
 * 计数规则（与界面上的「建模口径」说明一一对应，改这里必须同步改文案）：
 *
 *   变量（布尔变量）
 *     · 状态变量    每个参与运算的比特 1 个（差分是否在该位活跃）
 *     · S 盒变量    每个 S 盒实例：输入位 + 输出位 + 1 个活跃指示变量
 *     · 线性层变量  线性层的输出每个参与位 1 个
 *     · 辅助变量    用户声明的辅助约束变量（每项 1 个）
 *     · 目标变量    1 个（承载 -log₂p 的目标函数）
 *
 *   子句（约束）
 *     · S 盒约束    每个 S 盒实例：输入活跃⇒输出活跃、输出活跃⇒输入活跃，
 *                   外加按位上下界，共 (输入位 + 输出位 + 2)
 *     · 线性层约束  每个输出位一条 XOR 等式
 *     · 分支/合并   每路 1 条
 *     · 边界约束    首轮输入差分固定、末轮输出差分固定，各若干条
 */

import { NODE_TYPES } from './graph.js'

/** 节点按 S 盒的应用方式决定实例个数 */
function sboxInstances(node, blockBits) {
  const per = node.props.mode === 'nibble' ? Math.max(1, Math.floor(blockBits / 4))
    : node.props.mode === 'byte' ? Math.max(1, Math.floor(blockBits / 8))
      : 1
  return per * Math.max(1, node.props.repeat | 0 || 1)
}

/**
 * 统计单个节点贡献的变量与子句。
 * 返回 { vars, clauses, note }，note 用于在界面上解释这一项是怎么来的。
 */
function countNode(node, ctx) {
  const { blockBits, refine } = ctx
  const t = NODE_TYPES[node.type]
  if (!t) return { vars: 0, clauses: 0, note: '' }

  switch (node.type) {
    case 'INPUT':
      // 首轮状态：每个位一个差分变量 + 边界固定约束
      return {
        vars: blockBits,
        clauses: blockBits,
        note: `初始状态 ${blockBits} 位（差分变量）+ ${blockBits} 条首轮边界约束`,
      }

    case 'OUTPUT':
      return {
        vars: 0,
        clauses: blockBits,
        note: `末轮输出差分固定：${blockBits} 条边界约束`,
      }

    case 'SBOX': {
      const inBits = 4
      const outBits = 4
      const n = sboxInstances(node, blockBits)
      const vars = n * (inBits + outBits + 1)
      const clauses = n * (inBits + outBits + 2)
      return {
        vars, clauses,
        note: `${n} 个 S 盒实例 × (输入 ${inBits} + 输出 ${outBits} + 活跃标志 1) = ${vars} 变量；`
          + `${n} × (差分可达性 + 按位界) = ${clauses} 子句`,
      }
    }

    case 'TTRANS': {
      // SM4 T 变换 = τ（4 个 8bit S 盒）∘ L；L 是线性层，只加线性约束
      const n = 4
      const sboxVars = n * (8 + 8 + 1)
      const sboxClauses = n * (8 + 8 + 2)
      const lTerms = 5 // B ⊕ B<<<2 ⊕ B<<<10 ⊕ B<<<18 ⊕ B<<<24
      const linearVars = blockBits
      const linearClauses = blockBits * (lTerms - 1)
      return {
        vars: sboxVars + linearVars,
        clauses: sboxClauses + linearClauses,
        note: `τ: ${n} 个 8bit S 盒 → ${sboxVars} 变量 / ${sboxClauses} 子句；`
          + `L: 每比特 ${lTerms} 项异或 → ${linearClauses} 条线性约束`,
      }
    }

    case 'LINEAR': {
      const terms = node.props.op === 'bitPerm' ? 1 : 5
      return {
        vars: blockBits,
        clauses: blockBits * Math.max(1, terms - 1),
        note: `线性扩散：每比特 ${terms} 项运算 → ${blockBits * Math.max(1, terms - 1)} 条等式约束`,
      }
    }

    case 'XORKEY':
      // 轮密钥异或对差分传播无影响（线性），不引入差分变量 —— 只引入密钥变量
      return {
        vars: 0,
        clauses: 0,
        note: '密钥加是线性运算，对差分/线性传播无贡献；仅引入密钥猜测变量（见「密钥猜测」项）',
      }

    case 'PERM': {
      const bytes = Math.max(1, Math.floor(blockBits / 8))
      const moves = node.props.shift ? bytes : 0
      const rev = node.props.reverse ? blockBits : 0
      return {
        vars: blockBits,
        clauses: moves + rev,
        note: moves || rev
          ? `位置重排：字节移位 ${moves} 条 + 比特反转 ${rev} 条 = ${moves + rev} 子句`
          : '未设置移位/反转 → 不产生约束（恒等映射）',
      }
    }

    case 'SPLIT':
      return { vars: blockBits, clauses: 2, note: '分支结构：2 条端口映射约束' }

    case 'MERGE':
      return { vars: blockBits, clauses: blockBits, note: `两路合并：${blockBits} 条异或约束` }

    case 'ROUND':
      return { vars: 0, clauses: 0, note: '容器标记：轮次由「迭代轮数」参数控制，本身不产生变量' }

    default:
      return { vars: 0, clauses: 0, note: '' }
  }
}

/**
 * 建模统计主函数。
 *
 * @param {CipherGraph} graph
 * @param {object} opts
 *   mode        'differential' | 'linear'
 *   rounds      实际参与建模的轮数（= endRound - startRound + 1）
 *   startRound  起始轮
 *   endRound    结束轮
 *   blockBits   参与运算的位宽（默认 32，即一个状态字）
 *   auxVars     用户声明的辅助变量个数
 *   guessRounds 密钥猜测轮数（决定密钥变量个数）
 *   refine      true 时对活跃 S 盒做精细化（只给活跃实例建变量）
 * @returns {object} 统计报告
 */
export function buildModel(graph, opts = {}) {
  const {
    mode = 'differential',
    rounds = 16,
    startRound = 1,
    endRound = null,
    blockBits = 32,
    auxVars = 0,
    guessRounds = 4,
    refine = false,
  } = opts

  const r1 = endRound != null ? endRound : startRound + rounds - 1
  const effRounds = Math.max(1, r1 - startRound + 1)
  const ctx = { blockBits, refine }

  // ── 单轮建模：把图里"一轮"的节点贡献统计出来 ──
  const nodes = graph?.nodes || []
  const perNode = []
  let roundVars = 0
  let roundClauses = 0

  // 输入/输出节点是整条链的边界，只在整模型里算一次，不按轮乘
  let boundaryVars = 0
  let boundaryClauses = 0

  for (const n of nodes) {
    const c = countNode(n, ctx)
    if (!c.vars && !c.clauses) continue
    perNode.push({ id: n.id, type: n.type, label: NODE_TYPES[n.type]?.label || n.type, ...c })

    if (n.type === 'INPUT' || n.type === 'OUTPUT') {
      boundaryVars += c.vars
      boundaryClauses += c.clauses
    } else {
      roundVars += c.vars
      roundClauses += c.clauses
    }
  }

  // ── 密钥相关变量：每轮猜测 8 bit ──
  const keyVars = Math.max(0, guessRounds | 0) * 8

  // ── 目标：1 个目标变量 + 每轮 1 条权重累加约束 ──
  const objectiveVars = 1
  const objectiveClauses = effRounds

  // ── 辅助变量：用户声明 + 每轮建模引入的松弛变量 ──
  const slackPerRound = graph?.meta?.structure === 'feistel' ? 4 : 0
  const auxTotal = Math.max(0, auxVars | 0) + slackPerRound * effRounds

  const stateVars = roundVars * effRounds
  const stateClauses = roundClauses * effRounds

  const variables = {
    state: stateVars,
    boundary: boundaryVars,
    key: keyVars,
    objective: objectiveVars,
    aux: auxTotal,
    total: stateVars + boundaryVars + keyVars + objectiveVars + auxTotal,
  }

  const clauses = {
    state: stateClauses,
    boundary: boundaryClauses,
    objective: objectiveClauses,
    total: stateClauses + boundaryClauses + objectiveClauses,
  }

  const kind = mode === 'linear' ? '线性逼近' : '差分特征'
  const structure = graph?.meta?.structure === 'feistel' ? '广义 Feistel' : 'SPN'

  return {
    mode,
    structure,
    rounds: effRounds,
    startRound,
    endRound: r1,
    blockBits,
    variables,
    clauses,
    keyVars,
    perNode,
    // 变量与子句的比例 —— 太少说明约束弱（搜索空间大），太多说明求解代价高
    ratio: variables.total ? clauses.total / variables.total : 0,
    // 供界面展示的公式说明（改计数规则时同步这里）
    formula: {
      variables: [
        `状态变量 = 单轮 ${roundVars} × ${effRounds} 轮 = ${stateVars}`,
        `边界变量 = 输入/输出固定 = ${boundaryVars}`,
        `密钥变量 = 猜测 ${guessRounds} 轮 × 8 bit = ${keyVars}`,
        `辅助变量 = 用户声明 ${auxVars} + 松弛 ${slackPerRound}×${effRounds} = ${auxTotal}`,
        `目标变量 = 1（承载 −log₂p）`,
      ],
      clauses: [
        `状态约束 = 单轮 ${roundClauses} × ${effRounds} 轮 = ${stateClauses}`,
        `边界约束 = ${boundaryClauses}`,
        `目标约束 = 每轮 1 条 × ${effRounds} = ${objectiveClauses}`,
      ],
    },
    summary: `将「${kind}」搜索建模为 ${structure} 结构、${effRounds} 轮的约束问题：`
      + `共 ${variables.total.toLocaleString()} 个布尔变量、${clauses.total.toLocaleString()} 条约束。`,
  }
}

/** 求解规模的经验评估，用于给出人话解释 */
export function modelVerdict(model) {
  const v = model.variables.total
  const c = model.clauses.total
  let level, text
  if (v < 5000) {
    level = 'small'
    text = '规模很小，约束求解器可秒级完成；适合交互式反复试算。'
  } else if (v < 50000) {
    level = 'medium'
    text = '中等规模。通用 MILP/SAT 求解器通常可在分钟内给出最优解。'
  } else if (v < 300000) {
    level = 'large'
    text = '较大规模。建议开启剪枝、限制时间预算，或改用启发式搜索。'
  } else {
    level = 'huge'
    text = '超大规模。直接精确求解不现实，本平台采用启发式（束搜索/分支限界）近似。'
  }
  return { level, text, variables: v, clauses: c, ratio: model.ratio }
}
