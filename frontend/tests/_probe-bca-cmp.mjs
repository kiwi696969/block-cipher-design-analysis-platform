// 探针：取前端引擎（扩起点后）1~8 轮权重，用于与后端 BCA 精确下界对照表。
// 只读，不改任何状态。跑法见 AGENTS.md §7（NODE_PATH 指托管 workspace）。
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
import { MODE, feistelCharacteristicSearch } from '../src/core/analysis.js'
import { SBoxLibrary } from '../src/core/sboxlib.js'
new SBoxLibrary()

const DEF = {
  mode: MODE.DIFFERENTIAL,
  searchDepth: 'beam',
  beamWidth: 8,
  maxCandidates: 24,
  timeBudgetMs: 60000,
  sboxRef: 'sm4',
}
const hex = (v) => '0x' + (v >>> 0).toString(16).padStart(8, '0')
for (const rounds of [1, 2, 3, 4, 5, 6, 8]) {
  const c = feistelCharacteristicSearch({ ...DEF, rounds })[0]
  console.log(
    `${String(rounds).padStart(2)} 轮  w=${c.weight.toFixed(2).padStart(7)}  活跃=${String(c.activeSboxes).padStart(3)}` +
    `  Δin=(${(c.inputState || []).map(hex).join(', ')})  Δout=(${(c.outputState || []).map(hex).join(', ')})`
  )
}
