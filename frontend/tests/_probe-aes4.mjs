/* 探针：AES 4 轮全枚举能压到多少活跃盒（文献 wide-trail 下界 25 盒 = 2^-150） */
import { SBoxLibrary } from '../src/core/sboxlib.js';
import { spnProfile } from '../src/core/spnprofile.js';
import { MODE } from '../src/core/analysis.js';

new SBoxLibrary();

const t = (params, label) => {
  const t0 = performance.now();
  const res = spnProfile({
    cipher: 'aes', mode: MODE.DIFFERENTIAL, rounds: 4, startRound: 1, endRound: 4,
    onLog: () => {}, ...params,
  });
  const ms = performance.now() - t0;
  const r = res.perRound[3];
  console.log(`${label.padEnd(48)} 盒 ${String(r.cumActive).padStart(3)}  权重 ${r.weight.toFixed(2).padStart(7)}  逐轮 ${res.perRound.map((p) => p.activeCells).join('/')}  [${ms.toFixed(0)}ms]`);
  return res;
};

t({ beamWidth: 16 }, 'beam=16 br=4 start=3');
t({ beamWidth: 256, startVariants: 10, branchLimit: 8, perCellBeam: 24 }, 'beam=256 br=8 start=10');
t({ beamWidth: 64, branchLimit: 0, startVariants: 255, perCellBeam: 48 }, 'beam=64 br=ALL start=255（全枚举）');
t({ beamWidth: 16, branchLimit: 0, startVariants: 255, perCellBeam: 96 }, 'beam=16 br=ALL start=255 perCell=96');
