/* ============================================================
 * S 盒库管理器：内置 + 服务端镜像 + 用户导入 + localStorage 持久化
 *
 * 三份来源，优先级：内置 > 服务端（Django S 盒库）> 本地导入
 *   - 内置：`sbox.js` 里的 BUILTIN_SBOXES，id 就是 `sm4` / `aes` / `present`…
 *   - 服务端：`/sbox/` 页与 Django 后台写进数据库的，id 前缀 `srv_`，
 *     由 `syncServer()` 整体刷新，**不落 localStorage**（它只是服务端的镜像）
 *   - 本地导入：`/structure/` 里直接粘表数据，id 前缀 `u_`，存 localStorage
 * ============================================================ */

import { SBox, BUILTIN_SBOXES, parseSBoxText } from './sbox.js';

export class SBoxLibrary {
  constructor() {
    this.custom = {};     // id -> {name, desc, size, outputSize, table, source}  本地导入（localStorage）
    this.server = {};     // id -> {…, source:'server', remoteId}  服务端库的只读镜像
    this.load();
    // 供旧接口/外部直接访问内置表
    this.BUILTIN_SBOXES = BUILTIN_SBOXES;
    globalThis.__SBOX_LIB__ = this;
  }

  get allBuiltin() { return BUILTIN_SBOXES; }

  /**
   * 列表项。
   *
   * ⚠️ `size` 在这里是**位宽**（4 / 8）—— `getSBoxByRef()` 要拿它去构造 `SBox`，
   * 不能改语义。但界面想显示的是**项数**（16 / 256），过去直接拿 `size` 当项数，
   * 于是 256 项的 8bit 盒被写成「8 项」。要显示项数请一律用 **`count`**。
   */
  list() {
    const countOf = (b) => (Array.isArray(b.table) ? b.table.length : (1 << b.size));
    const out = [];
    for (const [id, b] of Object.entries(BUILTIN_SBOXES)) {
      out.push({
        id, name: b.name, desc: b.desc, size: b.size, count: countOf(b),
        outputSize: b.outputSize ?? b.size, builtin: true,
      });
    }
    for (const [id, b] of Object.entries(this.server)) {
      out.push({
        id, name: b.name, desc: b.desc, size: b.size, count: countOf(b),
        outputSize: b.outputSize ?? b.size, builtin: false, remote: true,
      });
    }
    for (const [id, b] of Object.entries(this.custom)) {
      out.push({
        id, name: b.name, desc: b.desc || '用户导入', size: b.size, count: countOf(b),
        outputSize: b.outputSize ?? b.size, builtin: false,
      });
    }
    return out;
  }

  /** 按引用 ID 取 SBox 实例（内置 / 服务端镜像 / 本地导入） */
  getSBoxByRef(id) {
    const b = BUILTIN_SBOXES[id] || this.server[id] || this.custom[id];
    if (!b) return null;
    return new SBox(b.table.slice(), b.size, b.outputSize ?? b.size, b.name);
  }

  getDef(id) {
    return BUILTIN_SBOXES[id] || this.server[id] || this.custom[id] || null;
  }

  /**
   * 导入自定义 S 盒
   * @param {string} name
   * @param {number[]} table
   * @param {number} inBits
   * @param {number|null} outBits
   */
  import(name, table, inBits, outBits = null, desc = '') {
    const id = 'u_' + name.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 24) + '_' + Math.random().toString(36).slice(2, 6);
    const ob = outBits ?? inBits;
    const sb = new SBox(table.slice(), inBits, ob, name);
    this.custom[id] = {
      name, desc: desc || `用户导入 · ${inBits}bit`,
      size: inBits, outputSize: ob, table: table.slice(), source: 'user',
    };
    this.save();
    return { id, sbox: sb, stats: this.stats(sb) };
  }

  remove(id) {
    if (!this.custom[id]) return false;
    delete this.custom[id];
    this.save();
    return true;
  }

  /* ------------------------------------------------- 服务端镜像（Django S 盒库） */

  /**
   * 用服务端（`GET /api/sboxes/?full=1`）的 S 盒刷新「远端」集合。
   *
   * 为什么需要：S 盒在系统里有两处存法 —— `/sbox/` 页写的是 Django 数据库，
   * 画布的 S 盒下拉读的却是这里。两套存储过去互不相通，用户导入的 S 盒
   * 在结构编辑器里**根本选不到**。这个方法是那两处的唯一连接点。
   *
   * 三条规则：
   *   1. **整表替换**，不是增量合并 —— 服务端是这份镜像的唯一数据源，
   *      那边删掉的这里就该消失，否则会留下"幽灵 S 盒"。
   *   2. **与内置表内容相同的跳过** —— 内置 S 盒在迁移 0002 里也有一份种子，
   *      不去重的话下拉里会出现两个「SM4」。
   *   3. 服务端内部按表内容去重，重复的只留第一条。
   *
   * @param {Array<{id:number, name:string, bits:number, table:number[], desc?:string, isBuiltin?:boolean}>} entries
   * @returns {{total:number, skipped:number, previous:number}}
   */
  syncServer(entries) {
    const builtinTables = new Set(Object.values(BUILTIN_SBOXES).map((b) => b.table.join(',')));
    const next = {};
    const seen = new Set();
    let skipped = 0;

    for (const e of entries || []) {
      const table = Array.isArray(e?.table) ? e.table : [];
      if (!table.length) { skipped++; continue; }
      const key = table.join(',');
      if (builtinTables.has(key) || seen.has(key)) { skipped++; continue; }
      seen.add(key);
      const bits = e.bits || Math.round(Math.log2(table.length));
      next['srv_' + e.id] = {
        name: e.name,
        desc: e.desc || `S 盒库 #${e.id}`,
        size: bits,
        outputSize: e.outputSize ?? bits,
        table: table.slice(),
        source: 'server',
        remoteId: e.id,
        isBuiltin: !!e.isBuiltin,
      };
    }

    const previous = Object.keys(this.server).length;
    this.server = next;
    return { total: Object.keys(next).length, skipped, previous };
  }

  /** 清空服务端镜像（后端不可用时回到「只有内置 S 盒」） */
  clearServer() {
    this.server = {};
  }

  /** 计算 S 盒密码学指标汇总 */
  stats(sb) {
    if (!sb) return null;
    // ★ 大盒/非等宽：DDT·LAT 全表建不起来（见 sbox.js 的 SBOX_TABLE_CAP），
    //   不能让它把页面带崩 —— 返回「指标不可用」，同时给出仍能算的事实。
    if (!sb.fullTableFeasible()) {
      let fixed = 0;
      for (let x = 0; x < sb.inSize; x++) if (sb.table[x] === x) fixed++;
      return {
        name: sb.name, inBits: sb.inBits, outBits: sb.outBits,
        isPermutation: sb.isValidPermutation(),
        metricsUnavailable: true,
        unavailableReason: `DDT/LAT 全表为 ${sb.inSize}×${sb.outSize}，超出上限；`
          + '差分侧走「按需单行」仍精确，但差分均匀度/线性度/分支数这些**全局**指标无法计算',
        fixedPoints: fixed,
        grade: { level: '-', text: `位宽 ${sb.inBits}→${sb.outBits}，超出可全表分析的范围` },
      };
    }
    const du = sb.differentialUniformity();
    const li = sb.linearity();
    const dbn = sb.diffBranchNumber();
    const isPerm = sb.isValidPermutation();
    // 代数次数近似：通过莫比乌斯变换计算 ANF 次数
    const algDeg = algebraicDegree(sb);
    // 不动点
    let fixed = 0;
    for (let x = 0; x < sb.inSize; x++) if (sb.table[x] === x) fixed++;
    return {
      name: sb.name, inBits: sb.inBits, outBits: sb.outBits,
      isPermutation: isPerm,
      differentialUniformity: du.value,
      duWitness: { a: du.inputDiff, b: du.outputDiff },
      maxDifferentialProb: du.value / sb.inSize,
      linearity: li.value,
      nonlinearity: sb.nonlinearity(),
      maxLinearCorr: li.value / (1 << (sb.inBits - 1)),
      linearWitness: { a: li.inputMask, b: li.outputMask },
      differentialBranchNumber: dbn.value,
      algebraicDegree: algDeg.maxDegree,
      fixedPoints: fixed,
      // 安全评级（4bit/8bit 差异标准）
      grade: gradeSBox(sb.inBits, du.value, sb.nonlinearity()),
    };
  }

  save() {
    try {
      localStorage.setItem('cda_custom_sboxes', JSON.stringify(this.custom));
    } catch (e) { /* localStorage 不可用时静默降级 */ }
  }

  load() {
    try {
      const raw = localStorage.getItem('cda_custom_sboxes');
      if (raw) this.custom = JSON.parse(raw);
    } catch (e) { this.custom = {}; }
  }
}

/** 通过莫比乌斯变换求 S 盒分量的代数次数 */
function algebraicDegree(sb) {
  const n = sb.inBits;
  if (n > 8) return { maxDegree: 'n/a', perComponent: [] };
  const size = 1 << n;
  const perComponent = [];
  let maxDeg = 0;
  for (let bit = 0; bit < sb.outBits; bit++) {
    const f = new Uint8Array(size);
    for (let x = 0; x < size; x++) f[x] = (sb.table[x] >>> bit) & 1;
    // 莫比乌斯变换
    const anf = f.slice();
    for (let i = 0; i < n; i++) {
      for (let x = 0; x < size; x++) {
        if ((x >>> i) & 1) anf[x] ^= anf[x ^ (1 << i)];
      }
    }
    let deg = 0;
    for (let x = 0; x < size; x++) if (anf[x]) deg = Math.max(deg, popcount(x));
    perComponent.push(deg);
    maxDeg = Math.max(maxDeg, deg);
  }
  return { maxDegree: maxDeg, perComponent };
}

function popcount(x) {
  let c = 0;
  while (x) { c += x & 1; x >>= 1; }
  return c;
}

/** S 盒安全评级 */
function gradeSBox(inBits, du, nl) {
  if (inBits === 4) {
    if (du <= 4 && nl >= 4) return { level: 'A', text: '优（达到 4bit 最优：DU≤4, NL≥4）' };
    if (du <= 6 && nl >= 2) return { level: 'B', text: '良（可用于轻量级密码）' };
    return { level: 'C', text: '偏弱（差分/线性指标不足）' };
  }
  if (inBits === 8) {
    if (du <= 4 && nl >= 100) return { level: 'A', text: '优（接近 AES/国密 SM4 水平）' };
    if (du <= 8 && nl >= 90) return { level: 'B', text: '良' };
    if (du <= 16) return { level: 'C', text: '中（存在较高差分概率）' };
    return { level: 'D', text: '弱（差分均匀度过高，易受攻击）' };
  }
  return { level: '-', text: `位宽 ${inBits}，无标准评级` };
}

/** 解析用户粘贴的 S 盒（自动推断位宽） */
export function autoParseSBox(text) {
  const tokens = text.trim().split(/[\s,;\[\]{}()]+/).filter(Boolean);
  const vals = [];
  for (const t of tokens) {
    let v;
    const clean = t.replace(/0[xX]/, '');
    if (/^0[xX]/.test(t)) v = parseInt(clean, 16);
    else if (/^[0-9]+$/.test(t)) v = parseInt(t, 10);
    else if (/^[0-9a-fA-F]{1,2}$/.test(t) && /[a-fA-F]/.test(t)) v = parseInt(t, 16);
    else continue;
    if (!Number.isNaN(v)) vals.push(v);
  }
  if (vals.length === 0) return { ok: false, error: '未能解析出任何数值，请检查格式' };

  const n = vals.length;
  let inBits;
  if (n === 16) inBits = 4;
  else if (n === 256) inBits = 8;
  else if (n === 64) inBits = 6;
  else if (n === 4) inBits = 2;
  else if (n === 1024) inBits = 10;
  else if ((n & (n - 1)) === 0) inBits = Math.log2(n);
  else return { ok: false, error: `元素个数 ${n} 不是 2 的幂，无法确定位宽` };

  const maxV = Math.max(...vals);
  let outBits = inBits;
  while ((1 << outBits) <= maxV) outBits++;

  // 合法性检查
  const warnings = [];
  if (vals.some(v => v < 0)) return { ok: false, error: '存在负值' };
  if (outBits !== inBits) warnings.push(`输入 ${inBits}bit / 输出 ${outBits}bit，非等宽置换（非线性度等指标按最坏情况估计）`);
  if (outBits === inBits) {
    const seen = new Set(vals);
    if (seen.size !== n) warnings.push(`存在重复输出值（${n - seen.size} 个），不是置换，差分均匀度将显著升高`);
  }

  return { ok: true, table: vals, inBits, outBits, warnings, count: n };
}
