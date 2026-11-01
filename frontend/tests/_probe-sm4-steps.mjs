// 探针：导出 SM4 各轮特征的**逐轮步骤**为 JSON，供独立（Python）验证器复核。
// 只读，不改任何状态。
// 跑法：NODE_PATH=<托管 workspace> node tests/_probe-sm4-steps.mjs [roundsCsv] > out.json
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
import { MODE, feistelCharacteristicSearch } from '../src/core/analysis.js'
import { SBoxLibrary } from '../src/core/sboxlib.js'
new SBoxLibrary()

const DEF = {
  mode: MODE.DIFFERENTIAL, searchDepth: 'beam', beamWidth: 8,
  maxCandidates: 24, timeBudgetMs: 180000, sboxRef: 'sm4',
}
const ROUNDS = process.argv[2] ? process.argv[2].split(',').map(Number) : [1, 2, 3, 4, 5, 6, 7, 8]

const out = []
for (const rounds of ROUNDS) {
  const c = feistelCharacteristicSearch({ ...DEF, rounds })[0]
  if (!c) { out.push({ rounds, error: 'no result' }); continue }
  out.push({
    rounds,
    weight: c.weight,
    activeSboxes: c.activeSboxes,
    inputState: c.inputState,
    outputState: c.outputState,
    steps: (c.feistelSteps || []).map((s) => ({
      round: s.round,
      fIn: s.fIn,
      tauIn: s.tauIn,
      tauOut: s.tauOut,
      Lout: s.Lout,
      activeSboxes: s.activeSboxes,
      roundWeight: s.roundWeight,
      prob: s.prob,
      diffBefore: s.diffBefore,
      diffAfter: s.diffAfter,
      sboxIn: s.sboxIn,
      sboxOut: s.sboxOut,
    })),
  })
}
process.stdout.write(JSON.stringify(out, null, 1))
