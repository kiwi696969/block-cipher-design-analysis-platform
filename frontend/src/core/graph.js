/* ============================================================
 * 算法图模型：节点类型 / 连接 / 变量 / 序列化
 * 用户拖拽构建的轮函数结构即数据源
 * ============================================================ */

import { SBox } from './sbox.js';

/** 节点类型定义（决定端口、属性面板与语义） */
export const NODE_TYPES = {
  INPUT: {
    label: '输入明文', icon: '▶', category: 'io', color: '#0ea5e9',
    inputs: [], outputs: [{ id: 'out', label: 'out' }],
    props: [
      { key: 'bits', label: '位宽', type: 'number', default: 64, min: 4, max: 32, hint: '每字位宽（受 JS 32 位限制）；多字状态下请开启下方「多字端口」' },
      { key: 'blocks', label: '分块数', type: 'number', default: 2, min: 1, max: 8 },
      { key: 'multiword', label: '多字端口', type: 'boolean', default: false,
        hint: '开启后本节点输出 W0…W(n-1) 共 n 个独立端口（每字 bits 位），'
          + '支撑 ARX 这类「128bit = 4×32bit 字」的状态 —— 关闭时仍按单字处理（原有结构不受影响）' },
    ],
    desc: '算法入口，注入明文/初始状态。开启「多字端口」后可一次提供多个状态字',
  },
  SBOX: {
    label: 'S 盒替换', icon: '≡', category: 'nonlinear', color: '#f97316',
    inputs: [{ id: 'in', label: 'in' }], outputs: [{ id: 'out', label: 'out' }],
    props: [
      { key: 'sboxId', label: 'S 盒', type: 'sbox', default: 'present' },
      { key: 'mode', label: '应用方式', type: 'select', default: 'parallel', options: [
        { v: 'parallel', t: '并行整字（4bit 宽适用）' },
        { v: 'nibble', t: '逐 4bit 半字节' },
        { v: 'byte', t: '逐 8bit 字节' },
      ]},
      { key: 'repeat', label: '重复层数', type: 'number', default: 1, min: 1, max: 4 },
    ],
    desc: '非线性层：唯一引入差分/线性不确定性的来源',
  },
  LINEAR: {
    label: '线性层', icon: '⋈', category: 'linear', color: '#8b5cf6',
    inputs: [{ id: 'in', label: 'in' }], outputs: [{ id: 'out', label: 'out' }],
    props: [
      { key: 'op', label: '运算', type: 'select', default: 'rotl', options: [
        { v: 'rotl', t: '循环左移 ROTL' },
        { v: 'rotr', t: '循环右移 ROTR' },
        { v: 'xorShift', t: '异或移位 (x ^ (x<<k))' },
        { v: 'bitPerm', t: '比特置换 P' },
        { v: 'mixColumns', t: '类 MixColumns 扩散' },
      ]},
      { key: 'amount', label: '移位量', type: 'number', default: 0, min: 0, max: 32 },
      { key: 'mask', label: 'P 置换掩码(hex)', type: 'text', default: '0' },
    ],
    desc: '可逆线性扩散层，差分/线性掩码按位精确传播',
  },
  XORKEY: {
    label: '异或轮密钥', icon: '⊕', category: 'linear', color: '#8b5cf6',
    inputs: [{ id: 'in', label: 'in' }], outputs: [{ id: 'out', label: 'out' }],
    props: [
      { key: 'keyVar', label: '密钥变量名', type: 'text', default: 'k0' },
      { key: 'independent', label: '独立轮密钥', type: 'select', default: 'yes', options: [
        { v: 'yes', t: '是（每轮由变量名+轮次派生）' },
        { v: 'no', t: '否（各轮复用同一把）' },
      ], hint: '影响"真实加密/雪崩测试"的轮密钥派生；差分/线性域里密钥加本就无贡献'
        + '（线性运算，不改变差分）—— 两条路径的口径都写在这里，别当成哑开关' },
    ],
    desc: '密钥加。差分/线性传播：无贡献（独立轮密钥假设）。真实加密：按轮次派生伪随机轮密钥，'
      + '选「否」则各轮复用同一把（= 与固定常量异或，即 AES 加常量层的语义）',
  },
  PERM: {
    label: '比特/字节置换', icon: '⇄', category: 'linear', color: '#8b5cf6',
    inputs: [{ id: 'in', label: 'in' }], outputs: [{ id: 'out', label: 'out' }],
    props: [
      { key: 'shift', label: '字节循环移位', type: 'number', default: 0, min: 0, max: 16 },
      { key: 'reverse', label: '整体比特反转', type: 'boolean', default: false },
    ],
    desc: '位置重排线性层，常用于 SPN 扩散',
  },
  SPLIT: {
    label: '分支/分块', icon: '⑂', category: 'structure', color: '#10b981',
    inputs: [{ id: 'in', label: 'in' }], outputs: [
      { id: 'a', label: 'A' }, { id: 'b', label: 'B' },
    ],
    props: [
      { key: 'splitBits', label: 'A 部分位宽', type: 'number', default: 32, min: 1, max: 32 },
    ],
    desc: 'Feistel / 广义 Feistel 的分支结构',
  },
  MERGE: {
    label: '合并 (XOR)', icon: '⑃', category: 'structure', color: '#10b981',
    inputs: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], outputs: [{ id: 'out', label: 'out' }],
    props: [
      { key: 'op', label: '合并运算', type: 'select', default: 'xor', options: [
        { v: 'xor', t: '异或 XOR' }, { v: 'add', t: '模加 ADD' }, { v: 'and', t: '与 AND' },
      ], hint: 'XOR 与 ADD 都有**精确规则**：XOR 一进一出；ADD 走进位链模型'
        + '（一进多出，给出真实的 −log₂p 与候选分支数）。AND 仍是保守并集且概率恒 1。' },
    ],
    desc: '两路合并。差分/线性传播按此处声明的运算合并：XOR 精确、ADD 精确（进位链）、'
      + 'AND 保守估算（会出警告）',
  },
  TTRANS: {
    label: 'SM4 T 变换', icon: 'Ⓣ', category: 'nonlinear', color: '#f97316',
    inputs: [{ id: 'in', label: 'in' }], outputs: [{ id: 'out', label: 'out' }],
    props: [
      { key: 'tauOnly', label: '仅 τ (不加 L)', type: 'boolean', default: false },
      { key: 'linearS', label: '线性化 S 盒', type: 'boolean', default: false },
    ],
    desc: 'SM4 专有：τ(4 个 SM4 S 盒并行) 后接 L 线性变换 B⊕(B<<<2)⊕(B<<<10)⊕(B<<<18)⊕(B<<<24)',
  },
  QUARTER_ROUND: {
    label: 'ARX 四分之一轮', icon: '⟐', category: 'nonlinear', color: '#f97316',
    inputs: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }, { id: 'd', label: 'D' }],
    outputs: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }, { id: 'd', label: 'D' }],
    props: [
      { key: 'r1', label: '移位 1（D）', type: 'number', default: 16, min: 1, max: 31 },
      { key: 'r2', label: '移位 2（B）', type: 'number', default: 12, min: 1, max: 31 },
      { key: 'r3', label: '移位 3（D）', type: 'number', default: 8, min: 1, max: 31 },
      { key: 'r4', label: '移位 4（B）', type: 'number', default: 7, min: 1, max: 31 },
    ],
    desc: '★ 复合函数（一次定义、图上单节点表达）：A+=B; D=ROTL(D⊕A,r1); C+=D; B=ROTL(B⊕C,r2); '
      + 'A+=B; D=ROTL(D⊕A,r3); C+=D; B=ROTL(B⊕C,r4)。四入四出，四个字原地更新。'
      + '差分/线性传播里两次 ADD 走精确进位链模型（core/addmodel.js），ROTL/⊕ 精确。',
  },
  ROUND: {
    label: '轮函数容器', icon: '⟳', category: 'structure', color: '#eab308',
    inputs: [{ id: 'in', label: 'in' }], outputs: [{ id: 'out', label: 'out' }],
    props: [
      { key: 'rounds', label: '迭代轮数', type: 'number', default: 16, min: 1, max: 64 },
    ],
    desc: '标记块：声明这个轮函数迭代多少轮。引擎按 `迭代轮数` 自动重复整张图'
      + '（差分/线性域里是「每轮把上一轮输出重新注入输入端」）。'
      + '⚠️ 从前这里还有一个「展开为独立轮」勾选框，但引擎本来就只有「按轮数迭代」一种语义，'
      + '勾与不勾完全一样 —— 已删除（不留「改了不影响计算」的开关）。',
  },
  OUTPUT: {
    label: '输出密文', icon: '■', category: 'io', color: '#0ea5e9',
    inputs: [{ id: 'in', label: 'in' }], outputs: [],
    props: [
      { key: 'rounds', label: '统计截止轮', type: 'number', default: 16, min: 1, max: 64 },
      { key: 'multiword', label: '多字端口', type: 'boolean', default: false,
        hint: '与「输入明文」的多字端口配套：开启后本节点有 W0…W(n-1) 共 n 个输入端口，'
          + '逐字接收最终状态（校验时会检查与输入侧是否一致）' },
      { key: 'blocks', label: '字数', type: 'number', default: 2, min: 1, max: 8 },
    ],
    desc: '算法出口，汇聚最终状态。多字端口开启时逐字接收',
  },
};

export const CATEGORY_LABELS = {
  io: '输入 / 输出',
  nonlinear: '非线性层',
  linear: '线性层',
  structure: '结构 / 控制',
};

/** 图节点 */
let _uid = 1;
export function newId(prefix = 'n') {
  return `${prefix}_${(_uid++).toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

export class Node {
  constructor(type, x = 0, y = 0, props = {}) {
    this.id = newId();
    this.type = type;
    this.x = x;
    this.y = y;
    const def = NODE_TYPES[type];
    this.props = {};
    for (const p of def.props) this.props[p.key] = p.default;
    Object.assign(this.props, props);
    // 运行期字段
    this.result = null;   // 差分/线性传播结果
  }

  get def() { return NODE_TYPES[this.type]; }

  /**
   * 多字端口数：仅 INPUT / OUTPUT 且显式开启 `multiword` 时生效（默认关闭 ⇒ 现有图零影响）。
   * 开启后端口名统一为 w0…w(n-1)，值存放在 `state[`${id}|${port}`]` 侧信道里
   * —— 复用引擎已有的「端口取值」机制（`outMaskAt`），不新增值模型。
   */
  multiWordCount() {
    if (!this.props.multiword) return 1;
    const n = Math.round(Number(this.props.blocks));
    return Number.isFinite(n) && n > 1 ? Math.min(8, n) : 1;
  }

  get inputs() {
    if (this.type === 'OUTPUT') {
      const n = this.multiWordCount();
      if (n > 1) return Array.from({ length: n }, (_, i) => ({ id: `w${i}`, label: `W${i}` }));
    }
    return this.def.inputs;
  }

  get outputs() {
    if (this.type === 'INPUT') {
      const n = this.multiWordCount();
      if (n > 1) return Array.from({ length: n }, (_, i) => ({ id: `w${i}`, label: `W${i}` }));
    }
    return this.def.outputs;
  }

  /** 获取某端口在画布上的坐标 */
  portPos(portId, isInput = false) {
    const list = isInput ? this.inputs : this.outputs;
    const idx = list.findIndex(p => p.id === portId);
    const n = Math.max(list.length, 1);
    const x = this.x + (isInput ? 0 : NODE_W);
    const y = this.y + HEADER_H + ((idx + 0.5) * (BODY_H / n));
    return { x, y };
  }
}

/** 连接（边） */
export class Edge {
  constructor(from, fromPort, to, toPort) {
    this.id = newId('e');
    this.from = from;
    this.fromPort = fromPort;
    this.to = to;
    this.toPort = toPort;
    this.bitWidth = 32;
    this.active = false; // 是否在差分/线性特征路径上活跃
    this.weight = 0;
  }
}

/** 画布几何常量 */
export const NODE_W = 148;
export const HEADER_H = 30;
export const BODY_H = 46;
export const NODE_H = HEADER_H + BODY_H;

/** 算法图 */
export class CipherGraph {
  constructor() {
    this.nodes = [];
    this.edges = [];
    this.meta = {
      name: '未命名算法',
      blockSize: 64,
      keySize: 80,
      rounds: 16,
      structure: 'spn', // spn | feistel | gfn
    };
    this.variables = [
      { name: 'k0', role: 'key', desc: '主密钥变量' },
    ];
    this.sboxes = {}; // 局部 S 盒定义
  }

  addNode(type, x, y, props) {
    const n = new Node(type, x, y, props);
    this.nodes.push(n);
    return n;
  }

  removeNode(id) {
    this.nodes = this.nodes.filter(n => n.id !== id);
    this.edges = this.edges.filter(e => e.from !== id && e.to !== id);
  }

  getNode(id) { return this.nodes.find(n => n.id === id); }

  addEdge(from, fromPort, to, toPort, opts = {}) {
    if (from === to) return null;
    // 容器标记边（虚线，仅表示"迭代主体"语义）不占用数据输入端口
    if (!opts.marker) {
      // 一个数据输入端口只接受一条数据边（覆盖旧的），但保留标记边
      this.edges = this.edges.filter(e => !(e.to === to && e.toPort === toPort && !e.marker));
    }
    const e = new Edge(from, fromPort, to, toPort);
    if (opts.marker) e.marker = true;
    this.edges.push(e);
    return e;
  }

  removeEdge(id) { this.edges = this.edges.filter(e => e.id !== id); }

  outEdges(id) { return this.edges.filter(e => e.from === id && !e.marker); }
  inEdges(id) { return this.edges.filter(e => e.to === id && !e.marker); }
  /** 数据流边（排除容器标记边） */
  dataEdges() { return this.edges.filter(e => !e.marker); }

  /** 拓扑排序，返回执行顺序（容器标记边不参与数据流） */
  topoOrder() {
    const indeg = {};
    const adj = {};
    for (const n of this.nodes) { indeg[n.id] = 0; adj[n.id] = []; }
    for (const e of this.dataEdges()) {
      if (e.from === e.to) continue;
      adj[e.from].push(e.to);
      indeg[e.to] = (indeg[e.to] || 0) + 1;
    }
    const q = this.nodes.filter(n => indeg[n.id] === 0).map(n => n.id);
    const order = [];
    while (q.length) {
      const id = q.shift();
      order.push(this.getNode(id));
      for (const nxt of adj[id]) {
        if (--indeg[nxt] === 0) q.push(nxt);
      }
    }
    return order;
  }

  /** 校验图结构的合法性，返回问题列表 */
  validate() {
    const issues = [];
    const inputs = this.nodes.filter(n => n.type === 'INPUT');
    const outputs = this.nodes.filter(n => n.type === 'OUTPUT');
    if (inputs.length === 0) issues.push({ level: 'error', msg: '缺少「输入明文」节点，算法无入口' });
    if (outputs.length === 0) issues.push({ level: 'error', msg: '缺少「输出密文」节点，无法确定输出状态' });
    if (inputs.length > 1) issues.push({ level: 'warn', msg: `存在 ${inputs.length} 个输入节点，仅第一个参与分析` });
    for (const n of this.nodes) {
      const inE = this.inEdges(n.id).length;
      const outE = this.outEdges(n.id).length;
      if (n.type === 'ROUND') continue; // 容器节点不承载数据流
      if (n.inputs.length > 0 && inE === 0) issues.push({ level: 'warn', msg: `节点「${n.def.label}」(${n.id}) 无数据输入连接` });
      if (n.outputs.length > 0 && outE === 0 && n.type !== 'OUTPUT') issues.push({ level: 'warn', msg: `节点「${n.def.label}」(${n.id}) 无输出连接` });
    }
    // 环检测
    if (this.topoOrder().length < this.nodes.length) {
      issues.push({ level: 'error', msg: '图中存在环路，请使用「轮函数容器」表达迭代结构' });
    }
    // S 盒合法性 / 查找表语义
    const vBits = graphBlockBits(this);
    for (const n of this.nodes) {
      if (n.type !== 'SBOX') {
        continue;
      }
      const sb = this.getSBox(n.props.sboxId);
      if (!sb) { issues.push({ level: 'error', msg: `S 盒节点 ${n.id} 引用了未定义的 S 盒「${n.props.sboxId}」` }); continue; }
      if (sb.inBits !== sb.outBits) {
        // ★ 非等宽 = 查找表（如 16→32 扩展表）。陷阱：按输入位宽平铺会让输出块**重叠 OR**
        //    （「拼图」样例暴露的真缺陷），所以引擎改成「整字一次查表」——
        //    这里把语义与限制一并说清，不静默。
        issues.push({
          level: 'warn',
          msg: `S 盒「${sb.name}」是**非等宽查找表**（${sb.inBits}→${sb.outBits}）：按「整字一次查表」`
            + `应用（索引取字的低 ${sb.inBits} 位，不再按输入位宽平铺）。`
            + (sb.outBits > vBits ? `⚠️ 输出 ${sb.outBits}bit 超过词宽 ${vBits}bit，高位会被截断。` : '')
            + (sb.outBits >= 31 ? '⚠️ 宽输出：线性（Matsui）分析不支持，只有差分侧可精确计算。' : ''),
        });
      } else {
        if (n.props.mode === 'parallel' && sb.inBits !== 4 && sb.inBits !== (this.meta.blockSize % 32 || 32)) {
          issues.push({ level: 'warn', msg: `S 盒「${sb.name}」为 ${sb.inBits}bit，并行整字模式下将按 ${sb.inBits}bit 切块应用` });
        }
        if (!sb.isValidPermutation() && n.props.mode === 'parallel') {
          issues.push({ level: 'warn', msg: `S 盒「${sb.name}」不是 bit 数相同的置换` });
        }
      }
      if (!sb.fullTableFeasible()) {
        issues.push({
          level: 'warn',
          msg: `S 盒「${sb.name}」(${sb.inBits}→${sb.outBits}) 的 DDT/LAT 全表超出内存上限，不再建表；`
            + '差分侧改按需单行（仍精确），S 盒库页的四项指标会显示为「不可用」。',
        });
      }
    }
    // ★ 模加（ADD）**已支持**：`core/addmodel.js` 给出精确的进位链模型
    //   （差分 DDT / 线性 LAT，逐位 DP，已用 3/4/5 位全穷举对拍）。
    //   从前它和 AND 一起被当作「保守并集 + 概率恒 1」——那是 ARX 拿到假结论的根源。
    //   现在只剩 AND 仍是保守估算，继续显式警告（不静默给错值）。
    for (const n of this.nodes) {
      if (n.type !== 'MERGE') continue;
      const op = n.props.op || 'xor';
      if (op === 'and') {
        issues.push({
          level: 'warn',
          msg: `节点「合并」(${n.id}) 的运算为「与 AND」：差分/线性传播里 XOR（精确）与`
            + ' ADD（精确，进位链模型）都有真规则，AND 仍按「保守并集」估算且**概率恒为 1**'
            + '—— 这个 −log₂p 不是真值，请改用 XOR 或 ADD。',
        });
      }
    }
    // ★ 多字端口：输入/输出两侧必须配套，否则字对不上会**静默丢字**
    const mwIn = !!inputs[0] && inputs[0].multiWordCount() > 1;
    const mwOut = !!outputs[0] && outputs[0].multiWordCount() > 1;
    if (mwIn !== mwOut) {
      issues.push({
        level: 'warn',
        msg: '「输入明文」与「输出密文」的「多字端口」设置不一致'
          + `（输入 ${mwIn ? '已开启' : '未开启'} / 输出 ${mwOut ? '已开启' : '未开启'}）`
          + '—— 多字结构应当两侧同时开启，否则会丢字。',
      });
    } else if (mwIn && inputs[0].multiWordCount() !== outputs[0].multiWordCount()) {
      issues.push({
        level: 'warn',
        msg: `输入侧 ${inputs[0].multiWordCount()} 个字、输出侧 ${outputs[0].multiWordCount()} 个字，数量不一致。`,
      });
    }

    return issues;
  }

  /** 解析 S 盒（优先局部定义，其次全局库） */
  getSBox(id) {
    if (this.sboxes[id]) {
      const d = this.sboxes[id];
      return new SBox(d.table.slice(), d.size, d.outputSize ?? d.size, d.name);
    }
    // 通过全局 S 盒库解析（内置 + 用户导入）
    const lib = globalThis.__SBOX_LIB__;
    if (lib && typeof lib.getSBoxByRef === 'function') {
      const sb = lib.getSBoxByRef(id);
      if (sb) return sb;
    }
    return null;
  }

  /** 序列化 */
  toJSON() {
    return {
      version: 2,
      meta: this.meta,
      variables: this.variables,
      sboxes: this.sboxes,
      nodes: this.nodes.map(n => ({ id: n.id, type: n.type, x: n.x, y: n.y, props: n.props })),
      edges: this.edges.map(e => ({ id: e.id, from: e.from, fromPort: e.fromPort, to: e.to, toPort: e.toPort })),
    };
  }

  static fromJSON(data) {
    const g = new CipherGraph();
    g.meta = { ...g.meta, ...(data.meta || {}) };
    g.variables = data.variables || g.variables;
    g.sboxes = data.sboxes || {};
    for (const n of data.nodes || []) {
      const node = new Node(n.type, n.x, n.y, n.props);
      node.id = n.id;
      g.nodes.push(node);
    }
    g.edges = (data.edges || []).map(e => {
      const ed = new Edge(e.from, e.fromPort, e.to, e.toPort);
      ed.id = e.id;
      return ed;
    });
    return g;
  }
}

/* ---------- 图派生量：词宽 / 分组长度 / 引擎 ---------- */

/**
 * 从图上派生「参与运算的词宽」（≤32，受 JS 位运算限制）。
 *
 * ⚠️ 修复的缺陷：这个量从前在 `platform.js` 里写死为 `32`，
 * 而 `meta.blockSize` 又能被随手改成 64 —— 于是会出现
 * 「图上写着 64bit 分组、引擎按 32bit 算」这种自相矛盾。
 * 现在统一从 INPUT 节点派生，图上怎么设就怎么算。
 */
export function graphBlockBits(graph) {
  const inp = graph?.nodes?.find?.((n) => n.type === 'INPUT');
  const bits = Math.round(Number(inp?.props?.bits));
  if (!Number.isFinite(bits) || bits < 1) return 32;
  return Math.max(1, Math.min(32, bits));
}

/**
 * 从图上派生「分组长度」= INPUT 位宽 × 分块数。
 * 64bit 非平衡 Feistel = `bits: 32, blocks: 2`（每半 32bit）。
 */
export function graphBlockSize(graph) {
  const inp = graph?.nodes?.find?.((n) => n.type === 'INPUT');
  const bits = graphBlockBits(graph);
  const blocks = Math.round(Number(inp?.props?.blocks));
  const n = Number.isFinite(blocks) && blocks >= 1 ? Math.min(8, blocks) : 1;
  return bits * n;
}

/**
 * 这张图该用哪个引擎：
 *   'sm4'     → SM4 专用迭代引擎（内置 SM4 模板标记，保证权威基准值）
 *   'aes'     → AES-128 专用 SPN 引擎（16 个 8bit 单元，见 spnprofile.js）
 *   'present' → PRESENT-64 专用 SPN 引擎（16 个 4bit 单元）
 *   'graph'   → 通用图引擎（SPN 单趟传播 / Feistel 分支迭代）
 *
 * ⚠️ 专用引擎的三个标记都只由**内置模板**写入；用户手搭的图没有这些标记，
 *    一律走通用图引擎「图怎么画就怎么算」。别把这里当成自动识别算法的地方。
 */
export function graphEngine(graph) {
  const e = graph?.meta?.engine
  if (e === 'sm4' || e === 'aes' || e === 'present') return e
  return 'graph'
}

/* ---------- 预置模板：让用户开箱即得经典结构 ---------- */

/**
 * ★ 面向用户的模板清单 —— 算法选择页与结构编辑器的「恢复模板」共用这一份。
 *
 * 界面提供五个起点：
 *   **SM4 / AES-128 / PRESENT-64**（三个标准算法，各有专用引擎，数值可对权威文献）
 *   **类 AES（教学模型） / 空白画布**（走通用图引擎）
 * `present_like`、`feistel_like`、`arx_swirl` 仍留在 `TEMPLATES` 里供测试与内部使用，
 * 但**不作为选项出现在界面上**。
 *
 * 想增删选项，只改这一处；两个界面都从它取，不会各说各话。
 * （`verify-pages.mjs` 第 6 节会盯着它和两个界面是否一致。）
 */
export const USER_TEMPLATE_IDS = ['sm4', 'aes', 'present', 'aes_like', 'blank']

export const TEMPLATES = {
  sm4: {
    name: '国密 SM4 (GB/T 32907)',
    build() {
      const g = new CipherGraph();
      g.meta = {
        name: '国密 SM4',
        blockSize: 128, keySize: 128, rounds: 32,
        structure: 'feistel', wordBits: 32,
        // ★ engine='sm4' 表示「这张图就是标准 SM4」→ 走 SM4 专用迭代引擎
        //   （sm4RoundProfile），以保证 6/92/274/647.00 这组基准（R1~R3 为 0）。
        //   用户手搭的图没有这个标记 → 走真正遍历图的通用引擎。
        engine: 'sm4',
        standard: 'GB/T 32907-2016',
        note: '32 轮非平衡 Feistel (广义 Feistel)，轮函数 F(X)=X⊕T(X⊕rk)',
      };
      g.variables = [
        { name: 'MK', role: 'key', desc: '128bit 主密钥 MK=(MK0,MK1,MK2,MK3)，每字 32bit' },
        { name: 'rk', role: 'roundkey', desc: '32 个 32bit 轮密钥，由密钥扩展 T′ 生成' },
        { name: 'X0..X3', role: 'plaintext', desc: '4 个 32bit 状态字 (X0,X1,X2,X3)' },
        { name: 'τ', role: 'const', desc: '4 个 SM4 S 盒并行替换' },
        { name: 'L', role: 'const', desc: 'L(B)=B⊕(B<<<2)⊕(B<<<10)⊕(B<<<18)⊕(B<<<24)' },
        { name: 'FK', role: 'const', desc: '系统参数 FK=(a3b1bac6,56aa3350,677d9197,b27022dc)' },
        { name: 'CK', role: 'const', desc: '固定参数 CK，32 个 32bit 常量' },
      ];

      const inp = g.addNode('INPUT', 40, 250, { bits: 32, blocks: 4 });
      const rk  = g.addNode('ROUND', 250, 70, { rounds: 32 });
      const xor1 = g.addNode('XORKEY', 250, 250, { keyVar: 'rk', independent: 'yes' });
      const tt  = g.addNode('TTRANS', 440, 250, { tauOnly: false, linearS: false });
      const add  = g.addNode('MERGE', 630, 250, { op: 'xor' });
      const out = g.addNode('OUTPUT', 830, 250, { rounds: 32 });

      // SM4 轮函数：X_{i+4} = X_i ⊕ T(X_{i+1}⊕X_{i+2}⊕X_{i+3}⊕rk_i)
      g.addEdge(inp.id, 'out', xor1.id, 'in');
      g.addEdge(xor1.id, 'out', tt.id, 'in');
      g.addEdge(tt.id, 'out', add.id, 'a');
      g.addEdge(inp.id, 'out', add.id, 'b');   // X_i 支路
      g.addEdge(add.id, 'out', out.id, 'in');
      g.addEdge(rk.id, 'out', tt.id, 'in', { marker: true });
      g.meta._roundContainer = rk.id;
      // 反馈标记：第 i 轮的输出作为第 i+1 轮输入（迭代特征用）
      g.meta._feistelFeedback = { xor: add.id, tapNode: inp.id, roundNode: rk.id };
      return g;
    },
  },
  /* ★ 完整 AES-128：状态是 16 个字节单元，走 spnprofile.js 的专用引擎。
   *   画布按「层」示意（S 盒 → 行移位 → 列混淆 → 轮密钥加），与 SM4 模板同一手法：
   *   engine 标记决定算法语义，画布不承担位宽 —— 通用图引擎的状态是单个 32bit 字，
   *   撑不起 128bit 状态，硬塞进去只会算出错的数。 */
  aes: {
    name: 'AES-128 (FIPS-197)',
    build() {
      const g = new CipherGraph();
      g.meta = {
        name: 'AES-128',
        blockSize: 128, keySize: 128, rounds: 10,
        structure: 'spn', wordBits: 8,
        // ★ engine='aes' ⇒ 专用 SPN 引擎（16 个 8bit 单元 + 真 GF(2⁸) 列混淆）
        engine: 'aes',
        cells: 16, cellBits: 8,
        standard: 'FIPS-197',
        note: '10 轮 SPN：SubBytes → ShiftRows → MixColumns → AddRoundKey（末轮无列混淆）。'
          + '分析按 16 个字节单元逐个传播，S 盒 / DDT / LAT 取自平台 S 盒库。',
      };
      g.variables = [
        { name: 'k0', role: 'key', desc: '128bit 主密钥（10 轮密钥扩展，Rcon 常量）' },
        { name: 'rk', role: 'roundkey', desc: '11 个 128bit 轮密钥（K0..K10）' },
        { name: 'state', role: 'plaintext', desc: '16 字节状态矩阵（列优先，s[r+4c]）' },
        { name: 'S', role: 'const', desc: 'AES S 盒（8bit，差分均匀度 4，最大 |LAT| 32）' },
        { name: 'SR', role: 'const', desc: 'ShiftRows：第 r 行左移 r 个字节' },
        { name: 'MC', role: 'const', desc: 'MixColumns：GF(2⁸) 上 MDS 矩阵 [02 03 01 01]' },
      ];

      const inp = g.addNode('INPUT', 40, 250, { bits: 32, blocks: 4 });
      const rk = g.addNode('ROUND', 250, 70, { rounds: 10 });
      const s = g.addNode('SBOX', 250, 250, { sboxId: 'aes', mode: 'byte' });
      const sh = g.addNode('PERM', 450, 250, { shift: 0, reverse: false });
      const mc = g.addNode('LINEAR', 640, 250, { op: 'mixColumns', amount: 0 });
      const k = g.addNode('XORKEY', 830, 250, { keyVar: 'rk', independent: 'yes' });
      const out = g.addNode('OUTPUT', 1000, 250, { rounds: 10 });

      g.addEdge(inp.id, 'out', s.id, 'in');
      g.addEdge(s.id, 'out', sh.id, 'in');
      g.addEdge(sh.id, 'out', mc.id, 'in');
      g.addEdge(mc.id, 'out', k.id, 'in');
      g.addEdge(k.id, 'out', out.id, 'in');
      g.addEdge(rk.id, 'out', s.id, 'in', { marker: true });
      g.meta._roundContainer = rk.id;
      return g;
    },
  },
  /* ★ 完整 PRESENT-64：16 个半字节单元，线性层是位级 P 置换（无 MixColumns）。 */
  present: {
    name: 'PRESENT-64 (ISO/IEC 29192-2)',
    build() {
      const g = new CipherGraph();
      g.meta = {
        name: 'PRESENT-64',
        blockSize: 64, keySize: 80, rounds: 31,
        structure: 'spn', wordBits: 4,
        engine: 'present',
        cells: 16, cellBits: 4,
        standard: 'ISO/IEC 29192-2',
        note: '31 轮轻量级 SPN：addRoundKey → sBoxLayer（16 个 4bit 盒）→ pLayer（位置换）。'
          + '每轮都做 P 置换，末轮之后再加一次密钥（共 32 个轮密钥，80bit 密钥扩展）。',
      };
      g.variables = [
        { name: 'k0', role: 'key', desc: '80bit 主密钥（旋转 61 位 + S 盒 + 轮计数 k19..k15）' },
        { name: 'rk', role: 'roundkey', desc: '32 个 64bit 轮密钥（K1..K32）' },
        { name: 'state', role: 'plaintext', desc: '16 个半字节状态（nibble 0 为最高位）' },
        { name: 'S', role: 'const', desc: 'PRESENT S 盒（4bit，差分均匀度 4）' },
        { name: 'P', role: 'const', desc: '位置换 P(i)=16i mod 63（i≤62），P(63)=63' },
      ];

      const inp = g.addNode('INPUT', 40, 250, { bits: 32, blocks: 2 });
      const rk = g.addNode('ROUND', 250, 70, { rounds: 31 });
      const k0 = g.addNode('XORKEY', 250, 250, { keyVar: 'rk', independent: 'yes' });
      const s = g.addNode('SBOX', 450, 250, { sboxId: 'present', mode: 'nibble' });
      const p = g.addNode('PERM', 640, 250, { shift: 0, reverse: false });
      const out = g.addNode('OUTPUT', 830, 250, { rounds: 31 });

      g.addEdge(inp.id, 'out', k0.id, 'in');
      g.addEdge(k0.id, 'out', s.id, 'in');
      g.addEdge(s.id, 'out', p.id, 'in');
      g.addEdge(p.id, 'out', out.id, 'in');
      g.addEdge(rk.id, 'out', s.id, 'in', { marker: true });
      g.meta._roundContainer = rk.id;
      return g;
    },
  },
  /* ★ ARX「旋涡」：不加进 USER_TEMPLATE_IDS（界面上暂不作为起点选项），
   *   作为**回归夹具与复现入口**存在 —— 它把「ADD 精确模型 + 复合函数节点 +
   *   多字端口」三件事串成一条可验证的链路（见 tests/verify-core.mjs 第 16 节）。 */
  arx_swirl: {
    name: 'ARX 旋涡（加-旋转-异或，128bit / 12 轮）',
    build() {
      const g = new CipherGraph();
      g.meta = {
        name: 'ARX 旋涡',
        blockSize: 128, keySize: 0, rounds: 12, structure: 'spn', wordBits: 32,
        note: '128bit = 4×32bit 字；每轮 1 个四分之一轮（ChaCha 风格）；'
          + '无 S 盒，唯一非线性源是 32bit 模加（差分/线性走精确进位链模型）',
      };
      const inp = g.addNode('INPUT', 40, 250, { bits: 32, blocks: 4, multiword: true });
      const qr = g.addNode('QUARTER_ROUND', 260, 250, { r1: 16, r2: 12, r3: 8, r4: 7 });
      const rk = g.addNode('ROUND', 460, 80, { rounds: 12 });
      const out = g.addNode('OUTPUT', 520, 250, { rounds: 12, multiword: true, blocks: 4 });
      const op = ['w0', 'w1', 'w2', 'w3'], ip = ['a', 'b', 'c', 'd'];
      op.forEach((p, i) => g.addEdge(inp.id, p, qr.id, ip[i]));
      ip.forEach((p, i) => g.addEdge(qr.id, p, out.id, op[i]));
      g.addEdge(rk.id, 'out', qr.id, 'a', { marker: true });
      g.meta._roundContainer = rk.id;
      return g;
    },
  },
  /*
   * 以下三个**不在界面上作为选项出现**（不在 USER_TEMPLATE_IDS 里）。
   * 定义保留：`present_like` 被三套回归测试用作 SPN + 4bit S 盒路径的夹具；
   * 另两个是早期的教学结构，暂时留着备用，别误以为界面上能看到它们。
   */
  sm4_keyext: {
    name: 'SM4 密钥扩展 T′',
    build() {
      const g = new CipherGraph();
      g.meta = {
        name: 'SM4 密钥扩展',
        blockSize: 128, keySize: 128, rounds: 32,
        structure: 'feistel', wordBits: 32,
        engine: 'sm4',
        standard: 'GB/T 32907-2016',
        note: '密钥扩展：rk_i = K_{i+4} = K_i ⊕ T′(K_{i+1}⊕K_{i+2}⊕K_{i+3}⊕CK_i)，T′ 使用 L′(B)=B⊕(B<<<13)⊕(B<<<23)',
      };
      g.variables = [
        { name: 'MK', role: 'key', desc: '主密钥' },
        { name: 'K', role: 'roundkey', desc: '中间状态 K0..K35' },
        { name: 'CK', role: 'const', desc: '固定参数' },
      ];
      const inp = g.addNode('INPUT', 40, 250, { bits: 32, blocks: 4 });
      const rk = g.addNode('ROUND', 250, 70, { rounds: 32 });
      const xor1 = g.addNode('XORKEY', 250, 250, { keyVar: 'CK', independent: 'yes' });
      const tt = g.addNode('TTRANS', 440, 250, { tauOnly: false, keyExt: true });
      const out = g.addNode('OUTPUT', 640, 250, { rounds: 32 });
      g.addEdge(inp.id, 'out', xor1.id, 'in');
      g.addEdge(xor1.id, 'out', tt.id, 'in');
      g.addEdge(tt.id, 'out', out.id, 'in');
      g.addEdge(rk.id, 'out', tt.id, 'in', { marker: true });
      g.meta._roundContainer = rk.id;
      return g;
    },
  },
  present_like: {
    name: '类 PRESENT (SPN, 4bit S盒)',
    build() {
      const g = new CipherGraph();
      g.meta = { name: '类 PRESENT 结构', blockSize: 32, keySize: 80, rounds: 16, structure: 'spn' };
      g.variables = [
        { name: 'k0', role: 'key', desc: '主密钥' },
        { name: 'rk', role: 'roundkey', desc: '轮密钥' },
        { name: 'p', role: 'plaintext', desc: '明文状态' },
        { name: 'P', role: 'const', desc: '比特置换层' },
      ];
      let x = 40, y = 190;
      const inp = g.addNode('INPUT', x, y);
      inp.props.bits = 32; inp.props.blocks = 1;
      x += 200;
      const rk = g.addNode('ROUND', x, y - 70, { rounds: 16 });
      x += 200;
      const s = g.addNode('SBOX', x, y, { sboxId: 'present', mode: 'nibble', repeat: 1 });
      x += 200;
      const p = g.addNode('PERM', x, y, { shift: 0, reverse: false });
      x += 200;
      const k = g.addNode('XORKEY', x, y, { keyVar: 'k0', independent: 'yes' });
      x += 200;
      const out = g.addNode('OUTPUT', x, y, { rounds: 16 });
      g.addEdge(inp.id, 'out', s.id, 'in');
      g.addEdge(s.id, 'out', p.id, 'in');
      g.addEdge(p.id, 'out', k.id, 'in');
      g.addEdge(k.id, 'out', out.id, 'in');
      // ROUND 容器以虚线关联 S 盒表示迭代主体
      g.addEdge(rk.id, 'out', s.id, 'in', { marker: true });
      g.meta._roundContainer = rk.id;
      return g;
    },
  },
  feistel_like: {
    name: '类 DES (Feistel, 6→4 S盒)',
    build() {
      const g = new CipherGraph();
      g.meta = { name: '类 DES Leicht 结构', blockSize: 32, keySize: 64, rounds: 16, structure: 'feistel' };
      g.variables = [
        { name: 'k0', role: 'key', desc: '主密钥' },
        { name: 'L', role: 'plaintext', desc: '左半状态' },
        { name: 'R', role: 'plaintext', desc: '右半状态' },
        { name: 'F', role: 'const', desc: '轮函数' },
      ];
      const inp = g.addNode('INPUT', 40, 190, { bits: 32, blocks: 2 });
      const sp = g.addNode('SPLIT', 230, 190, { splitBits: 16 });
      const rk = g.addNode('ROUND', 420, 90, { rounds: 16 });
      const s = g.addNode('SBOX', 420, 240, { sboxId: 'des1', mode: 'nibble' });
      const k = g.addNode('XORKEY', 600, 240, { keyVar: 'k0' });
      const mg = g.addNode('MERGE', 780, 218, { op: 'xor' });
      const out = g.addNode('OUTPUT', 950, 240, { rounds: 16 });
      g.addEdge(inp.id, 'out', sp.id, 'in');
      g.addEdge(sp.id, 'b', s.id, 'in');
      g.addEdge(s.id, 'out', k.id, 'in');
      g.addEdge(k.id, 'out', mg.id, 'a');
      g.addEdge(sp.id, 'a', mg.id, 'b');
      g.addEdge(mg.id, 'out', out.id, 'in');
      g.addEdge(rk.id, 'out', s.id, 'in', { marker: true });
      g.meta._roundContainer = rk.id;
      return g;
    },
  },
  aes_like: {
    name: '类 AES (SPN, 8bit S盒)',
    build() {
      const g = new CipherGraph();
      g.meta = {
        name: '类 AES 结构', blockSize: 32, keySize: 128, rounds: 10, structure: 'spn',
        note: '10 轮 SPN：字节代换 → 行移位 → 列混淆 → 轮密钥加。'
          + '结构与 AES 相似（含真实的 AES S 盒），是教学模型，不是 AES 标准本身。',
      };
      g.variables = [
        { name: 'k0', role: 'key', desc: '主密钥' },
        { name: 'state', role: 'plaintext', desc: '状态矩阵' },
      ];
      const inp = g.addNode('INPUT', 40, 190, { bits: 32, blocks: 1 });
      const rk = g.addNode('ROUND', 230, 100, { rounds: 10 });
      const s = g.addNode('SBOX', 230, 250, { sboxId: 'aes', mode: 'byte' });
      const sh = g.addNode('PERM', 420, 250, { shift: 0, reverse: false });
      const mc = g.addNode('LINEAR', 600, 250, { op: 'mixColumns', amount: 0 });
      const k = g.addNode('XORKEY', 780, 250, { keyVar: 'k0' });
      const out = g.addNode('OUTPUT', 950, 250, { rounds: 10 });
      g.addEdge(inp.id, 'out', s.id, 'in');
      g.addEdge(s.id, 'out', sh.id, 'in');
      g.addEdge(sh.id, 'out', mc.id, 'in');
      g.addEdge(mc.id, 'out', k.id, 'in');
      g.addEdge(k.id, 'out', out.id, 'in');
      g.addEdge(rk.id, 'out', s.id, 'in', { marker: true });
      g.meta._roundContainer = rk.id;
      return g;
    },
  },
  blank: {
    name: '空白画布（自定义）',
    build() {
      const g = new CipherGraph();
      // 分组长度跟着画布上的 INPUT 走（32bit × 1 块 = 32bit）。
      // 想搭 64bit 的经典 Feistel：把 INPUT 设成 32bit × 2 块，
      // 加一个「分支/分块」节点并按 32bit 切分即可 —— 左侧拖组件就能搭出来。
      g.meta.blockSize = 32;
      g.meta.note = '只有输入 / 输出两个节点。从左侧把组件拖进画布自己搭轮函数 ——'
        + '想分析真实 AES 那种列混淆写法，就走这条。';
      const inp = g.addNode('INPUT', 80, 200, { bits: 32, blocks: 1 });
      const out = g.addNode('OUTPUT', 620, 200, { rounds: 16 });
      return g;
    },
  },
};
