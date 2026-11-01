/**
 * 内置 S 盒种子数据一致性测试。
 *
 * 为什么需要它：
 * 同一个「内置 S 盒」在两处各有一份数据 ——
 *   ① 前端 frontend/src/core/sbox.js 的 BUILTIN_SBOXES（计算层用它）
 *   ② 服务端 analysis/migrations/0002_seed_builtin_sboxes.py（库里的初始数据）
 * 两边一旦不同步，最典型的症状是"页面上看到的 S 盒和库里的不是同一条"，
 * 而且因为 DDT/LAT 都是前端现算的，数值看起来还挺"正常"，极难排查。
 *
 * 所以这里做两件事：
 *   · 交叉比对两处的表数据（逐字节）
 *   · 把数据代进计算层，验证算出来的密码学指标是权威值
 *     （SM4/AES：差分均匀度 4、非线性度 112；PRESENT：4 / 4）
 *
 *   node tests/verify-seed.mjs
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { SBox, BUILTIN_SBOXES } from '../src/core/sbox.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const MIGRATION = join(ROOT, 'analysis', 'migrations', '0002_seed_builtin_sboxes.py')

let pass = 0
const fails = []

function check(name, ok, got = '') {
  if (ok) { pass++; return }
  fails.push(`${name}${got !== '' ? ` —— 实得: ${got}` : ''}`)
}

const py = readFileSync(MIGRATION, 'utf8')

/* ================================================================ 1. 迁移文件本身 */

console.log('\n【1】迁移文件结构')

check('依赖 0001_initial', py.includes("('analysis', '0001_initial')"), '')
check('用 RunPython 且写了反向迁移（可回滚）',
  /RunPython\(\s*seed\s*,\s*unseed\s*\)/.test(py), '')
check('反向迁移只删内置项，不动用户自建的',
  /is_builtin=True\)\.delete\(\)/.test(py), '')
check('种入是幂等的（update_or_create，重复执行不产生重复行）',
  py.includes('update_or_create'), '')

/* ================================================================ 2. 解析出种子表 */

const ENTRY = new RegExp(
  "\\{\\s*'name':\\s*'([^']+)',\\s*"
  + "'size':\\s*(\\d+),\\s*"
  + "'table_hex':\\s*\\(([\\s\\S]*?)\\),\\s*"
  + "'note':\\s*'([^']*)',\\s*"
  + "'is_builtin':\\s*(True|False),\\s*\\}",
  'g',
)

const seeded = [...py.matchAll(ENTRY)].map((m) => ({
  name: m[1],
  bits: Number(m[2]),
  hex: [...m[3].matchAll(/'([0-9a-f]+)'/g)].map((h) => h[1]).join(''),
  note: m[4],
  builtin: m[5] === 'True',
}))

console.log('【2】种子表与前端内置表交叉比对')

check('解析出 3 条种子记录', seeded.length === 3, String(seeded.length))
check('全部标为 is_builtin=True', seeded.every((s) => s.builtin), '')

// 前端 key ↔ 库里名称的对应关系（这份映射也要一起维护）
const PAIRS = [
  ['sm4', 'SM4 S-Box'],
  ['aes', 'AES S-Box'],
  ['present', 'PRESENT S-Box'],
]

for (const [key, name] of PAIRS) {
  const js = BUILTIN_SBOXES[key]
  const row = seeded.find((s) => s.name === name)

  check(`[${key}] 前端内置表里存在`, !!js)
  check(`[${key}] 迁移里种了「${name}」`, !!row)
  if (!js || !row) continue

  const jsHex = js.table.map((v) => v.toString(16).padStart(2, '0')).join('')
  check(`[${key}] 位宽一致（${js.size} bit）`, row.bits === js.size, `${row.bits} vs ${js.size}`)
  check(`[${key}] 表数据逐字节一致（${jsHex.length} 个 hex 字符）`,
    row.hex === jsHex, `库里 ${row.hex.length} 字符，前端 ${jsHex.length} 字符`)

  // 顺带确认它确实是个置换（种错一个字节最容易在这露馅）
  const vals = row.hex.match(/.{2}/g).map((h) => parseInt(h, 16))
  check(`[${key}] 取值恰好覆盖 0…${(1 << row.bits) - 1} 且不重复`,
    JSON.stringify([...vals].sort((a, b) => a - b))
      === JSON.stringify([...Array(1 << row.bits).keys()]),
    `len=${vals.length}`)
}

/* ================================================================ 3. 指标锚点 */

console.log('【3】用种下的数据算指标，对齐权威值')

// 值来自 SKILL 文档与公开文献，是最硬的"数据没抄错"证据
const ANCHORS = [
  ['sm4', 'SM4 S-Box', 4, 112],
  ['aes', 'AES S-Box', 4, 112],
  ['present', 'PRESENT S-Box', 4, 4],
]

for (const [key, name, wantDU, wantNL] of ANCHORS) {
  const row = seeded.find((s) => s.name === name)
  const js = BUILTIN_SBOXES[key]
  if (!row || !js) continue

  // 用迁移里的 hex 造 SBox —— 检验的是**库里那份数据**，不是前端的
  const vals = row.hex.match(/.{2}/g).map((h) => parseInt(h, 16))
  const sb = new SBox(vals, row.bits, row.bits, name)

  check(`[${key}] 差分均匀度 = ${wantDU}`, sb.differentialUniformity().value === wantDU,
    String(sb.differentialUniformity().value))
  check(`[${key}] 非线性度 = ${wantNL}`, sb.nonlinearity() === wantNL, String(sb.nonlinearity()))
}

/* ================================================================ 结果 */

console.log('\n' + '─'.repeat(60))
if (fails.length) {
  console.log(`✗ ${fails.length} 项失败 / 共 ${pass + fails.length} 项`)
  for (const f of fails) console.log('   ✗ ' + f)
  process.exitCode = 1
} else {
  console.log(`✓ 全部通过：${pass}/${pass} 项`)
}
