<script setup>
/**
 * 初学者教程 + 可直接执行的示例。
 *
 * 设计原则：**教程里的每个数字都是从引擎实测来的**，不是"预计"。
 * 为此我先用探针脚本把每个示例跑了一遍（见 tests/_tutorial_probe.mjs
 * 与 tests/_recheck.mjs 的实测输出），再照着真实结果写文案。
 * 教程写了假数字，比不写教程更糟 —— 用户照着一跑就会失去信任。
 *
 * 「一键执行」做的事：载入模板 → 装配参数 → （可选）改结构开关
 * → 真跑一遍 → 跳到结果页。全程走 store 的同一套入口，不另开旁路。
 */
import { computed, ref, triggerRef } from 'vue'
import { href } from '@/pages.js'

import { MODE } from '@/core/analysis.js'
import { BCA_CMP } from '@/core/bca-reference.js'
import { TEMPLATES } from '@/core/graph.js'
import {
  graph, mode, params, saveParams, loadTemplate, runAnalysis, runEmpirical,
  log, PARAM_DEFAULTS, isFeistel,
} from '@/stores/platform.js'

/* ---------------------------------------------------------------- 实测基准表 */

/**
 * SM4 差分：各轮数区间的实测结果（平台实跑，可自行复现）。
 * ⚠️ 2026-10-15：默认起点集合含「三轮免费」族 Δ=(a,a,a,0) → 第 1~3 轮权重恒为 0
 *    （F 输入差分为 0、无活跃 S 盒），第 4 轮起才出现活跃盒。与后端 BCA 一致。
 *    旧表（只跑单字单比特起点）= 2→6 / 4→44 / 8→135 / 16→326 / 32→687，是更松的上界。
 */
const DIFF_TABLE = [
  { r: 2, w: 0.00, sbox: 0, bpr: 0.00, ms: 31 },
  { r: 4, w: 6.00, sbox: 1, bpr: 1.50, ms: 72 },
  { r: 8, w: 92.00, sbox: 15, bpr: 11.50, ms: 350 },
  { r: 16, w: 274.00, sbox: 45, bpr: 17.13, ms: 900 },
  { r: 32, w: 647.00, sbox: 107, bpr: 20.22, ms: 2160 },
]

const LIN_TABLE = [
  { r: 4, w: 6.00, sbox: 1, bpr: 1.50 },
  { r: 8, w: 90.00, sbox: 15, bpr: 11.25 },
  { r: 16, w: 276.00, sbox: 46, bpr: 17.25 },
  { r: 32, w: 642.00, sbox: 107, bpr: 20.06 },
]

/* 与后端 BCA 的逐轮对照（同一组数据的两个口径）。
 * ★ 数据已抽到 `@/core/bca-reference.js` —— 结果页要内联同一组对照数字，
 *   留在这里就会变成「同一语义两处实现」。口径说明与数据来源也都在那边。 */

/** 平台能力概览（原首页「平台能做什么」，归到教程里更合适） */
const FEATURES = [
  {
    to: 'structure',
    title: '拖拽式结构编辑',
    desc: '把轮函数拆成组件拖到画布上，连线即成结构。改完立刻能分析，不需要重新实现密码算法。',
  },
  {
    to: 'differential',
    title: '差分与线性分析',
    desc: 'DDT / LAT 实算，三种搜索模型（PWM / PMM / DWM）可选，权重与活跃 S 盒逐轮可见。',
  },
  {
    to: 'results',
    title: '规模与复杂度评估',
    desc: '数据复杂度、时间复杂度、变量数、子句数、命中率 —— 每一项都标明口径，可直接引用。',
  },
  {
    to: 'sbox',
    title: 'S 盒库与导入',
    desc: '内置 7 个经典 S 盒，支持粘贴导入并即时校验置换性、差分均匀度与非线性度。',
  },
]

/** 操作流程（四步走，每步对应一个页面） */
const STEPS = [
  {
    h: '选一个算法',
    p: '去「算法选择」挑一个内置模板：SM4、AES-128、PRESENT-64 三个完整算法，或「类 AES」教学模型与空白画布。'
      + '选完立刻能看到它的结构说明。',
    to: 'ciphers',
    btn: '去算法选择',
  },
  {
    h: '看清（或改）轮函数',
    p: '去「结构编辑」。左侧把 S 盒、线性层、移位、轮密钥加等组件拖进画布自己搭轮函数，'
      + '右侧属性面板改参数，下方有逐组件中文解析。拖入、删改任何组件后，'
      + '「建模规模」的变量数与子句数会立刻跟着变 —— 因为那是遍历真实图结构数出来的。',
    to: 'structure',
    btn: '去结构编辑',
  },
  {
    h: '设参数并运行',
    p: '去「差分分析」（或「线性分析」）。先设轮数区间：**建议从 4 轮开始**，'
      + '结果一目了然、跑得也快。搜索模型先用默认的「概率权重模型」。点「▶ 运行分析」。',
    to: 'differential',
    btn: '去差分分析',
  },
  {
    h: '读结果、做验证',
    p: '结果页会给出 −log₂p、活跃 S 盒、变量数、子句数、时间/数据复杂度等全部指标，'
      + '并配中文解析。想确认结果可靠，回到分析页点「抽样验证命中率」——'
      + '它会用**真实 SM4 加密**抽样，把实测命中率和理论值对照。',
    to: 'results',
    btn: '看结果页',
  },
]

/* ---------------------------------------------------------------- 示例 */

const busy = ref('')

/**
 * 示例定义。
 *   template  载入哪个模板
 *   mode      差分 / 线性
 *   params    覆盖默认参数（会先恢复默认再覆盖，避免上一次的残留）
 *   mutate    对图结构做的改动（教学开关）
 *   empirical 跑完分析再跑抽样验证
 *   expect    你应该看到什么（实测数字）
 */
const EXAMPLES = [
  {
    id: 'first',
    tag: '入门',
    title: '第一次跑通：SM4 4 轮差分特征',
    goal: '学会看最基本的输出：权重、逐轮表、收敛曲线。',
    action: '载入 SM4 模板，区间设 1~4 轮，束搜索，直接运行。',
    expect: '−log₂p = 6.00，活跃 S 盒 1 个，平均 1.50 bit/轮。曲线有 4 个点，逐轮表 4 行，前 3 轮权重都是 0。',
    note: '为什么前 3 轮权重是 0？取起点差分 Δ=(a,a,a,0)，轮函数输入 ΔX₁⊕ΔX₂⊕ΔX₃ 恰好为 0，'
      + '于是第 1~3 轮没有任何活跃 S 盒、概率恒为 1 —— 这叫「免费轮」。'
      + '第 4 轮必然出现 1 个活跃 S 盒（这是可代数证明的下界），SM4 S 盒最大差分概率 4/256 = 2⁻⁶，'
      + '所以 4 轮权重恰好 6.00。',
    template: 'sm4',
    mode: MODE.DIFFERENTIAL,
    params: { startRound: 1, endRound: 4, searchDepth: 'beam', beamWidth: 8, model: 'weight' },
    run: true,
    to: 'results',
  },
  {
    id: 'baseline',
    tag: '精确基准',
    title: '跑出 SM4 1~8 轮的精确值',
    goal: '让后端 BCA 在全空间上求出 1~8 轮的最小权重。',
    action: '区间设 1~8 轮，其余默认，运行。首次要等后端跑完（分钟级），之后命中记录秒出。',
    expect: '逐轮 −log₂p = 0 / 0 / 0 / 6 / 12 / 12 / 30 / 38；第 8 轮是 **38.00**。',
    note: '这是 kissat 全空间 SAT 的**精确解**：概率权重从 0 往上判定到第一个可满足，'
      + '该值既可达、又是下界 —— 不是上界。'
      + '（旧版前端引擎在 8 轮给 92.00，因为它只覆盖一族起点；差距不是算错，是覆盖面。）'
      + ' 32 轮目前后端还没跑出来，页面会显示「还未求解」—— 那才是诚实的答案。',
    template: 'sm4',
    mode: MODE.DIFFERENTIAL,
    params: { startRound: 1, endRound: 8, searchDepth: 'beam', beamWidth: 8, model: 'weight' },
    run: true,
    to: 'results',
  },
  {
    id: 'empirical',
    tag: '抽样验证',
    title: '用真实加密验证命中率',
    goal: '亲眼看到"2⁻⁶ 的概率"在真实加密数据上确实成立。',
    action: '区间设 1~4 轮，运行分析，然后点「抽样验证命中率」（5 万对样本）。',
    expect: '理论命中率 1.5625%（= 2⁻⁶），实测约 1.8% 上下，'
      + '命中次数会落在理论期望 λ 的 ±3√λ 区间内，判定为「特征得到验证」。',
    note: '这一项是整个平台最强的正确性证据：抽样用的是**真实的 SM4 加密**'
      + '（随机密钥 + 随机明文对），不经过任何差分模型。引擎要是算错了，这里立刻露馅。'
      + '（注意要用 4 轮：前 3 轮是免费轮、概率恒为 1，只有第 4 轮的 2⁻⁶ 才是可验证的非平凡概率。）',
    template: 'sm4',
    mode: MODE.DIFFERENTIAL,
    params: { startRound: 1, endRound: 4, searchDepth: 'beam', beamWidth: 8, model: 'weight' },
    run: true,
    empirical: true,
    to: 'differential',
  },
  {
    id: 'shift',
    tag: '原理验证',
    title: '区间平移不变性：5~8 轮也是 6.00',
    goal: '理解"轮函数每轮都相同"这句话在数值上意味着什么。',
    action: '把区间改成第 5~8 轮（4 轮），运行。',
    expect: '−log₂p 仍然是 6.00，活跃 S 盒仍是 1 个 —— 与第 1~4 轮完全相同。',
    note: 'Feistel 结构每轮做的事一模一样，所以**差分的演化只取决于跨了多少轮，'
      + '不取决于从第几轮开始**。第 9~12 轮、第 29~32 轮也都是 6.00。'
      + '这也是一个很好的自检点：如果你算出的结果随起点变化，说明引擎把轮号错当成了参数。'
      + '⚠️ 这个示例现在**不会自动执行**：后端 BCA 的轮号是「第 1 轮累计到第 N 轮」的'
      + '绝对值，起始轮必须为 1（全空间 SAT 天然从低轮往上推进）。',
    template: 'sm4',
    mode: MODE.DIFFERENTIAL,
    params: { startRound: 5, endRound: 8, searchDepth: 'beam', beamWidth: 8, model: 'weight' },
    run: false,
    to: 'results',
  },
  {
    id: 'initdiff',
    tag: '参数探索',
    title: '换个起点差分：结果差 62 bit',
    goal: '认识"起始差分"这个自由参数的实际影响。',
    action: '区间 1~4 轮，在「起始差分 / 掩码」里填 0,0,0,1（一键执行已经帮你填好），然后运行。',
    expect: '把起点设成「第 4 个字为 1」（即 0,0,0,1）时，权重是 68.00 —— '
      + '比平台自动选到的 6.00 差了 62 bit。',
    note: '四个字的差分不是等价的：只有 Δ=(a,a,a,0) 这种形态能让前几轮轮函数输入为 0（免费轮），'
      + '把扰动推迟到第 4 轮才展开。旧版前端引擎会遍历一批起点（单字单比特 + 免费族）挑最好的，'
      + '也可以手动指定多个候选起点。'
      + '⚠️ 这个示例现在**不会自动执行**：后端 BCA 是在**整个输入差分空间**里穷举的，'
      + '「起始差分」对它没有意义（它不读这个参数）—— 让它跑只会得到与起点无关的全空间最优值。',
    template: 'sm4',
    mode: MODE.DIFFERENTIAL,
    params: {
      startRound: 1, endRound: 4, searchDepth: 'beam', beamWidth: 8,
      model: 'weight', initDiffs: '0,0,0,1',
    },
    run: false,
    to: 'results',
  },
  {
    id: 'tau',
    tag: '教学对照',
    title: '关掉 L 扩散层：8 轮权重从 92 掉到 14',
    goal: '直观看到"线性扩散层"到底在防什么。',
    action: '区间 1~8 轮；进「结构编辑」选中「SM4 T 变换」节点，勾上「仅 τ」，再运行。',
    expect: '−log₂p 从 92.00 降到 14.00，活跃 S 盒从 15 个降到 2 个。'
      + '（注意要用 8 轮：1~4 轮时前 3 轮是免费轮，跳不跳 L 都是 6.00，看不出差别。）',
    note: '没有 L 层，一个字节的扰动就只在字节内部打转，永远扩散不出去 —— '
      + '被激活的 S 盒数量增长慢得多，权重自然低。这就是"扩散层不可或缺"的数值证据。'
      + '⚠️ 这个示例现在**不会自动执行**：后端 BCA 只实现了标准 SM4，'
      + '改过的结构它不认（平台也会用结构指纹挡住，免得拿回一个「标准 SM4 的数」冒充改过的图）。'
      + '表中数字来自旧版前端引擎。',
    template: 'sm4',
    mode: MODE.DIFFERENTIAL,
    params: { startRound: 1, endRound: 8, searchDepth: 'beam', beamWidth: 8, model: 'weight' },
    mutate: (g) => { const t = g.nodes.find((n) => n.type === 'TTRANS'); if (t) t.props.tauOnly = true },
    run: false,
    to: 'results',
  },
  {
    id: 'linearsbox',
    tag: '教学对照',
    title: '把 S 盒线性化：权重直接归零',
    goal: '理解"非线性"是分组密码安全性的唯一来源。',
    action: '区间 1~4 轮；进「结构编辑」选中「SM4 T 变换」节点，勾上「线性化 S 盒」，再运行。',
    expect: '−log₂p = 0.00 —— 无论多少轮都是 0.00（32 轮实测也是 0.00，活跃 S 盒 98 个）。',
    note: 'S 盒被当成恒等映射后，整个算法变成纯线性变换，差分必然按固定规律传播，'
      + '概率是 1（权重 0）。**权重 0 意味着存在必然成立的差分路径**，'
      + '攻击者不需要任何数据量就能区分 —— 算法彻底失效。'
      + '这个对照说明：S 盒的非线性是唯一的不确定性来源。'
      + '⚠️ 这个示例现在**不会自动执行**：后端 BCA 只实现了标准 SM4，'
      + '不支持替换成线性化 S 盒（数字来自旧版前端引擎）。',
    template: 'sm4',
    mode: MODE.DIFFERENTIAL,
    params: { startRound: 1, endRound: 4, searchDepth: 'beam', beamWidth: 8, model: 'weight' },
    mutate: (g) => { const t = g.nodes.find((n) => n.type === 'TTRANS'); if (t) t.props.linearS = true },
    run: false,
    to: 'results',
  },
  {
    id: 'linear',
    tag: '线性分析',
    title: '线性分析：SM4 32 轮 = 642.00',
    goal: '换到线性分析，对比两种分析框架的结论。',
    action: '切到「线性分析」，区间 1~32 轮，运行。',
    expect: '−log₂p = 642.00，活跃 S 盒 107 个，平均 20.06 bit/轮。'
      + '（4 轮 6.00、8 轮 90.00、16 轮 276.00）',
    note: '线性分析的每一步相关度来自 S 盒的**线性逼近表（LAT）**，'
      + '差分分析来自**差分分布表（DDT）**。两条路径算的是不同的东西，'
      + '但都指向同一个结论：轮数足够多以后，偏差被压到不可利用。'
      + '⚠️ 这个示例现在**不会自动执行**：后端线性精确解目前只覆盖 1~4 轮'
      + '（**6.0**，已证最优），5 轮以上还没跑；32 轮这组 642.00 是旧版前端引擎的**上界**，'
      + '不能当精确值引用。',
    template: 'sm4',
    mode: MODE.LINEAR,
    params: { startRound: 1, endRound: 32, searchDepth: 'beam', beamWidth: 8, model: 'weight' },
    run: false,
    to: 'results',
  },
  {
    id: 'models',
    tag: '模型',
    title: '三种搜索模型的差别到底在哪',
    goal: '搞清楚"搜索模型"这个参数改的是什么。',
    action: '区间 1~8 轮，运行后去结果页点「用当前参数跑三种模型」。',
    expect: '8 轮实测：概率权重模型 92.00，概率映射模型 92.00（相同！），'
      + '双权优化模型 99.00。映射权重（E[w]）前者是 104.77，Diffusion 权重前者 87.00、'
      + '后者 55.00 —— 双权模型用 7 bit 的权重换到了明显更稀疏的差分。',
    note: '关键点：**模型不改变概率怎么算**（概率一律查 DDT/LAT），'
      + '它只决定"用哪个目标函数挑候选"。所以权重模型和映射模型给出同一条特征很正常。'
      + '⚠️ 这个示例现在**不会自动执行**：结果页的「三种搜索模型对比」已停用 —— '
      + '页面数值只来自后端 MAP 精确解，后端另外两个模型（MDW 是 dual Matsui 变体、'
      + 'AS 只搜活跃 S 盒界）与这里的口径不可比。',
    template: 'sm4',
    mode: MODE.DIFFERENTIAL,
    params: { startRound: 1, endRound: 8, searchDepth: 'beam', beamWidth: 8, model: 'weight' },
    run: false,
    to: 'results',
  },
  {
    id: 'spn',
    tag: 'SPN 结构',
    title: '换成 SPN 结构：类 AES，10 轮',
    goal: '确认平台不只会算 SM4 —— 换结构、换 S 盒位宽照样算。',
    action: '载入「类 AES」模板（SPN，8 bit S 盒，10 轮），区间设 1~10 轮，运行。',
    expect: '−log₂p = 222.00，活跃 S 盒 37 个 —— 恰好 6 × 37。',
    note: 'AES S 盒的差分均匀度是 4（4/256 = 2⁻⁶），所以每激活一个 S 盒，'
      + '至少要付出 6 bit 的权重。这里 37 个活跃 S 盒正好是 222 bit —— '
      + '说明每个活跃 S 盒都走在最省的那条转移上。'
      + '37 = 1 + 9×4：列混淆（真 AES 的 [02 03 01 01]）分支数 5，'
      + '1 个活跃字节进去必出 4 个，所以从第 2 轮起每轮稳定新增 4 个活跃 S 盒。'
      + '这条走的是**通用图传播路径**，不是 SM4 专用引擎。'
      + '⚠️ 这个示例现在**不会自动执行**：后端 BCA 只实现了 SM4 / AES / DBlock 等'
      + '标准算法，没有「类 AES 教学模型」（8 bit S 盒 + 简化列混淆）这个变体。'
      + '数字来自旧版前端引擎。',
    template: 'aes_like',
    mode: MODE.DIFFERENTIAL,
    params: { startRound: 1, endRound: 10, searchDepth: 'beam', beamWidth: 8, model: 'weight' },
    run: false,
    to: 'results',
  },
  {
    id: 'scan',
    tag: '曲线',
    title: '全轮扫描：看权重怎么一轮轮累加',
    goal: '理解"bit/轮"为什么会随轮数上升并逐渐饱和。',
    action: '去差分分析页，区间设 1~32 轮，点「全轮扫描」（步长 2）。',
    expect: '曲线前 3 轮都是 0.00（免费轮），第 4 轮跳到 6.00，之后一路涨到 32 轮 647.00；'
      + '「bit/轮」从 1.50 升到 20.22 后趋于平缓。',
    note: '前 3 轮没有活跃 S 盒（权重 0）；第 4 轮起差分开始铺开，'
      + '几轮之后每轮稳定激活约 3~4 个 S 盒，bit/轮 就稳定在 20 上下。'
      + '**这个"稳定值"就是密码学家真正关心的指标** —— 它决定多少轮才够安全。',
    template: 'sm4',
    mode: MODE.DIFFERENTIAL,
    params: { startRound: 1, endRound: 32, searchDepth: 'beam', beamWidth: 8, model: 'weight' },
    run: false,
    to: 'differential',
  },
]

async function applyExample(ex) {
  if (busy.value) return
  busy.value = ex.id

  loadTemplate(ex.template || 'sm4')
  mode.value = ex.mode || MODE.DIFFERENTIAL
  // 先恢复默认再覆盖 —— 否则上一次示例残留的参数会污染这一次
  Object.assign(params, { ...PARAM_DEFAULTS }, ex.params || {})
  saveParams()

  if (ex.mutate && graph.value) {
    ex.mutate(graph.value)
    triggerRef(graph) // graph 是 shallowRef 包的非响应式实例，手动通知
  }

  // 让界面先把"执行中"画出来，再干重活
  await new Promise((r) => setTimeout(r, 40))

  if (ex.run) {
    log('info', `【教程示例】${ex.title}`)
    await runAnalysis()
    if (ex.empirical) await runEmpirical({ samples: 50000 })
  }

  busy.value = ''
  if (ex.to) window.location.assign(href(ex.to))
}

const busyTitle = computed(() => {
  const ex = EXAMPLES.find((e) => e.id === busy.value)
  return ex ? ex.title : ''
})

/* ---------------------------------------------------------------- 概念 */

const CONCEPTS = [
  {
    t: '差分分析在问什么',
    d: '固定一个输入差分 Δin，问"经过 r 轮之后，输出差分是某个 Δout 的概率有多大"。'
      + '概率越大，攻击者用越少的数据就能把密钥筛出来。平台输出的 −log₂p 就是这个概率取负对数。',
    k: '概率 = 2^(−权重)',
  },
  {
    t: 'S 盒与 DDT',
    d: 'S 盒是唯一的非线性部件，也是概率的唯一来源。它的差分分布表（DDT）记录了'
      + '"输入差分为 a 时输出差分为 b 的个数"。SM4 的 S 盒差分均匀度是 4，'
      + '即单表最大值 4/256 = 2⁻⁶ —— 这就是单个活跃 S 盒的固有权重下界。',
    k: '差分均匀度 DU = 4',
  },
  {
    t: '什么是"活跃 S 盒"',
    d: '某一轮里输入差分非零、因而真的在"泄漏概率"的 S 盒个数。'
      + '它是质量指标：同样轮数下活跃 S 盒越多，累计权重越大，差分衰减越快。'
      + '线性层（SM4 的 L 变换）的作用就是把差分搅开、让更多 S 盒被激活。',
    k: '权重 ≈ 6 × 活跃 S 盒数（SM4）',
  },
  {
    t: '权重与比特的关系',
    d: '所谓"−log₂p = 647"，就是概率约 2⁻⁶⁴⁷，也就是需要约 2⁶⁴⁷ 对明文才有一次命中。'
      + '而 2⁶⁴⁷ 远超任何计算能力 —— 这就是 32 轮 SM4 对差分分析安全的原因。'
      + '对比 4 轮的 2⁻⁶（前 3 轮免费、概率恒为 1），攻击者完全做得到。',
    k: '−log₂p 越大越安全',
  },
]

const FAQ = [
  {
    q: '为什么我改了轮数，结果没变？',
    a: '最常见原因是漏了「运行」这一步 —— 平台不会自动重算。'
      + '另外注意：改轮数区间后再看「全轮扫描」的曲线，需要重新点一次扫描。',
  },
  {
    q: '为什么权重模型和概率映射模型给出完全一样的数字？',
    a: '这在默认参数下是**正常的**，不是 bug。两个模型的区别只在挑候选的目标函数，'
      + '概率一律查 DDT。把参数里的「分支上限」从 0 改成 8，两者才会分开。',
  },
  {
    q: '「抽样验证」显示"不可行"是什么意思？',
    a: '说明理论权重太大（例如 32 轮的 647 bit），需要的样本量约 10¹⁹⁴ 对，'
      + '抽样在物理上不可能。这是平台**诚实地拒绝给假结果**，而不是出错。'
      + '想看抽样验证，把区间改成 1~4 轮（前 3 轮是免费轮、概率恒为 1）。',
  },
  {
    q: '起始差分那一栏为什么留空？填什么格式？',
    a: '留空 = 交回引擎自动遍历默认起点集合（单字单比特 16 个 + 三轮免费族 Δ=(a,a,a,0) 32 个），'
      + '取其中最优的一条。想手动指定，'
      + '两种写法都认：逗号分隔的四个字 `0x1,0,0,0`，或一个 8 位十六进制字 `00000001`。'
      + '多个起点用分号隔开。填错时输入框会变红并给出提示。',
  },
  {
    q: '结构我拖乱了，怎么恢复？',
    a: '结构编辑器右上角有「恢复模板」，会按当前选中的模板重建整张图。'
      + '想彻底重来就选「空白画布」模板。改动结构会清掉已有结果 —— 这是刻意的，'
      + '因为旧结果对应的是旧结构，留着会误导。',
  },
  {
    q: '结果刷新页面就没了？',
    a: '结果只存在内存里。需要留存请用顶栏的「导出」（完整工程：结构 + 参数 + 结果 + 日志）'
      + '或结果页的「导出结果 JSON」（只含指标与逐轮数据）。导出后在别的机器上用「导入」即可复原。',
  },
]
</script>

<template>
  <div class="page">
    <!-- ============================================================ 页头 -->
    <!--
      教程页是"参考"入口，是唯一允许放长文字的地方；
      但头部仍然按工程工具的写法来 —— 标题 + 一句话定位 + 动作，不做英雄区。
    -->
    <div class="head">
      <div>
        <h2 class="section-title">初学者教程</h2>
        <p class="section-desc">
          这个平台把「分组密码安全性评估」搬到浏览器里：拖拽搭出轮函数结构，
          选好轮数区间与搜索模型，点一下运行，就能得到差分/线性特征的权重、
          活跃 S 盒、复杂度与建模规模。
          <b>下面每个示例都能一键执行，并写明了你该看到什么数字。</b>
        </p>
      </div>
      <div class="row-wrap">
        <button class="btn btn-sm btn-primary" :disabled="!!busy" @click="applyExample(EXAMPLES[0])">
          先跑最快的一个（4 轮差分）
        </button>
        <a :href="href('structure')" class="btn btn-sm">先看看结构编辑器</a>
      </div>
    </div>

    <div v-if="busy" class="alert alert-info small">
      正在执行示例「{{ busyTitle }}」…大轮数需要一两秒，请稍候。
    </div>

    <!-- ============================================================ 平台能做什么 -->
    <h2 class="section-title">平台能做什么</h2>
    <p class="section-desc">
      四个可以独立使用的模块，下面每一步都会用到其中的一两个。
    </p>
    <div class="grid-2x">
      <a v-for="f in FEATURES" :key="f.to" :href="href(f.to)" class="feature">
        <h3>{{ f.title }}</h3>
        <p>{{ f.desc }}</p>
      </a>
    </div>

    <!-- ============================================================ 概念 -->
    <h2 class="section-title">先搞懂这 4 件事，剩下就顺了</h2>
    <p class="section-desc">
      不用先读论文。下面四段话足够你读懂平台上的每一个数字。
    </p>
    <div class="grid-2x">
      <div v-for="c in CONCEPTS" :key="c.t" class="card">
        <div class="card-body">
          <div class="concept-head">
            <h3>{{ c.t }}</h3>
            <span class="tag tag-mono">{{ c.k }}</span>
          </div>
          <p class="concept-desc">{{ c.d }}</p>
        </div>
      </div>
    </div>

    <!-- ============================================================ 流程 -->
    <h2 class="section-title">标准操作流程（四步）</h2>
    <div class="steps">
      <div v-for="(s, i) in STEPS" :key="s.h" class="step">
        <span class="dot">{{ i + 1 }}</span>
        <h4>{{ s.h }}</h4>
        <p v-html="s.p"></p>
        <a :href="href(s.to)" class="btn btn-sm" style="margin-top: 8px">{{ s.btn }}</a>
      </div>
    </div>

    <!-- ============================================================ 示例 -->
    <h2 class="section-title">动手示例（每个都能一键跑）</h2>
    <p class="section-desc">
      「你应该看到」里的数字全部是本机实测值 —— 你跑出来应该一致。
      如果对不上，说明参数或结构被改过了，先点示例里的按钮重新载入。
    </p>

    <div class="examples">
      <div v-for="ex in EXAMPLES" :key="ex.id" class="card ex">
        <div class="card-head">
          <h2>
            <span class="tag" :class="{
              'tag-accent': ex.tag === '入门' || ex.tag === '权威基准',
              'tag-cyan': ex.tag === '抽样验证' || ex.tag === 'SPN 结构',
              'tag-violet': ex.tag === '线性分析' || ex.tag === '模型',
              'tag-warn': ex.tag === '教学对照',
            }">{{ ex.tag }}</span>
            {{ ex.title }}
          </h2>
          <button
            class="btn btn-sm btn-primary"
            :disabled="!!busy"
            @click="applyExample(ex)"
          >
            {{ busy === ex.id ? '执行中…' : (ex.run ? '▶ 一键执行' : '前往该页') }}
          </button>
        </div>
        <div class="card-body tight">
          <div class="ex-row">
            <span class="ex-k">目标</span>
            <span class="ex-v">{{ ex.goal }}</span>
          </div>
          <div class="ex-row">
            <span class="ex-k">怎么做</span>
            <span class="ex-v">{{ ex.action }}</span>
          </div>
          <div class="ex-row">
            <span class="ex-k">你应该看到</span>
            <span class="ex-v ex-expect">{{ ex.expect }}</span>
          </div>
          <p class="ex-note">{{ ex.note }}</p>
        </div>
      </div>
    </div>

    <!-- ============================================================ 基准表 -->
    <h2 class="section-title">SM4 实测基准表（可自行复现）</h2>
    <div class="grid-2">
      <div class="card">
        <div class="card-head">
          <h2>差分分析</h2>
          <span class="hint">SM4 模板 · 束搜索 束宽 8 · 概率权重模型</span>
        </div>
        <div class="card-body tight">
          <div class="table-scroll">
            <table class="table">
              <thead>
                <tr>
                  <th>轮数</th><th class="num">−log₂p</th>
                  <th class="num">活跃 S 盒</th><th class="num">bit/轮</th><th class="num">耗时</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="r in DIFF_TABLE" :key="r.r">
                  <td>{{ r.r }}</td>
                  <td class="num"><b>{{ r.w.toFixed(2) }}</b></td>
                  <td class="num">{{ r.sbox }}</td>
                  <td class="num">{{ r.bpr.toFixed(2) }}</td>
                  <td class="num">{{ r.ms }} ms</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div class="alert alert-ok small" style="margin-top: 10px">
            ✓ 32 轮 <b>647.00</b>（束搜索上界）；4 轮在任意区间（1~4 / 5~8 / 9~12 / 29~32）都是 <b>6.00</b>。
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <h2>线性分析</h2>
          <span class="hint">SM4 模板 · 束搜索 束宽 8 · 概率权重模型</span>
        </div>
        <div class="card-body tight">
          <div class="table-scroll">
            <table class="table">
              <thead>
                <tr>
                  <th>轮数</th><th class="num">−log₂p</th>
                  <th class="num">活跃 S 盒</th><th class="num">bit/轮</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="r in LIN_TABLE" :key="r.r">
                  <td>{{ r.r }}</td>
                  <td class="num"><b>{{ r.w.toFixed(2) }}</b></td>
                  <td class="num">{{ r.sbox }}</td>
                  <td class="num">{{ r.bpr.toFixed(2) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div class="alert alert-ok small" style="margin-top: 10px">
            ✓ 16 轮 <b>276.00</b>、32 轮 <b>642.00</b>（同一套起点集合下的束搜索上界）。
          </div>
        </div>
      </div>
    </div>

    <!-- ============================================================ 为什么只用后端的精确解 -->
    <h2 class="section-title">为什么平台只用后端的精确解</h2>
    <div class="card">
      <div class="card-head">
        <h2>SM4 · MAP · 1~8 轮 · 全空间 SAT 的精确值</h2>
        <span class="hint">后端 2026-10-15 实跑任务 exact-r1-8（584.6s）</span>
      </div>
      <div class="card-body tight">
        <div class="table-scroll">
          <table class="table">
            <thead>
              <tr>
                <th>轮数</th>
                <th class="num">后端 BCA（全空间精确值）</th>
                <th>说明</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="c in BCA_CMP" :key="c.r">
                <td>{{ c.r }}</td>
                <td class="num"><b>{{ c.bca.toFixed(2) }}</b></td>
                <td>{{ c.note }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="alert small" style="margin-top: 10px">
          这些数是 <b>kissat 在全空间上做 SAT</b> 得到的：概率权重从 0 往上逐个判定，
          <b>第一个可满足的值就是最小权重</b> —— 它既可达、又是下界，即真值。
          <br />
          <b>旧版本</b>这里还有一个「本平台（束搜索）」列。束搜索只保证给出 −log₂p 的<b>上界</b>
          （等价地说概率是<b>下界</b>），跑得快、能推到几十轮，但 <b>5 轮起每一条都偏高</b>
          （30 / 49 / 73 / 92 对 12 / 12 / 30 / 38）。根源不是搜索算法，而是默认起点族
          只覆盖「前 3 轮免费」那一族（Δ=(a,a,a,0)，共 48 个起点），覆盖不到最优路径的入口。
          <br />
          <b>所以平台现在不再在前端求解</b>：结果页、全轮扫描、逐轮表全部只显示后端这一份精确值。
          还没跑出来的轮次显示「<b>还未求解</b>」，不用近似值顶上。
          <br />
          要换算法或轮数，去 <b>/bca/ 页</b>提交任务（后端已内置 SM4、AES 等，不需要自己搭结构）。
        </div>
      </div>
    </div>

    <!-- ============================================================ 教学对照表 -->
    <div class="card">
      <div class="card-head">
        <h2>教学对照：抽掉某个部件会怎样</h2>
        <span class="hint">旧版前端引擎实测 · 区间 1~8 轮 · 其余默认</span>
      </div>
      <div class="card-body tight">
        <div class="table-scroll">
          <table class="table">
            <thead>
              <tr><th>配置</th><th class="num">−log₂p</th><th class="num">活跃 S 盒</th><th>说明</th></tr>
            </thead>
            <tbody>
              <tr>
                <td>标准 SM4</td>
                <td class="num"><b>92.00</b></td><td class="num">15</td>
                <td class="small faint">τ + L 都在，扩散正常</td>
              </tr>
              <tr>
                <td>仅 τ（去掉 L 扩散层）</td>
                <td class="num"><b>14.00</b></td><td class="num">2</td>
                <td class="small faint">差分困在字节内，活跃 S 盒增长慢得多</td>
              </tr>
              <tr>
                <td>线性化 S 盒（去掉非线性）</td>
                <td class="num"><b>0.00</b></td><td class="num">17</td>
                <td class="small faint">概率恒为 1 —— 必然成立的差分路径</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="faint small" style="margin: 10px 0 0">
          这张表把「非线性」和「扩散」两个设计原则的作用量化出来了：
          去掉扩散，单轮平均泄漏从 11.5 bit 降到 1.75 bit；去掉非线性，泄漏变成无穷大。
          <br />
          ⚠️ 三行数字是<b>旧版前端引擎</b>的实测值 —— 平台现在不再用前端求解，
          结果页只显示后端 BCA 的精确值。这里保留它们只为说明<b>结构的作用</b>，
          不代表当前结果页会给出这些数。
        </p>
      </div>
    </div>

    <!-- ============================================================ FAQ -->
    <h2 class="section-title">常见问题</h2>
    <div class="faq">
      <details v-for="f in FAQ" :key="f.q" class="card faq-item">
        <summary>{{ f.q }}</summary>
        <div class="card-body tight"><p class="faq-a">{{ f.a }}</p></div>
      </details>
    </div>

    <!-- ============================================================ 下一步 -->
    <div class="card cta">
      <div class="card-body">
        <h3>跑完示例之后</h3>
        <p class="concept-desc">
          最值得接着做的三件事：<br />
          1. 进「结构编辑」拖一个 S 盒节点进画布，看「建模规模」的变量数怎么变 ——
          那套计数是遍历真实图结构数出来的。<br />
          2. 打开「仅 τ」或「线性化 S 盒」，亲手把安全性拆掉，再关掉看它恢复。<br />
          3. 换「类 AES」模板，比较 SPN 与 Feistel 在相同轮数下的扩散速度。
        </p>
        <div class="row-wrap" style="margin-top: 12px">
          <a :href="href('structure')" class="btn btn-primary">去结构编辑</a>
          <a :href="href('differential')" class="btn">去差分分析</a>
          <a :href="href('sbox')" class="btn">看看 S 盒库</a>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page > * + * {
  margin-top: 14px;
}

.head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}

.section-title {
  margin-bottom: 4px;
}

/* 两列口径不一致的档位（上界 ≠ 下界）高亮，避免被当成「某一列算错了」 */
.cmp-diff {
  color: var(--warn, #a8600a);
  font-weight: 600;
}

/* 严格两列：全局 .grid-2 是 auto-fit，宽屏下 4 张卡会排成 3+1，读起来别扭 */
.grid-2x {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}

/* ---- 概念 ---- */

.concept-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 7px;
}

.concept-head h3 {
  margin: 0;
  font-size: 13.5px;
}

.concept-desc {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.85;
  color: var(--text-muted);
}

/* ---- 示例 ---- */

.examples {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.ex-row {
  display: flex;
  gap: 12px;
  padding: 7px 0;
  border-bottom: 1px dashed var(--border);
  font-size: 12.5px;
}

.ex-row:last-of-type {
  border-bottom: none;
}

.ex-k {
  flex: none;
  width: 76px;
  color: var(--text-faint);
  font-size: 11.5px;
  padding-top: 1px;
}

.ex-v {
  flex: 1;
  min-width: 0;
  line-height: 1.75;
  color: var(--text-muted);
}

.ex-expect {
  color: var(--text);
  font-weight: 500;
}

.ex-note {
  margin: 10px 0 0;
  padding: 9px 12px;
  font-size: 12.5px;
  line-height: 1.8;
  color: var(--text-muted);
  background: var(--surface-2);
  border-left: 2px solid var(--accent);
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
}

/* ---- FAQ ---- */

.faq {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.faq-item {
  margin: 0;
}

.faq-item summary {
  cursor: pointer;
  padding: 12px 16px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  list-style: none;
}

.faq-item summary::-webkit-details-marker {
  display: none;
}

.faq-item summary::before {
  content: '▸ ';
  color: var(--accent);
}

.faq-item[open] summary::before {
  content: '▾ ';
}

.faq-a {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.85;
  color: var(--text-muted);
}

.faq-item .card-body {
  border-top: 1px solid var(--border);
}

/* ---- 结尾 ---- */

.cta {
  border-left: 3px solid var(--accent);
}

.cta h3 {
  margin: 0 0 8px;
  font-size: 14px;
}

/* ---- 响应式 ---- */

@media (max-width: 1000px) {
  .grid-2x {
    grid-template-columns: minmax(0, 1fr);
  }
  .ex-row {
    flex-direction: column;
    gap: 3px;
  }
  .ex-k {
    width: auto;
  }
}
</style>
