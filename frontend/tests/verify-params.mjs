/**
 * 参数层回归测试。
 *
 * 这一套为什么不放在 verify-core.mjs 里：core/params.js 被抽出来的**唯一原因**
 * 就是它需要能被 Node 直接测。store（stores/platform.js）用了 `@/` 别名，
 * Node 解析不了，于是参数装配这块最容易出错的逻辑以前完全没有测试覆盖 ——
 * 结果就是 `initDiffs` 填了内容必崩（字符串透传给期望数组的引擎）。
 *
 * 所以：这里凡是断言，都对应一个真实发生过的故障或必须守住的不变量。
 *
 *   node tests/verify-params.mjs
 */
import { PARAM_DEFAULTS, buildSearchOptions, parseInitDiffs, describeInitDiffs, roundRangeIssueOf, effectiveRangeOf, teachingFlagsOf } from '../src/core/params.js'
import { MODE, SEARCH_MODEL } from '../src/core/analysis.js'
import { TEMPLATES } from '../src/core/graph.js'

let pass = 0
const fails = []

function check(name, ok, got = '') {
  if (ok) { pass++; return }
  fails.push(`${name}${got !== '' ? ` —— 实得: ${got}` : ''}`)
}

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

/* ================================================================ 1. 起始差分解析 */

console.log('\n【1】起始差分解析（parseInitDiffs）')

check('空字符串 → null（交回引擎自动遍历）', parseInitDiffs('') === null)
check('纯空格 → null', parseInitDiffs('   ') === null)
check('null → null', parseInitDiffs(null) === null)
check('undefined → null', parseInitDiffs(undefined) === null)

// 这是当初崩溃的根因：字符串被原样透传，引擎按字符遍历
const r1 = parseInitDiffs('0x2,0,0,0')
check('0x 前缀按十六进制解析', eq(r1, [[2, 0, 0, 0]]), JSON.stringify(r1))
check('解析结果必须是「数组的数组」而非字符串', Array.isArray(r1) && Array.isArray(r1[0]),
  `typeof=${typeof r1} / 元素=${typeof r1?.[0]}`)

// 8 位十六进制字：必须按十六进制，不能按十进制
const r2 = parseInitDiffs('00000002')
check('8 位十六进制字 00000002 → 0x2（不是十进制 2 的误读，也不是 0）',
  eq(r2, [[2, 0, 0, 0]]), JSON.stringify(r2))
const r2b = parseInitDiffs('00000010')
check('00000010 → 16（十六进制）而非 10（十进制）',
  eq(r2b, [[16, 0, 0, 0]]), JSON.stringify(r2b))

// 裸数字按十进制（与参考实现一致）
const r3 = parseInitDiffs('10')
check('裸数字 10 → 10（十进制），与 00000010 区分', eq(r3, [[10, 0, 0, 0]]), JSON.stringify(r3))

const r4 = parseInitDiffs('0,0,0,1')
check('0,0,0,1 → 第四个字为 1', eq(r4, [[0, 0, 0, 1]]), JSON.stringify(r4))

const r5 = parseInitDiffs('2 0 0 1')
check('空格分隔也认', eq(r5, [[2, 0, 0, 1]]), JSON.stringify(r5))

const r6 = parseInitDiffs('1,2,3')
check('不足 4 个字右侧补 0', eq(r6, [[1, 2, 3, 0]]), JSON.stringify(r6))

const r7 = parseInitDiffs('1,2,3,4,5,6')
check('超过 4 个字截断为 4 个', eq(r7, [[1, 2, 3, 4]]), JSON.stringify(r7))

const r8 = parseInitDiffs('0x2,0,0,0; 0,0,0,1')
check('分号分隔多个起点 → 2 个', Array.isArray(r8) && r8.length === 2, JSON.stringify(r8))
check('多起点的第二个是 0,0,0,1', eq(r8?.[1], [0, 0, 0, 1]), JSON.stringify(r8?.[1]))

const r9 = parseInitDiffs('0xFFFFFFFF,0,0,0')
check('大值被规范成无符号 32 位', eq(r9, [[0xffffffff, 0, 0, 0]]), JSON.stringify(r9))

const r10 = parseInitDiffs('abc,0,0,0')
check('非法字（既非 8 位 hex 也非十进制）→ 0，不抛异常', eq(r10, [[0, 0, 0, 0]]), JSON.stringify(r10))

/* ================================================================ 2. 解析回执 */

console.log('【2】解析回执（describeInitDiffs）')
const d1 = describeInitDiffs('')
check('留空 → ok 且提示"自动"', d1.ok && d1.count === 0, JSON.stringify(d1))
const d2 = describeInitDiffs('0,0,0,1')
check('合法输入 → ok 且 count=1', d2.ok && d2.count === 1, JSON.stringify(d2))
check('回执文本里含规范化后的十六进制', /00000001/.test(d2.text), d2.text)
const d3 = describeInitDiffs('0x2,0,0,0; 0,0,0,1')
check('两个起点 → count=2', d3.ok && d3.count === 2, JSON.stringify(d3))

/* ================================================================ 3. 参数装配 */

console.log('【3】参数装配（buildSearchOptions）')

const base = buildSearchOptions({ params: PARAM_DEFAULTS, mode: MODE.DIFFERENTIAL, graph: null })
check('startRound/endRound 透传', base.startRound === 1 && base.endRound === 32,
  `${base.startRound}~${base.endRound}`)
check('默认模型是概率权重模型', base.model === SEARCH_MODEL.WEIGHT, base.model)
check('默认束宽 8（全站统一值）', base.beamWidth === 8, String(base.beamWidth))
check('branchLimit=0 时不带该字段（= 引擎自动）', !('branchLimit' in base), JSON.stringify(base.branchLimit))
check('留空初始差分时不带 initDiffs 字段', !('initDiffs' in base), JSON.stringify(base.initDiffs))
check('无图时不带 tauOnly/linearS 字段', !('tauOnly' in base) && !('linearS' in base))

// ⚠️ 核心回归点：填了起始差分，交出去的必须是数组
const withInit = buildSearchOptions({
  params: { ...PARAM_DEFAULTS, initDiffs: '0,0,0,1' },
  mode: MODE.DIFFERENTIAL, graph: null,
})
check('★ 填了起始差分后 initDiffs 必须是数组（否则引擎崩）',
  Array.isArray(withInit.initDiffs) && Array.isArray(withInit.initDiffs[0]),
  `typeof=${typeof withInit.initDiffs} 值=${JSON.stringify(withInit.initDiffs)}`)
check('★ initDiffs 内容正确 = [[0,0,0,1]]', eq(withInit.initDiffs, [[0, 0, 0, 1]]),
  JSON.stringify(withInit.initDiffs))
check('★ initDiffs 不得是字符串（回归：曾经透传字符串导致 TypeError）',
  typeof withInit.initDiffs !== 'string', typeof withInit.initDiffs)

// 区间倒挂：对齐但不回写
const inverted = buildSearchOptions({
  params: { ...PARAM_DEFAULTS, startRound: 10, endRound: 4 }, graph: null,
})
check('起始轮 > 结束轮时 endRound 对齐到 startRound',
  inverted.startRound === 10 && inverted.endRound === 10,
  `${inverted.startRound}~${inverted.endRound}`)

// 越界夹紧
const clamped = buildSearchOptions({
  params: { ...PARAM_DEFAULTS, beamWidth: 999, maxCandidates: -5, timeBudgetMs: 1 },
  graph: null,
})
check('beamWidth 夹到 64 上限', clamped.beamWidth === 64, String(clamped.beamWidth))
check('maxCandidates 夹到 1 下限', clamped.maxCandidates === 1, String(clamped.maxCandidates))
check('timeBudgetMs 夹到 200 下限', clamped.timeBudgetMs === 200, String(clamped.timeBudgetMs))

// 非法枚举值要回退，不能把垃圾传给引擎
const badEnum = buildSearchOptions({
  params: { ...PARAM_DEFAULTS, model: 'nope', searchDepth: 'nope' },
  graph: null,
})
check('非法 model 回退到 weight', badEnum.model === SEARCH_MODEL.WEIGHT, badEnum.model)
check('非法 searchDepth 回退到 beam', badEnum.searchDepth === 'beam', badEnum.searchDepth)

// branchLimit > 0 才带
const withBl = buildSearchOptions({ params: { ...PARAM_DEFAULTS, branchLimit: 8 }, graph: null })
check('branchLimit=8 时带该字段', withBl.branchLimit === 8, String(withBl.branchLimit))

// overrides 优先级
const ov = buildSearchOptions({
  params: PARAM_DEFAULTS, graph: null, overrides: { startRound: 5, rounds: 4 },
})
check('overrides 覆盖生效', ov.startRound === 5 && ov.rounds === 4, JSON.stringify(ov))

/* ================================================================ 4. 教学开关接线 */

console.log('【4】教学对照开关接线（曾经是"哑开关"）')

const g0 = TEMPLATES.sm4.build()
const o0 = buildSearchOptions({ params: PARAM_DEFAULTS, graph: g0 })
check('默认（未勾选）→ tauOnly/linearS 均为 false', o0.tauOnly === false && o0.linearS === false,
  `tauOnly=${o0.tauOnly} linearS=${o0.linearS}`)
check('默认下 teachingFlagsOf 返回 null（界面不显示警告）', teachingFlagsOf(g0) === null)

const g1 = TEMPLATES.sm4.build()
g1.nodes.find((n) => n.type === 'TTRANS').props.tauOnly = true
const o1 = buildSearchOptions({ params: PARAM_DEFAULTS, graph: g1 })
check('★ 勾上「仅 τ」后必须传进引擎（否则是哑开关）', o1.tauOnly === true, String(o1.tauOnly))
check('★ 同时 linearS 保持 false（不得互相串扰）', o1.linearS === false, String(o1.linearS))
const tf1 = teachingFlagsOf(g1)
check('★ teachingFlagsOf 正确报出 tauOnly', tf1?.tauOnly === true && tf1?.linearS === false,
  JSON.stringify(tf1))

const g2 = TEMPLATES.sm4.build()
g2.nodes.find((n) => n.type === 'TTRANS').props.linearS = true
const o2 = buildSearchOptions({ params: PARAM_DEFAULTS, graph: g2 })
check('★ 勾上「线性化 S 盒」后必须传进引擎', o2.linearS === true, String(o2.linearS))
check('★ 勾线性化时 tauOnly 保持 false', o2.tauOnly === false, String(o2.tauOnly))

// SPN 模板没有 TTRANS 节点 → 不带这两个字段，也不该报错
const g3 = TEMPLATES.present_like.build()
const o3 = buildSearchOptions({ params: PARAM_DEFAULTS, graph: g3 })
check('SPN 模板无 TTRANS → 不带教学开关字段', !('tauOnly' in o3) && !('linearS' in o3))
check('SPN 模板 teachingFlagsOf → null', teachingFlagsOf(g3) === null)

// 缺 nodes 的畸形图不能抛
check('graph=null 不抛异常', buildSearchOptions({ params: PARAM_DEFAULTS, graph: null }) !== null)
check('graph={} 不抛异常', buildSearchOptions({ params: PARAM_DEFAULTS, graph: {} }) !== null)
check('graph.nodes 非数组不抛异常',
  buildSearchOptions({ params: PARAM_DEFAULTS, graph: { nodes: 'nope' } }) !== null)

/* ================================================================ 5. 区间工具 */

console.log('【5】区间工具')
check('倒挂时给出告警文案', typeof roundRangeIssueOf({ startRound: 10, endRound: 4 }) === 'string',
  String(roundRangeIssueOf({ startRound: 10, endRound: 4 })))
check('正常区间无告警', roundRangeIssueOf({ startRound: 1, endRound: 32 }) === null)
check('startRound < 1 给出告警', roundRangeIssueOf({ startRound: 0, endRound: 32 }) === '起始轮不能小于 1',
  String(roundRangeIssueOf({ startRound: 0, endRound: 32 })))
check('非数字输入不抛异常', roundRangeIssueOf({ startRound: 'x', endRound: 'y' }) === null)
const er = effectiveRangeOf({ startRound: 5, endRound: 8 })
check('effectiveRange 计算轮数正确（5~8 = 4 轮）', er.start === 5 && er.end === 8 && er.rounds === 4,
  JSON.stringify(er))
check('空参数用默认值', effectiveRangeOf({}).rounds === 32, JSON.stringify(effectiveRangeOf({})))

/* ================================================================ 汇总 */

console.log('\n' + '─'.repeat(58))
if (fails.length) {
  console.log(`✗ ${fails.length} 项失败 / 共 ${pass + fails.length} 项\n`)
  for (const f of fails) console.log('   ✗ ' + f)
  process.exitCode = 1
} else {
  console.log(`✓ 全部通过：${pass}/${pass} 项`)
}
