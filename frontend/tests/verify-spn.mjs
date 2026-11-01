/**
 * 完整 AES-128 / PRESENT-64 引擎回归测试（Node，无第三方依赖）
 *
 * 这个文件守四件事，任何一件破了都说明「平台号称能算 AES/PRESENT」是假的：
 *   ① 参考实现能对上**官方向量**（FIPS-197 / PRESENT 附录 I）—— 算法本身对
 *   ② 掩码层与差分层的转置关系成立 —— 线性分析不是瞎算
 *   ③ 逐轮基准值（单盒最大概率、前两轮盒数与权重）
 *   ④ 用**真实加密抽样**复核引擎给的概率 —— 引擎自证不算数
 *
 * 用法：cd frontend && node tests/verify-spn.mjs
 *
 * ⚠️ 期望值的来源，别乱改：
 *   AES：FIPS-197 附录 C.1（密文）、附录 A.1（轮密钥）；单盒最大差分概率 2^-6
 *        （差分均匀度 4 / 256）；wide-trail 下界见 AES_TRAIL_BOUND（本文件里也钉住）。
 *   PRESENT：原始论文附录 I 四组向量；单盒最大差分概率 2^-2（4/16）；
 *        14 轮最优差分特征 2^-62 出自 Wang 2008（本平台束搜索给 2^-68，是上界）。
 */

import { SBoxLibrary } from '../src/core/sboxlib.js'
import { MODE } from '../src/core/analysis.js'
import { TEMPLATES, graphEngine, USER_TEMPLATE_IDS } from '../src/core/graph.js'
import { spnProfile } from '../src/core/spnprofile.js'
import { empiricalHitRate } from '../src/core/empirical.js'
import {
  aesEncrypt, aesKeySchedule128, hexToBytes, bytesToHex,
  presentEncrypt, presentNibblesToHex,
  selfCheck, SPN_CIPHERS,
} from '../src/core/spnref.js'

new SBoxLibrary()

let passed = 0
const failures = []
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`  ✓ ${name}`) } else {
    failures.push(`${name}${detail ? ` —— ${detail}` : ''}`)
    console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`)
  }
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps
const section = (t) => console.log(`\n${t}`)

/* ================================================================ 1. 官方向量 */

section('【1】参考实现 · 官方测试向量')

check('AES-128 FIPS-197 C.1 加密',
  bytesToHex(aesEncrypt(hexToBytes('00112233445566778899aabbccddeeff'),
    hexToBytes('000102030405060708090a0b0c0d0e0f')))
  === '69c4e0d86a7b0430d8cdb78070b4c55a')

const aesRk = aesKeySchedule128(hexToBytes('2b7e151628aed2a6abf7158809cf4f3c'))
check('AES-128 FIPS-197 A.1 首轮密钥 w[0..3]',
  bytesToHex(aesRk[0]) === '2b7e151628aed2a6abf7158809cf4f3c')
check('AES-128 FIPS-197 A.1 末轮密钥 w[40..43]',
  bytesToHex(aesRk[10]) === 'd014f9a8c9ee2589e13f0cc8b6630ca6')

check('PRESENT-80 key=0 pt=0',
  presentNibblesToHex(presentEncrypt(new Array(16).fill(0), 0n)) === '5579c1387b228445')
check('PRESENT-80 key=0 pt=F…F',
  presentNibblesToHex(presentEncrypt(new Array(16).fill(0xf), 0n)) === 'a112ffc72f68417b')
check('PRESENT-80 key=F…F pt=0',
  presentNibblesToHex(presentEncrypt(new Array(16).fill(0), (1n << 80n) - 1n)) === 'e72c46c0f5945049')
check('PRESENT-80 key=F…F pt=F…F',
  presentNibblesToHex(presentEncrypt(new Array(16).fill(0xf), (1n << 80n) - 1n)) === '3333dcd3213210d2')

/* ================================================================ 2. 掩码对偶 */

section('【2】掩码层 ⇄ 差分层的转置关系（线性分析的正确性判据）')

for (const id of ['aes', 'present']) {
  const r = selfCheck(id, { trials: 128 })
  check(r.detail, r.ok)
}

/* ================================================================ 3. S 盒指标 */

section('【3】S 盒指标（决定单盒概率）')

const lib = globalThis.__SBOX_LIB__
for (const [id, wantDu, wantProbBits] of [['aes', 4, 6], ['present', 4, 2]]) {
  const sb = lib.getSBoxByRef(id)
  check(`${id} 差分均匀度 = ${wantDu}`, sb.differentialUniformity().value === wantDu,
    String(sb.differentialUniformity().value))
  const probBits = Math.log2(sb.inSize / wantDu)
  check(`${id} 单盒最大差分概率 = 2^-${wantProbBits}`, near(probBits, wantProbBits), String(probBits))
}

/* ================================================================ 4. 逐轮基准 */

section('【4】逐轮基准（束搜索给出的具体特征）')

const aes1 = spnProfile({ cipher: 'aes', mode: MODE.DIFFERENTIAL, rounds: 1, onLog: () => {} })
check('AES 1 轮：1 个活跃盒，权重 6.00',
  aes1.perRound[0].activeCells === 1 && near(aes1.perRound[0].weight, 6),
  `${aes1.perRound[0].activeCells} 盒 / ${aes1.perRound[0].weight}`)

const aes2 = spnProfile({ cipher: 'aes', mode: MODE.DIFFERENTIAL, rounds: 2, onLog: () => {} })
check('AES 2 轮：4 个活跃盒（1 字节 → 列混淆铺满一列），累计 30.00',
  aes2.perRound[1].activeCells === 4 && near(aes2.perRound[1].weight, 30),
  `${aes2.perRound[1].activeCells} 盒 / ${aes2.perRound[1].weight}`)

const aes10 = spnProfile({ cipher: 'aes', mode: MODE.DIFFERENTIAL, rounds: 10, onLog: () => {} })
const aesBoxes = aes10.perRound.map((p) => p.activeCells)
check('AES 3 轮起每轮 ≥15 个活跃盒（列混淆铺满全状态）',
  aesBoxes.slice(2).every((v) => v >= 15), aesBoxes.join('/'))
check('AES 权重逐轮单调递增',
  aes10.perRound.every((p, i) => i === 0 || p.weight >= aes10.perRound[i - 1].weight))

/* wide-trail 下界（Daemen–Rijmen，任意特征的活跃盒数 ≥ 这些值）。
   ⚠️ 这是**下界**：本平台搜到的是具体特征，盒数只会 ≥ 它 —— 两者不矛盾。
   这里钉住它，是为了防止有人把「我们搜到的 127 盒」误读成「AES 10 轮只有 127 盒的强度上限」。 */
const AES_TRAIL_BOUND = [1, 5, 9, 25, 26, 30, 34, 50, 51, 55]
check('AES 各轮搜到的活跃盒数都 ≥ wide-trail 下界',
  aes10.perRound.every((p, i) => p.cumActive >= AES_TRAIL_BOUND[i]),
  aes10.perRound.map((p, i) => `${p.cumActive}≥${AES_TRAIL_BOUND[i]}`).join(' '))

const pres1 = spnProfile({ cipher: 'present', mode: MODE.DIFFERENTIAL, rounds: 1, onLog: () => {} })
check('PRESENT 1 轮：1 个活跃盒，权重 2.00',
  pres1.perRound[0].activeCells === 1 && near(pres1.perRound[0].weight, 2))

const pres14 = spnProfile({ cipher: 'present', mode: MODE.DIFFERENTIAL, rounds: 14, onLog: () => {} })
const p14 = pres14.perRound[13]
/* 文献（Wang 2008）：14 轮最优差分特征 2^-62。束搜索给 2^-68 —— 差 6 bit 属正常，
   关键是"同一量级、同一量纲"，不能出现 2^-175 那种明显没搜到的情况。 */
check('PRESENT 14 轮：权重落在 [62, 80]（文献最优 2^-62）',
  p14.weight >= 62 && p14.weight <= 80, p14.weight.toFixed(2))
check('PRESENT 14 轮活跃盒 ≥ 定理下界 28（任意 5 轮 ≥10 盒 ⇒ 14 轮 ≥28）',
  p14.cumActive >= 28, String(p14.cumActive))

/* ================================================================ 5. 真实加密抽样 */

section('【5】真实加密抽样：实测命中必须落在理论 ±3√λ 内')

for (const [cipher, r] of [['aes', 1], ['present', 1], ['present', 2]]) {
  const prof = spnProfile({ cipher, mode: MODE.DIFFERENTIAL, rounds: r, onLog: () => {} })
  const rep = empiricalHitRate(prof.best, { samples: 200000, onProgress: () => {} })
  check(`${cipher} ${r} 轮：理论 2^-${prof.best.weight.toFixed(1)}，实测 ${rep.hits}/${rep.samples}（期望 ${rep.lambda.toFixed(1)}）`,
    rep.ok && rep.level === 'good',
    `${rep.level} ${rep.verdict || rep.reason}`)
}

/* ================================================================ 6. 模板与分流 */

section('【6】模板与引擎分流')

for (const id of ['aes', 'present']) {
  const g = TEMPLATES[id].build()
  const errs = g.validate().filter((i) => i.level === 'error')
  check(`${id} 模板无致命校验错误`, errs.length === 0, JSON.stringify(errs))
  check(`${id} 模板带 engine 标记，graphEngine 返回专用引擎`,
    g.meta.engine === id && graphEngine(g) === id, graphEngine(g))
  check(`${id} 在 USER_TEMPLATE_IDS 里（界面上选得到）`, USER_TEMPLATE_IDS.includes(id))
  check(`${id} 专用引擎的分组长度与轮数`,
    SPN_CIPHERS[id].blockBits === g.meta.blockSize && SPN_CIPHERS[id].rounds === g.meta.rounds)
}
check('类 AES 教学模板仍走通用图引擎（不被误认成完整 AES）',
  graphEngine(TEMPLATES.aes_like.build()) === 'graph')
check('空白画布走通用图引擎', graphEngine(TEMPLATES.blank.build()) === 'graph')

/* 用户手填起点必须生效（AES 的 16 个单元由四字向量铺开） */
const initCells = [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
const withInit = spnProfile({
  cipher: 'aes', mode: MODE.DIFFERENTIAL, rounds: 2, initCells, onLog: () => {},
})
check('显式起点：只用给定的那一个起点（不再遍历默认集合）',
  JSON.stringify(withInit.best.inputState) === JSON.stringify(initCells),
  JSON.stringify(withInit.best.inputState))

/* ================================================================ 汇总 */

console.log(`\n${'─'.repeat(60)}`)
if (failures.length === 0) {
  console.log(`✓ 全部通过：${passed}/${passed} 项`)
} else {
  console.log(`✗ ${failures.length} 项失败（通过 ${passed}）`)
  for (const f of failures) console.log(`  · ${f}`)
  process.exit(1)
}
