// 实验：把「5 轮权重 12」那条路径的起点直接喂给平台前端引擎，看它能否算出 12。
// 若能 ⇒ 证明引擎算法本身没问题，30.00 纯粹是**默认起点族覆盖不足**（上界）。
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
import { MODE, feistelCharacteristicSearch } from '../src/core/analysis.js'
import { SBoxLibrary } from '../src/core/sboxlib.js'
new SBoxLibrary()

const DEF = {
  mode: MODE.DIFFERENTIAL, searchDepth: 'beam', beamWidth: 8,
  maxCandidates: 24, timeBudgetMs: 60000, sboxRef: 'sm4',
}
const hex = (v) => '0x' + (v >>> 0).toString(16).padStart(8, '0')

// 5 轮最优点：Δin = (L(τout₁), δ, δ, δ)，τout₁ = 0x4c ⇒ L(τout₁) = 0x4d31317c
const INIT_5 = [[0x4d31317c, 1, 1, 1]]

console.log('=== 5 轮：默认起点族 vs 手动指定最优点起点 ===')
for (const [label, init] of [['默认（16 单比特 + 32 免费族）', null], ['手动指定 (0x4d31317c,1,1,1)', INIT_5]]) {
  const c = feistelCharacteristicSearch({ ...DEF, rounds: 5, initDiffs: init })[0]
  console.log(`  ${label}\n    w=${c.weight.toFixed(2)}  活跃=${c.activeSboxes}  ` +
    `Δout=(${(c.outputState || []).map(hex).join(', ')})`)
  const steps = (c.feistelSteps || []).map((s) => `R${s.round}:${s.activeSboxes}`).join(' ')
  console.log(`    逐轮活跃：${steps}`)
}

console.log('\n=== 6 轮：同样对比 ===')
for (const [label, init] of [['默认', null]]) {
  const c = feistelCharacteristicSearch({ ...DEF, rounds: 6, initDiffs: init })[0]
  console.log(`  ${label}\n    w=${c.weight.toFixed(2)}  活跃=${c.activeSboxes}  ` +
    `Δout=(${(c.outputState || []).map(hex).join(', ')})`)
  console.log(`    逐轮活跃：${(c.feistelSteps || []).map((s) => `R${s.round}:${s.activeSboxes}`).join(' ')}`)
}
