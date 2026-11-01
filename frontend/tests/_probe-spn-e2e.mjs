/* 端到端探针：模板 → 引擎分流 → 真实加密抽样 */
import { SBoxLibrary } from '../src/core/sboxlib.js';
import { TEMPLATES } from '../src/core/graph.js';
import { spnProfile } from '../src/core/spnprofile.js';
import { MODE } from '../src/core/analysis.js';
import { empiricalHitRate } from '../src/core/empirical.js';
import { selfCheck, SPN_CIPHERS } from '../src/core/spnref.js';

const lib = new SBoxLibrary();
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ok  ${name}`); } else { fail++; console.log(`  !!  ${name} ${detail}`); }
};

console.log('== 模板与引擎标记 ==');
for (const id of ['aes', 'present']) {
  const g = TEMPLATES[id].build();
  const issues = g.validate();
  const errs = issues.filter((i) => i.level === 'error');
  check(`${id} 模板校验无致命错误`, errs.length === 0, JSON.stringify(errs));
  check(`${id} meta.engine = ${id}`, g.meta.engine === id);
  check(`${id} 分组长度`, g.meta.blockSize === (id === 'aes' ? 128 : 64));
  check(`${id} 轮数`, g.meta.rounds === (id === 'aes' ? 10 : 31));
  console.log(`     节点 ${g.nodes.length} / 边 ${g.edges.length} / 变量 ${g.variables.length}`);
}

console.log('\n== 掩码对偶 ==');
for (const id of ['aes', 'present']) {
  const r = selfCheck(id, { trials: 64 });
  check(r.detail, r.ok);
}

console.log('\n== 引擎逐轮（差分）==');
const a = spnProfile({ cipher: 'aes', mode: MODE.DIFFERENTIAL, rounds: 10, onLog: () => {} });
const aesBoxes = a.perRound.map((p) => p.activeCells);
check('AES 逐轮盒数：R1=1、R2=4、R3 起全活跃（≥15/16）',
  aesBoxes[0] === 1 && aesBoxes[1] === 4 && aesBoxes.slice(2).every((v) => v >= 15),
  aesBoxes.join('/'));
check('AES R1 = 6.00（单盒最大概率 2^-6）', Math.abs(a.perRound[0].weight - 6) < 1e-9);
check('AES R2 = 30.00', Math.abs(a.perRound[1].weight - 30) < 1e-9, a.perRound[1].weight.toFixed(2));
check('AES 10 轮权重单调递增', a.perRound.every((p, i) => i === 0 || p.weight >= a.perRound[i - 1].weight));

const p = spnProfile({ cipher: 'present', mode: MODE.DIFFERENTIAL, rounds: 14, beamWidth: 256, startVariants: 15, branchLimit: 6, onLog: () => {} });
console.log(`      PRESENT 14 轮：活跃 ${p.perRound[13].cumActive} 盒，权重 ${p.perRound[13].weight.toFixed(2)}`);
check('PRESENT R1 = 2.00（半字节盒最大概率 2^-2）', Math.abs(p.perRound[0].weight - 2) < 1e-9);
check('PRESENT 14 轮权重 ≤ 110（文献最优 2^-62，束搜索应接近而非离谱）', p.perRound[13].weight <= 110, p.perRound[13].weight.toFixed(2));

console.log('\n== 真实加密抽样（判据：实测命中落在 ±3√λ）==');
for (const [cipher, r] of [['aes', 1], ['present', 1], ['present', 2], ['present', 3]]) {
  const prof = spnProfile({ cipher, mode: MODE.DIFFERENTIAL, rounds: r, onLog: () => {} });
  const rep = empiricalHitRate(prof.best, { samples: 300000, onProgress: () => {} });
  const tag = `${cipher} ${r} 轮：理论 2^-${prof.best.weight.toFixed(1)}｜${rep.samples} 组｜命中 ${rep.hits}｜期望 ${rep.lambda?.toFixed?.(1) ?? '—'}`;
  check(tag, rep.ok && rep.level === 'good' || rep.level === 'weak',
    `${rep.level} / ${rep.verdict || rep.reason}`);
}

console.log(`\n通过 ${pass}，失败 ${fail}`);
if (fail) process.exit(1);
