/**
 * 方案对比栏回归测试（Node，无第三方依赖）
 *
 * 守五件事：
 *   ① 结构指纹**跨构建稳定**（不含 node.id / 坐标）—— 这是"同结构"判断的地基，
 *      从前它坏过一次：指纹恒不相等，会话恢复从不生效；
 *   ② 快照的形状与数值**原样搬运**，不在这里重新计算任何东西；
 *   ③ 加入/去重/覆盖/满员 的语义（尤其「同配置不同数值」必须判成 replaced）；
 *   ④ 口径提示：先说明能不能比，再摆数字；永远带上「这是上界」；
 *   ⑤ 结构差异能指名道姓地说出「S 盒换了」。
 *
 * 用法：cd frontend && node tests/verify-compare.mjs
 */

import { SBoxLibrary } from '../src/core/sboxlib.js'
import { MODE } from '../src/core/analysis.js'
import { TEMPLATES, graphEngine } from '../src/core/graph.js'
import { spnProfile } from '../src/core/spnprofile.js'
import {
  structureSignature, shortHash, structuralTokens, diffTokens,
} from '../src/core/signature.js'
import {
  COMPARE_MAX, snapshotOf, configKey, addSnapshot, removeSnapshot,
  compareRows, comparability, curveOf, titleOf, structuralDiff,
  structuralDiffSummary, isValidSnapshot,
} from '../src/core/compare.js'

new SBoxLibrary()

let passed = 0
const failures = []
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`  ✓ ${name}`) } else {
    failures.push(`${name}${detail ? ` —— ${detail}` : ''}`)
    console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`)
  }
}
const section = (t) => console.log(`\n${t}`)

/* ================================================================ 1. 结构指纹 */

section('【1】结构指纹：跨构建稳定 / 改属性就变')

const sm4a = TEMPLATES.sm4.build()
const sm4b = TEMPLATES.sm4.build()

check('同一模板两次 build 指纹相同（不含随机 node.id）',
  structureSignature(sm4a) === structureSignature(sm4b) && structureSignature(sm4a) !== '')

check('两次 build 的节点 id 确实不同（否则上一条是假通过）',
  sm4a.nodes[0].id !== sm4b.nodes[0].id)

const sm4moved = TEMPLATES.sm4.build()
sm4moved.nodes[0].x += 137
sm4moved.nodes[0].y += 91
check('只挪坐标不改指纹', structureSignature(sm4moved) === structureSignature(sm4a))

const sm4tweaked = TEMPLATES.sm4.build()
sm4tweaked.nodes.find((n) => n.type === 'TTRANS').props.tauOnly = true
check('改教学开关（仅 τ）则指纹变', structureSignature(sm4tweaked) !== structureSignature(sm4a))

check('shortHash 定长 8 位十六进制', /^[0-9a-f]{8}$/.test(shortHash(structureSignature(sm4a))))
check('shortHash 对空串也稳定', shortHash('') === shortHash(''))
check('shortHash 不同输入不同值',
  shortHash(structureSignature(sm4a)) !== shortHash(structureSignature(TEMPLATES.aes.build())))

/* ================================================================ 2. 结构记号与差异 */

section('【2】结构记号 / 差异：能指名道姓说清改了什么')

/**
 * 「换个 S 盒」的夹具用**类 AES 模板**：它带一个真的 SBOX 节点。
 * ⚠️ SM4 模板里没有 SBOX 节点（Feistel 的轮函数是隐含的），
 *    在 SM4 上找 SBOX 节点会直接拿到 undefined —— 夹具本身要先立得住。
 */
const aesBase = TEMPLATES.aes_like.build()
const aesSwapped = TEMPLATES.aes_like.build()
aesSwapped.nodes.find((n) => n.type === 'SBOX').props.sboxId = 'present'

const tokSm4 = structuralTokens(sm4a)
check('记号非空且按字典序', tokSm4.length > 0
  && tokSm4.every((t, i) => i === 0 || tokSm4[i - 1] <= t))

const dSelf = diffTokens(tokSm4, tokSm4)
check('自比为无差异', dSelf.added.length === 0 && dSelf.removed.length === 0)

const dCross = diffTokens(structuralTokens(aesBase), structuralTokens(aesSwapped))
check('换 S 盒 → 一增一减且归到 SBOX 类',
  dCross.added.length === 1 && dCross.removed.length === 1
  && dCross.added[0].startsWith('SBOX(') && dCross.removed[0].startsWith('SBOX('),
  JSON.stringify(dCross))

const rGraph = (w) => ({
  ...fakeResult(1, 4, w),
  params: { ...fakeResult(1, 4, w).params, engine: 'graph', sboxRef: 'aes' },
})
const snapAes = snapshotOf({ graph: aesBase, templateId: 'aes_like', result: rGraph(120) })
const snapAesSwapped = snapshotOf({ graph: aesSwapped, templateId: 'aes_like', result: rGraph(120) })
const snapAesAgain = snapshotOf({ graph: TEMPLATES.aes_like.build(), templateId: 'aes_like', result: rGraph(120) })

check('同结构两份快照 → 差异为「结构相同」',
  structuralDiff(snapAes, snapAesAgain).changed === false
  && structuralDiffSummary(snapAes, snapAesAgain).includes('结构相同'))
check('换 S 盒两份快照 → 差异摘要含 SBOX',
  structuralDiffSummary(snapAes, snapAesSwapped).includes('SBOX'),
  structuralDiffSummary(snapAes, snapAesSwapped))
check('同一类型改了属性 → 摘要说「改」而不是「又增又删」',
  /^改 SBOX/.test(structuralDiffSummary(snapAes, snapAesSwapped)),
  structuralDiffSummary(snapAes, snapAesSwapped))
check('换 S 盒 → 指纹不同（对比栏不会把它们当成同一次配置）',
  snapAes.fingerprint !== snapAesSwapped.fingerprint)

const crossSummary = structuralDiffSummary(
  snapshotOf({ graph: TEMPLATES.sm4.build(), result: fakeResult(1, 4, 6) }),
  snapshotOf({ graph: TEMPLATES.aes.build(), result: rGraph(217) }),
)
check('跨结构（SM4 → AES）→ 同类型归成「改」，不重复出现在新增/移除里',
  crossSummary.includes('改')
  && !/新增[^；]*\bROUND\b[^；]*；[^；]*移除[^；]*\bROUND\b/.test(crossSummary),
  crossSummary)

/* ================================================================ 3. 快照 */

section('【3】快照：只搬运，不重算')

function fakeResult(startRound, endRound, weight, extra = {}) {
  const rounds = endRound - startRound + 1
  const perRound = []
  for (let r = startRound; r <= endRound; r++) {
    const w = (weight / rounds) * (r - startRound + 1)
    perRound.push({ round: r, weight: w, roundWeight: weight / rounds, activeSboxes: 4, cumActive: 4 * (r - startRound + 1) })
  }
  return {
    at: 1700000000000,
    mode: extra.mode || MODE.DIFFERENTIAL,
    params: {
      mode: extra.mode || MODE.DIFFERENTIAL,
      engine: 'sm4',
      model: 'weight',
      beamWidth: 8,
      branchLimit: 0,
      startRound,
      endRound,
      ...extra.params,
    },
    metrics: {
      startRound, endRound, rounds,
      weight,
      bitsPerRound: weight / rounds,
      activeSboxes: 4 * rounds,
      activePerRound: 4,
      elapsedMs: 12,
    },
    char: { mode: extra.mode || MODE.DIFFERENTIAL },
    perRound,
    // 缺省 = 浏览器束搜索（上界）；给了 backend 就是后端 BCA 精确求解
    backend: extra.backend || null,
  }
}

const snap = snapshotOf({ graph: sm4a, templateId: 'sm4', result: fakeResult(1, 4, 30) })
const snapSelf = snapshotOf({ graph: sm4b, templateId: 'sm4', result: fakeResult(1, 4, 30) })
check('快照字段齐全', ['id', 'structureName', 'engine', 'fingerprint', 'mode', 'weight', 'perRound']
  .every((k) => snap[k] !== undefined && snap[k] !== null))
check('权重原样搬运（不重算）', snap.weight === 30)
check('引擎与结构名来自图', snap.engine === 'sm4' && snap.structureName.includes('SM4'))
check('逐轮条数与区间一致', snap.perRound.length === 4
  && snap.perRound[0].round === 1 && snap.perRound[3].round === 4)
check('无结果 → null（不造半份快照）', snapshotOf({ graph: sm4a, result: null }) === null)
check('结果缺 metrics → null', snapshotOf({ graph: sm4a, result: { mode: 'differential' } }) === null)
check('快照可 JSON 往返', JSON.parse(JSON.stringify(snap)).weight === 30)
check('id 就是配置指纹', snap.id === configKey(snap))

/* ================================================================ 4. 加入 / 去重 / 覆盖 / 满员 */

section('【4】对比栏的加减语义')

let list = []
let r1 = addSnapshot(list, snap)
check('首次加入 → added', r1.action === 'added' && r1.list.length === 1)
list = r1.list

const r2 = addSnapshot(list, { ...snap })
check('同配置同数值 → duplicate，且不动原表',
  r2.action === 'duplicate' && r2.list === list)

const r3 = addSnapshot(list, { ...snap, weight: 31 })
check('同配置不同数值 → replaced（这是要被看见的事件）',
  r3.action === 'replaced' && r3.list[0].weight === 31 && r3.prev === 30)

const snapB = snapshotOf({ graph: sm4a, templateId: 'sm4', result: fakeResult(1, 6, 60) })
const snapC = snapshotOf({ graph: sm4a, templateId: 'sm4', result: fakeResult(2, 6, 55) })
const snapD = snapshotOf({ graph: sm4a, templateId: 'sm4', result: fakeResult(1, 4, 30, { mode: MODE.LINEAR }) })

check('不同轮数区间 → 不同 id', snapB.id !== snap.id)
check('不同模式 → 不同 id', snapD.id !== snap.id)
check('不同束宽 → 不同 id',
  snapshotOf({ graph: sm4a, result: fakeResult(1, 4, 30, { params: { beamWidth: 16 } }) }).id !== snap.id)

list = [snap, snapB, snapC]
const rFull = addSnapshot(list, snapD)
check('满 3 项 → full，且原表不变', rFull.action === 'full' && rFull.list === list
  && list.length === COMPARE_MAX)

const rBad = addSnapshot(list, { id: 'x', weight: NaN })
check('权重非数 → invalid', rBad.action === 'invalid')

check('按 id 移除', removeSnapshot(list, snapB.id).length === 2)
check('移除不存在的 id → 原样长度', removeSnapshot(list, 'nope').length === 3)

/* ================================================================ 5. 口径提示 */

section('【5】口径提示：先说明能不能比')

const n1 = comparability([snap])
check('只有一份 → 没有可比性结论', n1.length === 0)

const nSame = comparability([snap, snapSelf])
check('同口径 → 有 ok 级提示', nSame.some((x) => x.level === 'ok'))
check('永远带上「上界」提醒', nSame.some((x) => x.text.includes('上界')))

const nMode = comparability([snap, snapD])
check('差分+线性混排 → warn', nMode.some((x) => x.level === 'warn' && x.text.includes('差分与线性')))

const nRange = comparability([snap, snapB])
check('轮数区间不同 → warn', nRange.some((x) => x.level === 'warn' && x.text.includes('轮数区间')))

const nBeam = comparability([snap,
  snapshotOf({ graph: sm4a, result: fakeResult(1, 4, 29, { params: { beamWidth: 32 } }) })])
check('束宽不同 → warn 且点明「不是结构强弱」',
  nBeam.some((x) => x.level === 'warn' && x.text.includes('束宽') && x.text.includes('不是结构强弱')))

const nCrossEngine = comparability([snap, snapshotOf({
  graph: TEMPLATES.aes.build(), templateId: 'aes',
  result: { ...fakeResult(1, 4, 40), params: { ...fakeResult(1, 4, 40).params, engine: 'aes' } },
})])
check('跨引擎 → 有 info 级说明（不判成 warn）',
  nCrossEngine.some((x) => x.level === 'info' && x.text.includes('跨引擎'))
  && !nCrossEngine.some((x) => x.level === 'warn' && x.text.includes('跨引擎')))

/* ================================================================ 5b. 数值来源 */

section('【5b】数值来源：精确值 / 上界 不能混着比')

const bcaBackend = { complete: true, solvedThrough: 4, pendingRounds: [], task: { cipher: 'SM4' } }
const snapBca = snapshotOf({
  graph: sm4a, templateId: 'sm4', result: fakeResult(1, 4, 30, { backend: bcaBackend }),
})
const snapBcaSame = snapshotOf({
  graph: sm4b, templateId: 'sm4', result: fakeResult(1, 4, 30, { backend: { ...bcaBackend } }),
})
const snapBcaPartial = snapshotOf({
  graph: sm4a, templateId: 'sm4',
  result: fakeResult(1, 2, 18, {
    backend: { complete: false, solvedThrough: 2, pendingRounds: [3, 4], task: { cipher: 'SM4' } },
  }),
})

check('无 backend → 记为束搜索上界',
  snap.source === 'frontend' && snap.exact === false && snap.sourceLabel.includes('上界'))
check('有 backend → 记为精确值', snapBca.source === 'bca' && snapBca.exact === true)
check('精确值的求解通道标成后端 BCA（不是前端引擎名）',
  snapBca.engineLabel.includes('BCA'), snapBca.engineLabel)
check('上界快照的求解通道仍是前端引擎名',
  snap.engineLabel === 'SM4 专用迭代', snap.engineLabel)
check('精确值记录求解完整性', snapBca.complete === true && snapBca.solvedThrough === 4)
check('部分求解被标出来', snapBcaPartial.complete === false && snapBcaPartial.pendingRounds === 2)

const nExact = comparability([snapBca, snapBcaSame])
check('两边都精确 → ok 且不说「都是上界」',
  nExact.some((x) => x.level === 'ok' && x.text.includes('精确值'))
  && !nExact.some((x) => x.text.includes('这些数字都是束搜索的上界')))

const nMixed = comparability([snapBca, snapSelf])
check('精确值 + 上界混排 → warn 且点明「不能当成结构强弱」',
  nMixed.some((x) => x.level === 'warn' && x.text.includes('混排')
    && x.text.includes('不能当成结构强弱')))

const nPartial = comparability([snapBca, snapBcaPartial])
check('有部分求解 → warn 且指出解到第几轮',
  nPartial.some((x) => x.level === 'warn' && x.text.includes('部分求解')
    && x.text.includes('第 2 轮')), JSON.stringify(nPartial.map((x) => x.text)))

const bcaRows = compareRows([snapBca, snapBcaPartial])
check('并排表有「数值来源」行',
  bcaRows.some((r) => r.key === 'source' && r.values[0].includes('精确')))
check('并排表有「求解完整性」行，部分求解被写明',
  bcaRows.some((r) => r.key === 'complete' && r.values[1].includes('部分求解')))

check('后端快照的束宽/分支/起点一律写「不使用束搜索」（不照抄界面参数）',
  ['beam', 'branch', 'starts'].every((k) => bcaRows
    .find((r) => r.key === k).values[0].includes('不用束搜索')),
  JSON.stringify(bcaRows.filter((r) => ['beam', 'branch', 'starts'].includes(r.key)).map((r) => r.values)))
check('后端快照的搜索模型写成 MAP',
  bcaRows.find((r) => r.key === 'model').values[0].includes('MAP'))
check('上界快照仍显示真实束宽',
  compareRows([snap, snapBca]).find((r) => r.key === 'beam').values[0] === '8',
  compareRows([snap, snapBca]).find((r) => r.key === 'beam').values[0])

/* ================================================================ 6. 并排表 */

section('【6】并排表：列数与差值')

const rows = compareRows([snap, snapB])
check('有行', rows.length > 8)
check('每行单元格数 = 快照数', rows.every((r) => r.values.length === 2))
check('基线列差值为空', rows.filter((r) => r.deltas).every((r) => r.deltas[0] === ''))
const wRow = rows.find((r) => r.key === 'weight')
check('权重行带 +30.00 差值', wRow.deltas[1] === '+30.00', JSON.stringify(wRow.deltas))
check('权重行显示两位小数', wRow.values[0] === '30.00' && wRow.values[1] === '60.00')
check('结构指纹行原样给出', rows.find((r) => r.key === 'fp').values[0] === snap.fingerprint)
check('空表 → 无行', compareRows([]).length === 0)

/* ================================================================ 7. 曲线 */

section('【7】逐轮曲线：按绝对轮次')

const cv = curveOf(snap)
check('点数 = 轮数', cv.length === 4)
check('x 是绝对轮次', cv[0].x === 1 && cv[3].x === 4)
check('y 单调不减', cv.every((p, i) => i === 0 || p.y >= cv[i - 1].y - 1e-9))
check('起始轮非 1 时 x 跟着走',
  curveOf(snapshotOf({ graph: sm4a, result: fakeResult(3, 6, 50) }))[0].x === 3)
check('无逐轮数据 → 空曲线', curveOf({ perRound: [] }).length === 0)

/* ================================================================ 8. 真引擎联调 */

section('【8】与真引擎联调（PRESENT 1~3 轮）')

const prof = spnProfile({ cipher: 'present', startRound: 1, endRound: 3, onLog: () => {} })
const realResult = {
  at: Date.now(),
  mode: MODE.DIFFERENTIAL,
  params: {
    mode: MODE.DIFFERENTIAL, engine: 'present', model: 'weight',
    beamWidth: 256, branchLimit: 4, startVariants: 3, startRound: 1, endRound: 3,
  },
  metrics: {
    startRound: 1, endRound: 3, rounds: 3,
    weight: prof.best.weight,
    bitsPerRound: prof.best.weight / 3,
    activeSboxes: prof.best.activeSboxes,
    activePerRound: prof.best.activeSboxes / 3,
    elapsedMs: 5,
  },
  char: { mode: MODE.DIFFERENTIAL, cipher: 'present' },
  perRound: prof.perRound,
}
const realSnap = snapshotOf({ graph: TEMPLATES.present.build(), templateId: 'present', result: realResult })
check('快照权重 = 引擎给的权重', realSnap && realSnap.weight === prof.best.weight,
  `${realSnap?.weight} vs ${prof.best.weight}`)
check('快照逐轮条数 = 3', realSnap.perRound.length === 3)
check('引擎标签友好', realSnap.engineLabel === 'PRESENT SPN 单元引擎')
check('快照通过 isValidSnapshot', isValidSnapshot(realSnap))

const tokenCheck = structuralTokens(TEMPLATES.present.build())
check('PRESENT 模板的引擎标记进指纹（不会与类 AES 混同）',
  graphEngine(TEMPLATES.present.build()) === 'present'
  && structureSignature(TEMPLATES.present.build()) !== structureSignature(TEMPLATES.aes.build())
  && tokenCheck.length > 0)

/* ================================================================ 9. 恢复校验 */

section('【9】会话恢复的形状校验')

check('缺 perRound → 不合法', !isValidSnapshot({ id: 'a', weight: 1, startRound: 1, endRound: 4 }))
check('权重是字符串 → 不合法',
  !isValidSnapshot({ id: 'a', weight: '30', startRound: 1, endRound: 4, perRound: [] }))
check('null → 不合法', !isValidSnapshot(null))
check('正常快照 → 合法', isValidSnapshot(snap))

/* ================================================================ 汇总 */

console.log('')
if (failures.length) {
  console.log(`✗ ${failures.length} 项失败（通过 ${passed} 项）`)
  for (const f of failures) console.log(`   - ${f}`)
  process.exit(1)
}
console.log(`✓ 全部通过：${passed} 项`)
