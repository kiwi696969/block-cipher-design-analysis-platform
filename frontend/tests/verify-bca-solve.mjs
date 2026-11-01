/**
 * 后端 BCA 精确求解适配层 —— 单测与源码守卫。
 *
 * 背景：2026-10-17 起，平台的数值**只来自后端 BCA 的全空间 SAT 精确解**，
 * 浏览器内引擎（束搜索）不再参与页面求值。这次改造引入了一个新的适配层
 * `src/core/bca-solve.js`，把一个 HTTP 响应翻译成页面认识的结果形状 ——
 * 它出错的方式都是**静默**的（页面照常显示，数字不对），所以断言必须落在
 * 具体字段上，而不是"能跑通"。
 *
 * 覆盖三块：
 *   【A】能力判定：哪些模板/模型有精确求解通道，其余必须**明确拒绝**
 *        （绝不偷偷退回前端引擎 —— 那会让界面显示的与实际算的不是一回事）。
 *   【B】响应解析：SAT/UNSAT 混排里取每轮最优、缺轮要标 pending、
 *        路径明细解析、变量数/子句数取后端实测值。
 *   【C】源码守卫：页面不得再调用前端求解；适配层不得依赖路径别名
 *        （它要能在 node 下被本文件直接加载）。
 *
 * 跑法：node frontend/tests/verify-bca-solve.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  bcaChannel, bestRows, bestPerRound, parsePathDetail, pickPath,
  buildFromBca, solveWithBca, BCA_ANALYSIS_TASK, BCA_ANALYSIS_MODE,
} from '../src/core/bca-solve.js'
import { BCA_CMP } from '../src/core/bca-reference.js'
import { empiricalHitRate } from '../src/core/empirical.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FRONTEND = path.resolve(HERE, '..')
const read = (p) => fs.readFileSync(p, 'utf8')

let pass = 0
const fails = []
function check(name, ok, got = '') {
  if (ok) { pass++; console.log('  ✓ ' + name); return }
  fails.push(`${name}${got !== '' ? ` —— 实得: ${got}` : ''}`)
  console.log('  ✗ ' + name + (got !== '' ? ` —— 实得: ${got}` : ''))
}

/* ================================================================ 夹具 */

/** 真实响应裁剪（任务 web / SM4 / MAP / 1-8 轮，2026-10-17 实跑） */
const RESP_1_4 = {
  ok: true,
  task: { name: 'web', cipher: 'SM4', model: 'MAP', attack: 'differential', rounds: [1, 8] },
  records: [
    { round: 1, prob: 0, result: 'SATISFIABLE', var_count: 356, clause_count: 36977, solve_time: 0.1 },
    { round: 2, prob: 0, result: 'SATISFIABLE', var_count: 584, clause_count: 73953, solve_time: 0.2 },
    { round: 3, prob: 0, result: 'SATISFIABLE', var_count: 812, clause_count: 110929, solve_time: 0.3 },
    { round: 4, prob: 0, result: 'UNSATISFIABLE', solve_time: 0.1 },
    { round: 4, prob: 1, result: 'UNSATISFIABLE', solve_time: 0.1 },
    { round: 4, prob: 6, result: 'SATISFIABLE', var_count: 1676, clause_count: 149165, solve_time: 0.5 },
  ],
  paths: [
    {
      file: 'R4-P6.txt',
      truncated: false,
      content: [
        '# SM4 R4-P6 SAT 差分路径',
        'Round 1:',
        '  state = 0x00000000 0x00008700 0x84921684 0x84929184',
        '  sbox 0: p=0 q=0  in=0x00 out=0x00',
        '  active = []',
        'Round 2:',
        '  state = 0x00008700 0x84921684 0x84929184 0x00000000',
        '  sbox 1: p=0 q=1  in=0x87 out=0x12',
        '  active = [1]',
        'final state = 0x84929184 0x84921684 0x00008700 0x00000000',
      ].join('\n'),
    },
  ],
}

/* ================================================================ A 能力判定 */

console.log('\n【A】能力判定：有通道的放行，没有的必须明确拒绝')
{
  const sm4 = bcaChannel({ engine: 'sm4', model: 'weight', mode: 'differential' })
  check('A1 SM4 + 概率权重 + 差分 → SM4 / MAP / differential',
    sm4.ok && sm4.cipher === 'SM4' && sm4.model === 'MAP' && sm4.attack === 'differential',
    JSON.stringify(sm4))

  const aes = bcaChannel({ engine: 'aes', model: 'weight', mode: 'differential' })
  check('A2 AES + 概率权重 → AES', aes.ok && aes.cipher === 'AES', JSON.stringify(aes))

  const lin = bcaChannel({ engine: 'sm4', model: 'weight', mode: 'linear' })
  check('A3 线性模式 → attack=linear', lin.ok && lin.attack === 'linear', JSON.stringify(lin))
  /* 线性必须走 LIN 模型：`attack=linear` 只换数据（LAT），MAP 仍按差分的界推进。
     用 MAP 跑 linear 会得到"看着像结果"的错口径 —— 这条锁死它。 */
  check('A3b 线性模式 → model=LIN（不是 MAP）', lin.ok && lin.model === 'LIN', JSON.stringify(lin))
  const diffModel = bcaChannel({ engine: 'sm4', model: 'weight', mode: 'differential' })
  check('A3c 差分模式仍是 MAP', diffModel.ok && diffModel.model === 'MAP', JSON.stringify(diffModel))

  for (const engine of ['present', 'aes_like', undefined]) {
    const r = bcaChannel({ engine, model: 'weight', mode: 'differential' })
    check(`A4 「${engine}」无后端实现 → 拒绝且理由点名算法范围`,
      r.ok === false && /SM4/.test(r.reason) && /没有后端/.test(r.reason),
      JSON.stringify(r))
  }

  for (const model of ['map', 'dual']) {
    const r = bcaChannel({ engine: 'sm4', model, mode: 'differential' })
    check(`A5 模型「${model}」在后端没有对应 → 拒绝并说明只有概率权重口径`,
      r.ok === false && /概率权重/.test(r.reason), JSON.stringify(r))
  }

  check('A6 任务名与模式是常量（页面与 BCA 页共享同一份产物）',
    BCA_ANALYSIS_TASK === 'web' && BCA_ANALYSIS_MODE === 'auto',
    `${BCA_ANALYSIS_TASK}/${BCA_ANALYSIS_MODE}`)
}

/* ================================================================ B 响应解析 */

console.log('\n【B】响应解析')
{
  const rows = bestRows(RESP_1_4.records)
  check('B1 每轮只留 SAT 那一条（UNSAT 试探不算结果）',
    rows.size === 4 && [1, 2, 3, 4].every((r) => rows.has(r)), `size=${rows.size}`)
  check('B2 R4 取到 prob=6（跳过 P0/P1 的 UNSAT）',
    rows.get(4).weight === 6, String(rows.get(4).weight))

  const dup = bestRows([
    { round: 5, prob: 12, result: 'SATISFIABLE' },
    { round: 5, prob: 9, result: 'SATISFIABLE' },
  ])
  check('B3 同轮多条 SAT 取最小（断点续跑会留下历史行）',
    dup.get(5).weight === 9, String(dup.get(5).weight))

  const junk = bestRows([
    { round: 1, prob: 3, result: 'TIMEOUT' },
    { round: 2, prob: 3, result: 'PENDING' },
    { round: 3, prob: 3, result: 'ERROR' },
    { round: 'x', prob: 3, result: 'SATISFIABLE' },
    { round: 4, prob: null, result: 'SATISFIABLE' },
  ])
  check('B4 非终态与脏字段一律不进结果', junk.size === 0, `size=${junk.size}`)

  check('B5 bestPerRound 是 bestRows 的数值投影',
    bestPerRound(RESP_1_4.records).get(4) === 6)

  const detail = parsePathDetail(RESP_1_4.paths[0].content)
  check('B6 路径明细解析出 2 段', detail && detail.rounds.length === 2,
    String(detail && detail.rounds.length))
  check('B7 活跃 S 盒下标解析正确', detail.rounds[1].active.join(',') === '1',
    detail.rounds[1].active.join(','))
  check('B8 首段状态 4 个字',
    Array.isArray(detail.rounds[0].state) && detail.rounds[0].state.length === 4,
    String(detail.rounds[0].state && detail.rounds[0].state.length))
  check('B9 final state 解析出来', Array.isArray(detail.finalState)
    && detail.finalState.length === 4, String(detail.finalState))
  check('B10 空文本 / 非字符串 → null',
    parsePathDetail('') === null && parsePathDetail(null) === null)
  check('B11 没有 Round 段 → null',
    parsePathDetail('随意一段文字\n没有结构') === null)

  check('B12 pickPath 按 R{轮}-P{权重}.txt 精确匹配',
    pickPath(RESP_1_4.paths, 4, 6) !== null)
  check('B13 权重不匹配 → null', pickPath(RESP_1_4.paths, 4, 12) === null)
  check('B14 截断的明细不解析（宁可不给，也不给错的）',
    pickPath([{ ...RESP_1_4.paths[0], truncated: true }], 4, 6) === null)

  const full = buildFromBca(RESP_1_4, { startRound: 1, endRound: 4 })
  check('B15 1~4 轮全部有值 → complete', full.complete === true)
  check('B16 char.weight = 6.00（第 4 轮）', full.char.weight === 6, String(full.char.weight))
  check('B17 char.rounds = 4（实际解到的轮数，不是请求的）',
    full.char.rounds === 4, String(full.char.rounds))
  check('B18 变量数/子句数取后端实测（最后一轮）',
    full.char.varCount === 1676 && full.char.clauseCount === 149165,
    `${full.char.varCount}/${full.char.clauseCount}`)
  check('B19 累计活跃 S 盒来自路径明细（0 + 1）', full.char.activeSboxes === 1,
    String(full.char.activeSboxes))
  check('B20 inputState / outputState 都有值',
    Array.isArray(full.char.inputState) && Array.isArray(full.char.outputState))
  check('B21 每轮 roundWeight 是本轮增量（0,0,0,6）',
    full.perRound.map((r) => r.roundWeight).join(',') === '0,0,0,6',
    full.perRound.map((r) => r.roundWeight).join(','))
  check('B22 后端不提供的口径一律 null（不许前端补算）',
    full.char.mapWeight === null && full.char.diffusionWeight === null
    && full.char.dataComplexity === null && full.char.dualScore === null)

  /* ⚠️ 后端 `path.py` 打印状态字是**低位在前**的，读回必须逐 32 位字位反转。
     不做（或做成字序反转）的后果不是"数字难看"，而是抽样验证拿错位的差分去真实加密，
     命中率 0/40000 —— 一个**假否定**。实测正读法 593/40000 = 1.48%（4 轮/权重 6）。 */
  check('B23 状态字按 32 位位反转读回（0x00008700 → 0x00e10000）',
    detail.rounds[0].state[1] === 0x00e10000, '0x' + detail.rounds[0].state[1].toString(16))
  check('B24 位反转是"逐字"而不是"字序反转"（4 个字各自反、顺序不变）',
    detail.rounds[0].state[0] === 0
    && detail.rounds[0].state[2] === 0x21684921
    && detail.rounds[0].state[3] === 0x21894921,
    detail.rounds[0].state.map((v) => '0x' + v.toString(16)).join(' '))
  check('B25 短字也按 32 位展开反转（0x9f00 → 0x00f90000，不是 0x9f00 / 0xf9）',
    parsePathDetail('Round 1:\n  state = 0x9f00\n  active = []\n')
      .rounds[0].state[0] === 0x00f90000)
  check('B26 超过 32 位的字不丢精度（按 8 位十六进制分段反转，保留字符串）', (() => {
    const d = parsePathDetail('Round 1:\n  state = 0x123456789abcdef0\n  active = []\n')
    const v = d?.rounds?.[0]?.state?.[0]
    return typeof v === 'string' && v === '0x1e6a2c480f7b3d59'
  })(), (() => {
    const d = parsePathDetail('Round 1:\n  state = 0x123456789abcdef0\n  active = []\n')
    return String(d?.rounds?.[0]?.state?.[0])
  })())

  /* ---- 线性（LIN）：records.prob 是 AS 阶段的 SAT，真权重在 summary 里 ---- */
  const LIN_1_4 = {
    ok: true,
    task: { name: 'web', cipher: 'SM4', model: 'LIN', attack: 'linear', rounds: [1, 4] },
    records: [
      { round: 1, prob: 0, result: 'SATISFIABLE', var_count: 232, clause_count: 20741 },
      { round: 2, prob: 0, result: 'SATISFIABLE', var_count: 336, clause_count: 41481 },
      { round: 3, prob: 0, result: 'SATISFIABLE', var_count: 440, clause_count: 62221 },
      { round: 4, prob: 0, result: 'UNSATISFIABLE' },
      { round: 4, prob: 1, result: 'SATISFIABLE', var_count: 559, clause_count: 82989 },
    ],
    summary: {
      prob_weight_bound: [0, 0, 0, 1],
      rounds: [
        { round: 1, result: 'SATISFIABLE', active_sboxes: 0, linear_weight_bound: 0, linear_weight_exact: 0 },
        { round: 2, result: 'SATISFIABLE', active_sboxes: 0, linear_weight_bound: 0, linear_weight_exact: 0 },
        { round: 3, result: 'SATISFIABLE', active_sboxes: 0, linear_weight_bound: 0, linear_weight_exact: 0 },
        { round: 4, result: 'SATISFIABLE', active_sboxes: 1, linear_weight_bound: 6,
          linear_weight_exact: 6, var_count: 1103, clause_count: 165950 },
      ],
    },
    paths: [{ file: 'R4-P1.txt', truncated: false,
      content: 'Round 4:\n  state = 0x00000001\n  active = [3]\nfinal state = 0x00000002\n' }],
  }
  const lin = buildFromBca(LIN_1_4, { startRound: 1, endRound: 4 })
  check('B27 线性权重取 summary.linear_weight_exact（R4 = 6，不是 records.prob 的 1）',
    lin.perRound.map((r) => r.weight).join(',') === '0,0,0,6',
    lin.perRound.map((r) => r.weight).join(','))
  check('B28 char.weight / mode 跟着走（6 且是线性）',
    lin.char.weight === 6 && lin.char.mode === 'linear',
    `${lin.char.weight}/${lin.char.mode}`)
  check('B29 路径明细按 AS 的 prob 找文件（R4-P1），不按回填后的 6',
    lin.char.activeSboxes === 1, String(lin.char.activeSboxes))
  check('B30 线性最后一轮的 CNF 规模取 LIN 重建后的值（1103 而非 559）',
    lin.char.varCount === 1103 && lin.char.clauseCount === 165950,
    `${lin.char.varCount}/${lin.char.clauseCount}`)

  /* `cache` / 命中覆盖的 `auto` 通道返回 `summary: null`（只读 CSV，不重建 summary）。
     线性权重不在 CSV 里 ⇒ 此时**必须**标「还未求解」，绝不能拿 records.prob(=1) 顶上。 */
  const linNoSum = buildFromBca({ ...LIN_1_4, summary: null }, { startRound: 1, endRound: 4 })
  check('B31 线性缺 summary → 全部 pending，char 为空（不拿 prob 冒充 −log₂p）',
    linNoSum.complete === false && linNoSum.char === null
    && linNoSum.perRound.every((r) => r.pending && r.weight === null),
    JSON.stringify(linNoSum.perRound.map((r) => r.weight)))
  check('B32 缺 summary 时标记 linearMissingSummary（页面据此解释原因）',
    linNoSum.linearMissingSummary === true)

  const partial = buildFromBca(RESP_1_4, { startRound: 1, endRound: 8 })
  check('B23 请求 8 轮、只解到 4 轮 → complete=false',
    partial.complete === false)
  check('B24 缺的轮次标 pending 且顺序正确',
    partial.pendingRounds.join(',') === '5,6,7,8', partial.pendingRounds.join(','))
  check('B25 solvedThrough = 4（页面据此说「已解到第 4 轮」）',
    partial.solvedThrough === 4, String(partial.solvedThrough))
  check('B26 pending 行的 weight 是 null（不是 0 —— 0 会被当成"免费轮"）',
    partial.perRound.filter((r) => r.pending).every((r) => r.weight === null))
  check('B27 未解轮次仍占位，逐轮表不会静默少行',
    partial.perRound.length === 8, String(partial.perRound.length))
  check('B28 char.endRound 跟着已解到的轮走（不谎报 8 轮）',
    partial.char.endRound === 4, String(partial.char.endRound))

  const empty = buildFromBca({ ok: true, records: [], paths: [] }, { startRound: 1, endRound: 8 })
  check('B29 一条记录都没有 → char=null（页面显示"还未求解"而不是 0）',
    empty.char === null && empty.complete === false)
  check('B30 没有结果时不能给出任何权重',
    empty.perRound.every((r) => r.pending && r.weight === null))

  const weights = BCA_CMP.map((c) => c.bca)
  check('B31 参照表的 bca 列单调不减（权重只会随轮数增加）',
    weights.every((w, i) => i === 0 || w >= weights[i - 1]), weights.join(','))
  check('B32 参照表 1~8 轮就是后端实测的 0/0/0/6/12/12/30/38',
    weights.join(',') === '0,0,0,6,12,12,30,38', weights.join(','))
}

/* ================================================================ C 源码守卫 */

console.log('\n【C】源码守卫')
{
  const storeSrc = read(path.join(FRONTEND, 'src', 'stores', 'platform.js'))
  const solveSrc = read(path.join(FRONTEND, 'src', 'core', 'bca-solve.js'))
  const resultsSrc = read(path.join(FRONTEND, 'src', 'views', 'ResultsView.vue'))

  check('C1 runAnalysis 走后端精确求解', /solveWithBca\(/.test(storeSrc))
  check('C2 适配层不依赖路径别名（否则 node 下加载不了，也就测不了）',
    !/from '@\//.test(solveSrc))
  check('C3 适配层的 HTTP 调用是注入的，不是自己 import',
    /run, progress/.test(solveSrc) && /typeof run !== 'function'/.test(solveSrc))

  /* 取 runAnalysis 的函数体来判：不能因为文件里别处还留着引擎调用就误报 */
  const bodyStart = storeSrc.indexOf('export async function runAnalysis')
  const bodyEnd = storeSrc.indexOf('export async function scanAllRounds')
  const runBody = storeSrc.slice(bodyStart, bodyEnd > bodyStart ? bodyEnd : undefined)
  check('C4 runAnalysis 体内不得直接调用引擎（analyze / sm4RoundProfile / runProfile）',
    runBody.length > 0
    && !/\bsm4RoundProfile\(/.test(runBody)
    && !/\bfeistelCharacteristicSearch\(/.test(runBody)
    && !/\brunProfile\(/.test(runBody)
    && !/[^.\w]analyze\(/.test(runBody))
  check('C5 结构被改过时拒绝走后端（结构指纹守卫）',
    /structureSignature\(graph\.value\)/.test(storeSrc))
  check('C6 起始轮 ≠ 1 时拒绝（后端轮号是"1 轮累计到 N 轮"的绝对值）',
    /r\.start\) !== 1/.test(storeSrc))

  check('C7 结果页不调用前端求解', !/\brunProfile\(/.test(resultsSrc))
  check('C8 结果页明确写「还未求解」占位',
    /还未求解/.test(resultsSrc) && /r\.pending/.test(resultsSrc))
  check('C9 结果页展示求解来源（kissat / 任务名 / 已解轮数）',
    /求解来源/.test(resultsSrc) && /kissat/.test(resultsSrc))

  /* 32 轮这种区间一定撞上后端 120s 子进程护栏；桥接层此时回
     `{ok:false, reason:'timeout', partial:{records}}`。
     若把它当失败抛掉，页面就成了"点了没反应"，而真相是"跑到了第 8 轮" ——
     正是这条测试要挡住的回退。 */
  check('C10 超时不当失败：runAnalysis 用 usableResponse 回落 partial',
    /usableResponse\(resp\)/.test(runBody) && !/if \(!resp\?\.ok\) \{\s*throw new Error\(resp\?\.error/.test(runBody))
  check('C11 只有 partial 里真的没有记录才算失败（适配层里唯一实现）',
    /partial\?\.records\?\.length/.test(solveSrc) && /export function usableResponse/.test(solveSrc))
  check('C12 结果页标出「护栏中止」并说明断点续跑',
    /护栏中止/.test(resultsSrc) && /断点继续/.test(resultsSrc))
  /* 线性必须真跑：summary 只在真跑时产出，秒出通道（cache/auto 命中）返回 null。 */
  check('C13 线性一律走 mode=run（否则拿不到线性回填权重）',
    /attack === 'linear' \? 'run'/.test(runBody))

  /* 后端求解时，"本次使用的参数"不许照抄束宽/束深/时间预算 —— 后端一个都不读。
     「建模规模分解」同理让位给后端实测的 CNF 规模（4,417 vs 1,676 那种矛盾）。 */
  check('C14 结果页过滤掉只属于前端引擎的旋钮（束宽/束深/时间预算…）',
    /ENGINE_ONLY_PARAMS/.test(resultsSrc) && /usedParams/.test(resultsSrc))
  check('C15 后端求解时「建模规模分解」不展示前端模型的明细',
    /backendInfo \? '前端建模范式/.test(resultsSrc)
    && /<template v-if="!backendInfo">/.test(resultsSrc))
}

/* ================================================================ 【D】真加密对拍
 *
 * 只靠上面的解析夹具还不够：位序错了照样能"解析成功"，只是数不对。
 * 这里读**后端真落盘**的 R4-P6 路径明细，用真实 SM4 加密抽样，验命中率落在
 * 理论值附近 —— 这是唯一能证明「读回的状态字是真实加密里的那个差分」的方法。
 *
 * 没有后端产物时**明确跳过并打印原因**，不假装通过。
 */
console.log('\n【D】真加密对拍（后端 R4-P6 路径 ⇒ 抽样命中率）')
{
  const p = path.resolve(FRONTEND, '..', 'backend', 'bca_light', 'results',
    'web', 'SM4', 'MAP', 'details', 'path', 'R4-P6.txt')
  if (!fs.existsSync(p)) {
    console.log(`  - 跳过：没有后端产物 ${p}`)
    console.log('    （先跑一次 /api/bca/run/ 生成 web 任务，或改用 npm run test:bca 之外的套件）')
  } else {
    const det = parsePathDetail(read(p))
    const rep = empiricalHitRate(
      { rounds: 4, weight: 6, startRound: 1, inputState: det.rounds[0].state, outputState: det.finalState },
      { samples: 30000, minSamples: 30000, maxBits: 30, seed: 1 },
    )
    /* λ = 30000 × 2^-6 ≈ 469，√λ ≈ 22 ⇒ 允许 ±4σ（约 ±9%）。
       位序读错时是 0 命中，与「落在区间内」差得极远 —— 这条判据非常硬。 */
    const lo = rep.expected * 0.6
    const hi = rep.expected * 1.4
    check('D1 后端路径状态字读回后，真加密命中率与理论一致（4 轮/权重 6）',
      rep.hits > 0 && rep.measured >= lo && rep.measured <= hi,
      `命中 ${rep.hits}/${rep.samples} = ${(rep.measured * 100).toFixed(2)}%（期望 ${(rep.expected * 100).toFixed(2)}%）`)
    check('D2 路径明细的 inputState 不是全零（抽样前提）',
      det.rounds[0].state.some((v) => v !== 0))
  }
}

/* ================================================================ 【E】busy 跟随
 *
 * 后端同一时刻只允许一个搜索（进程内锁）。现场最常见的动作是「点了没反应 →
 * 再点一次」，第二次会拿到 `reason:'busy'`。把它当失败，页面就写「运行失败」，
 * 进度条却停在上一次读到的 29%（实测截图就是这个组合）。
 * 正确行为：转为跟随已在进行的那次，读它的落盘进度。
 */
console.log('\n【E】连点两次（busy）⇒ 跟随进行中的任务，而不是报失败')
{
  const rec1 = { round: 1, name: 'R1-P0', prob: '1', result: 'SATISFIABLE' }
  const rec4 = { round: 4, name: 'R4-P6', prob: '2^-6', result: 'SATISFIABLE' }
  const task = { name: 'web', cipher: 'SM4', model: 'MAP', attack: 'differential', rounds: [1, 4] }
  const cacheResp = { ok: true, mode: 'cache', cached: true, task, records: [rec1, rec4] }

  /* E1：目标区间已全覆盖 → 读 cache 收工 */
  {
    const calls = []
    let round = 0
    const resp = await solveWithBca({
      cipher: 'SM4', model: 'MAP', attack: 'differential', rounds: [1, 4], task: 'web',
      run: async (p) => {
        calls.push({ ...p })
        if (calls.length === 1) return { ok: false, reason: 'busy', error: '已有 BCA 搜索在运行' }
        return cacheResp
      },
      progress: async () => ({ ok: true, finished: [1, 2, 3, 4], lastRound: 4 }),
      pollMs: 10,
    })
    check('E1 busy 不报错，改为跟随并返回结果', resp.ok === true && resp.followed === true,
      JSON.stringify({ ok: resp.ok, reason: resp.reason, followed: resp.followed }))
    check('E1 第二次请求用 mode=cache（只读产物，不重复求解）',
      calls.length === 2 && calls[1].mode === 'cache', JSON.stringify(calls.map((c) => c.mode)))
  }

  /* E2：目标 1~32 只跑到第 8 轮且停滞 → 返回已有部分，剩余标未求解 */
  {
    const resp = await solveWithBca({
      cipher: 'SM4', model: 'MAP', attack: 'differential', rounds: [1, 32], task: 'web',
      run: async (p) => (p.mode === 'cache'
        ? cacheResp
        : { ok: false, reason: 'busy' }),
      progress: async () => ({ ok: true, finished: [1, 2, 3, 4], lastRound: 4 }),
      pollMs: 10, idleMs: 50, maxMs: 400,
    })
    check('E2 区间没跑满也不报错：返回已落盘部分并标 stalled',
      resp.ok === true && resp.followed === true && resp.stalled === true
      && (resp.records || []).length === 2,
      JSON.stringify({ ok: resp.ok, stalled: resp.stalled, n: (resp.records || []).length }))
  }

  /* E3：busy 且一条记录都没有 → 老实返回失败，不许伪造成功 */
  {
    const resp = await solveWithBca({
      cipher: 'SM4', model: 'MAP', attack: 'differential', rounds: [1, 4], task: 'web',
      run: async (p) => (p.mode === 'cache'
        ? { ok: false, reason: 'no_records', error: '还没有结果' }
        : { ok: false, reason: 'busy' }),
      progress: async () => ({ ok: true, finished: [] }),
      pollMs: 10, idleMs: 40, maxMs: 200,
    })
    check('E3 跟随也拿不到记录时不假装成功（ok=false 交给上层报错）',
      resp.ok === false, JSON.stringify({ ok: resp.ok }))
  }

  /* 源码守卫：这层兜底不许被后人删掉 */
  const src = read(path.join(FRONTEND, 'src', 'core', 'bca-solve.js'))
  check('E4 适配层保留 busy 分支与跟随实现',
    /reason !== 'busy'/.test(src) && /followRunning/.test(src))
  const view = read(path.join(FRONTEND, 'src', 'views', 'AnalysisView.vue'))
  check('E5 失败横幅显示真实原因（不留一句「通常是结构不连通」的猜测）',
    /lastError/.test(view) && !/通常是结构不连通/.test(view))
  /* 未解轮次是 null，不是 0。补成 0 会让曲线在第 9 轮处从 38 直落 0 ——
     看起来像"强度骤降"，与「还未求解」是完全相反的含义。 */
  check('E6 收敛曲线不把「还未求解」的轮画成 0（先过滤 pending）',
    /filter\(\(r\) => !r\.pending\)/.test(view) && /solvedPerRound/.test(view))
  check('E7 有「继续求解剩余轮次」入口（推进只能由用户显式触发）',
    /继续求解剩余轮次/.test(view) && /forceRun: true/.test(view))
  /* 自动点火会长期占用后端的全局搜索锁，随后切到线性/别的算法全部被判 busy。
     这条守卫防止有人"好心"把它加回来。 */
  const store = read(path.join(FRONTEND, 'src', 'stores', 'platform.js'))
  check('E8 「运行分析」不自动发起长跑（读不到记录才走真跑）',
    !/timeout: 600/.test(store) && /forceRun/.test(store))
}

/* ================================================================ 汇总 */

console.log(`\n${'─'.repeat(56)}`)
if (fails.length) {
  console.log(`✗ ${pass} 通过 / ${fails.length} 失败`)
  for (const f of fails) console.log('  · ' + f)
  process.exit(1)
}
console.log(`✓ 全部 ${pass} 项通过`)
