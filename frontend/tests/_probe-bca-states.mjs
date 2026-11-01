/**
 * 临时探针：后端路径明细里的 `state` 到底能不能直接喂给 empiricalHitRate？
 *
 * §4.37 记过 `bca/util/path.py` 打印的状态字是**反序**的（人工核对要用反转读回）。
 * 如果页面拿它去抽样，位序错一位就会得出「命中 0 次」的假结论 ——
 * 那比不给数字更糟。这里用真实 SM4 加密试出正确读法。
 */
import fs from 'node:fs'

import { parsePathDetail, pickPath } from '../src/core/bca-solve.js'
import { empiricalHitRate } from '../src/core/empirical.js'
import { sm4Encrypt, sm4KeySchedule } from '../src/core/sm4ref.js'

const resp = JSON.parse(fs.readFileSync('C:/Users/huawei/AppData/Local/Temp/cj.txt', 'utf8'))
const ROUND = 4
const W = 6
const det = pickPath(resp.paths, ROUND, W)
if (!det) throw new Error('没找到 R4-P6 的路径明细')

const rev32 = (v) => {
  let x = v >>> 0
  let r = 0
  for (let i = 0; i < 32; i++) { r = ((r << 1) | (x & 1)) >>> 0; x >>>= 1 }
  return r >>> 0
}

const inWords = det.rounds[0].state
const outWords = det.finalState
console.log('输入 state =', inWords.map((v) => '0x' + v.toString(16)))
console.log('末  state =', outWords.map((v) => '0x' + v.toString(16)))

const variants = {
  '原样': { dIn: inWords, dOut: outWords },
  '原样+字序反转': { dIn: [...inWords].reverse(), dOut: [...outWords].reverse() },
  '位反32': { dIn: inWords.map(rev32), dOut: outWords.map(rev32) },
  '位反32+字序反转': { dIn: inWords.map(rev32).reverse(), dOut: outWords.map(rev32).reverse() },
}

for (const [name, v] of Object.entries(variants)) {
  if (!v.dIn || v.dIn.length !== 4) { console.log(name, '→ 字数不对'); continue }
  const rep = empiricalHitRate(
    { rounds: ROUND, weight: W, startRound: 1, inputState: v.dIn, outputState: v.dOut },
    { samples: 40000, minSamples: 40000, maxBits: 30, seed: 1 },
  )
  console.log(name.padEnd(16), '→ 命中', rep.hits, '/', rep.samples,
    '实测', (rep.measured * 100).toFixed(3) + '%', '期望', (rep.expected * 100).toFixed(3) + '%')
}

/* 参考：直接用引擎/已知正确读法算一遍（拿 BCA 5 轮路径做对照不在此文件内） */
unusedRef()
function unusedRef() { return [sm4Encrypt, sm4KeySchedule] }
