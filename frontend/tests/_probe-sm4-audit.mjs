// 探针：把前端引擎 SM4 各轮的输出**完整**打出来（权重 / 活跃 S 盒 / Δin / Δout），
// 供「真 SM4 加密」独立复核使用。只读，不改任何状态。
// 跑法：NODE_PATH=<托管 workspace> node tests/_probe-sm4-audit.mjs
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
import { MODE, feistelCharacteristicSearch } from '../src/core/analysis.js'
import { SBoxLibrary } from '../src/core/sboxlib.js'
new SBoxLibrary()

const DEF = {
  mode: MODE.DIFFERENTIAL,
  searchDepth: 'beam',
  beamWidth: 8,
  maxCandidates: 24,
  timeBudgetMs: 120000,
  sboxRef: 'sm4',
}
const hex = (v) => '0x' + (v >>> 0).toString(16).padStart(8, '0')
const ROUNDS = process.argv[2] ? process.argv[2].split(',').map(Number) : [1, 2, 3, 4, 5, 6, 7, 8, 16]

console.log('rounds  weight   active  Δin                                  Δout')
for (const rounds of ROUNDS) {
  const t = Date.now()
  const c = feistelCharacteristicSearch({ ...DEF, rounds })[0]
  if (!c) { console.log(`${rounds}  (无结果)`); continue }
  const din = (c.inputState || []).map(hex).join(',')
  const dout = (c.outputState || []).map(hex).join(',')
  console.log(
    `${String(rounds).padStart(2)}      ${c.weight.toFixed(2).padStart(8)}  ${String(c.activeSboxes).padStart(3)}    ` +
    `(${din})   (${dout})   [${Date.now() - t}ms]`
  )
}
