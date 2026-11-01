// 实验：给默认起点族补一族「第 1 轮活跃、其后 3 轮免费」的形态，
// 看能否把 5/6/7/8 轮对齐到后端 BCA 的精确下界。
// 新族：Δin = (L(τout), δ, δ, δ)，δ 取单字节差分、τout 取 DDT[δ] 的最优输出。
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
import { MODE, feistelCharacteristicSearch, sm4L } from '../src/core/analysis.js'
import { SBoxLibrary } from '../src/core/sboxlib.js'
const lib = new SBoxLibrary()

const DEF = {
  mode: MODE.DIFFERENTIAL, searchDepth: 'beam', beamWidth: 8,
  maxCandidates: 24, timeBudgetMs: 120000, sboxRef: 'sm4',
}
const hex = (v) => '0x' + (v >>> 0).toString(16).padStart(8, '0')

// —— 复刻默认族（与 analysis.js 一致）——
const defaults = []
for (let w = 0; w < 4; w++) for (let b = 0; b < 4; b++) { const v = [0, 0, 0, 0]; v[w] = 1 << b; defaults.push(v) }
for (let b = 0; b < 32; b++) { const a = 1 << b; defaults.push([a, a, a, 0]) }

// —— 新族：Δin = (L(τout), δ, δ, δ) ——
const sb = lib.getSBoxByRef('sm4')
const ddt = sb.getDDT()
const extra = []
for (let b = 0; b < 32; b++) {
  const delta = (1 << b) >>> 0
  // δ 是 32 位单比特；取它所在的字节 + 字节内位
  const byteIdx = Math.floor(b / 8), bitInByte = b % 8
  const byteVal = 1 << bitInByte
  const row = ddt[byteVal]
  let best = -1, bestCnt = 0
  for (let o = 1; o < 256; o++) if (row[o] > bestCnt) { bestCnt = row[o]; best = o }
  if (best < 0) continue
  const lout = sm4L((best & 0xFF) << (byteIdx * 8))
  extra.push([lout >>> 0, delta, delta, delta])
}
console.log(`默认起点 ${defaults.length} 个 + 新族 ${extra.length} 个 = ${defaults.length + extra.length} 个`)

for (const rounds of [4, 5, 6, 7, 8]) {
  const a = feistelCharacteristicSearch({ ...DEF, rounds })[0]
  const b = feistelCharacteristicSearch({ ...DEF, rounds, initDiffs: [...defaults, ...extra] })[0]
  console.log(`${String(rounds).padStart(2)} 轮  默认 ${a.weight.toFixed(2).padStart(7)}/${String(a.activeSboxes).padStart(2)}` +
    `   +新族 ${b.weight.toFixed(2).padStart(7)}/${String(b.activeSboxes).padStart(2)}` +
    `   新族起点 Δout=(${(b.outputState || []).map(hex).join(',')})`)
}
