<script setup>
/**
 * 差分 / 线性分析页。
 *
 * 两种模式共用同一个组件（靠 props.mode 区分）—— 这是刻意的：
 * 参数面板、可视化、指标卡、日志如果各写两份，早晚会出现
 * 「差分页有某个开关、线性页忘了加」这类不一致。
 *
 * 页面的三段式：**参数 → 运行 → 观测**。
 * 参数全部走 stores/platform.js 的 params（唯一的装配入口），
 * 这里只负责画控件，不改语义。
 *
 * ⚠️ 一个重要约束：所有数值都必须是引擎真算出来的。
 *    页面上不出现任何"估算/示意"的数字 —— 那是分析平台最忌讳的事。
 */
import { computed, onMounted, ref, watch } from 'vue'

import { href } from '@/pages.js'
import {
  MODE, SEARCH_MODEL, MODEL_SPEC,
} from '@/core/analysis.js'
import { fmtMs, fmtInt } from '@/core/explain.js'
import {
  params, saveParams, resetParams, roundRangeIssue, effectiveRange,
  modelInfo, modelGrade, result, status, progress, mode,
  lastError,
  logs, clearLogs, runAnalysis, scanAllRounds, runEmpirical,
  empirical, empiricalRunning, characteristicExplain, securityExplain,
  templateId, graph, log, initDiffsInfo, teachingFlags,
} from '@/stores/platform.js'

import MetricCard from '@/components/MetricCard.vue'
import LineChart from '@/components/LineChart.vue'
import LogPanel from '@/components/LogPanel.vue'
import ExplainPanel from '@/components/ExplainPanel.vue'
import FoldPanel from '@/components/FoldPanel.vue'

const props = defineProps({
  mode: { type: String, default: MODE.DIFFERENTIAL },
})

/* ---------------------------------------------------------------- 模式同步 */

watch(
  () => props.mode,
  (m) => {
    const next = m === MODE.LINEAR ? MODE.LINEAR : MODE.DIFFERENTIAL
    if (mode.value !== next) {
      mode.value = next
      log('info', `切换到${next === MODE.LINEAR ? '线性' : '差分'}分析模式`)
    }
  },
  { immediate: true },
)

const isLinear = computed(() => mode.value === MODE.LINEAR)
const kindLabel = computed(() => (isLinear.value ? '线性逼近' : '差分特征'))

/**
 * 当前显示的结果是不是**另一个模式**算出来的。
 *
 * 结果在整站内共享（sessionStorage 里只有一份 `result`），换页时**不会自动重算** ——
 * 于是在差分页跑完、直接点导航去「线性分析」，线性页会把那份**差分**结果原样显示出来：
 * 标题写着「每一步查 LAT」，表里的数字却来自 DDT。这会被读成
 * 「两种分析算出来一模一样」，进而怀疑引擎 —— 必须显式说清。
 *
 * 返回 'linear' / 'differential'（= 结果显示的其实是哪个模式），一致则为 null。
 */
const staleMode = computed(() => {
  const r = result.value
  if (!r || !r.mode || r.mode === mode.value) return null
  return r.mode === MODE.LINEAR ? 'linear' : 'differential'
})

/**
 * 图里是否用了「非等宽查找表」或「超大 S 盒」。
 *
 * 这两类会把**能力边界**写进结果数字里（见 sbox.js 的 SBOX_TABLE_CAP / splitSBoxInputs）：
 *   · 非等宽查找表（如 16→32）：按「整字一次查表」应用；输出比词宽大时高位被截断。
 *   · 宽输出（≥31bit）的**线性侧不支持** → 搜索会给出 −log₂p = 0.00 的占位值，
 *     会被读成「存在零权重线性逼近」。必须在结果旁显式说清，绝不静默。
 *   · 超大盒（16×16 等）：DDT/LAT 全表建不起来，差分走按需单行（精确），四项指标不可用。
 */
const sboxCapability = computed(() => {
  const g = graph.value
  if (!g?.nodes) return null
  const nonSquare = []
  const oversized = []
  let linearUnsupported = false
  let truncating = null
  const blockBits = g.nodes.find((n) => n.type === 'INPUT')?.props?.bits || 32
  for (const n of g.nodes) {
    if (n.type !== 'SBOX') continue
    const sb = g.getSBox?.(n.props.sboxId)
    if (!sb) continue
    if (sb.inBits !== sb.outBits) {
      nonSquare.push(sb)
      if (sb.outBits >= 31) linearUnsupported = true
      if (sb.outBits > Math.min(32, blockBits | 0 || 32)) truncating = sb
    }
    if (!sb.fullTableFeasible()) oversized.push(sb)
  }
  if (!nonSquare.length && !oversized.length) return null
  return { nonSquare, oversized, linearUnsupported, truncating }
})

/* ---------------------------------------------------------------- 参数控件 */

const MODELS = Object.values(MODEL_SPEC)

function clampAndSave(key, value, lo, hi) {
  let v = Math.round(Number(value))
  if (!Number.isFinite(v)) v = params[key]
  if (lo !== undefined) v = Math.max(lo, v)
  if (hi !== undefined) v = Math.min(hi, v)
  params[key] = v
  saveParams()
}

function setText(key, value) {
  params[key] = String(value ?? '')
  saveParams()
}

function doReset() {
  resetParams()
  log('info', '参数已恢复默认值（轮数区间 1~32、束宽 8、预算 12 s）')
}

const running = computed(() => status.value === 'running')
const canRun = computed(() => !running.value && !empiricalRunning.value)

/* ---------------------------------------------------------------- 运行 */

async function doRun() {
  if (running.value) return
  scan.value = []
  replay.value = -1
  await runAnalysis()
  replay.value = -1
}

/* ---- 全轮扫描 ---- */

const scan = ref([])
const scanning = ref(false)
const scanStep = ref(2)

async function doScan() {
  if (running.value || scanning.value) return
  scanning.value = true
  scan.value = []
  const r = effectiveRange.value
  await scanAllRounds({
    step: Math.max(1, scanStep.value),
    from: Math.max(r.start, 4),
    to: r.end,
    onTick: (row) => scan.value.push(row),
  })
  scanning.value = false
}

const scanPoints = computed(() => scan.value.map((r) => ({ x: r.rounds, y: r.weight })))
const scanSecond = computed(() => scan.value.map((r) => ({ x: r.rounds, y: r.activeSboxes })))

/* ---- 抽样验证 ---- */

const sampleCount = ref(200000)

async function doEmpirical() {
  if (empiricalRunning.value) return
  await runEmpirical({ samples: sampleCount.value })
}

/* ---------------------------------------------------------------- 可视化数据 */

/** 逐轮曲线：[{ x: 轮数, y: 累计权重, active: 本轮活跃 S 盒 }]
 *
 * ⚠️ `pending` 行（后端还没解到的轮）**不画**。原来用 `null → 0` 补位，曲线会在
 * 第 9 轮处从 38 直落到 0 —— 看起来像"强度骤降"，而真相是"这一轮还没算"。
 * 未解轮次由页面文字说明，不靠一段假曲线表达。 */
const solvedPerRound = computed(() =>
  (result.value?.perRound || []).filter((r) => !r.pending))

const curvePoints = computed(() => solvedPerRound.value.map((r) => ({
  x: r.round,
  y: Number.isFinite(r.weight) ? r.weight : 0,
  active: r.activeSboxes ?? 0,
})))

const curveSecond = computed(() =>
  solvedPerRound.value.map((r) => ({ x: r.round, y: r.cumActive ?? 0 })))

/** 「运行时间」卡的副标题：读已有记录 ≠ 实跑，别把 194ms 说成搜索耗时 */
const timingNote = computed(() => {
  const be = result.value?.backend
  if (be?.followed) return '沿用进行中的任务（只读）'
  if (be?.cached) return '读取后端已有记录，未重新求解'
  if (be?.timedOut) return '护栏中止，仅含已落盘轮次'
  return '本次搜索实测耗时'
})

/** 还有轮次没解出来时，给出「继续求解」入口（**不会**自动发起长跑） */
const pendingSolve = computed(() => {
  const p = result.value?.backend?.pendingRounds || []
  if (!p.length) return null
  return { from: p[0], to: p[p.length - 1], count: p.length }
})

/* 「运行分析」只读已有记录（秒出）；要往后推进必须用户显式点这个按钮 ——
   后端同一时刻只允许一个搜索进程，自动发起会把随后的线性/其它算法全判成 busy。 */
function continueSolving() {
  return runAnalysis({ forceRun: true })
}

/**
 * 回放游标。
 * -1 = 全部显示；否则只画到第 N 个点，用来"重放"搜索过程 ——
 * 让初学者看到权重是一轮一轮累加上去的，而不是凭空冒出来的一个数。
 */
const replay = ref(-1)

const replayMax = computed(() => Math.max(0, curvePoints.value.length - 1))

function setReplay(v) {
  replay.value = Number(v)
}

function replayTo(i) {
  replay.value = i
}

const activeStrip = computed(() => {
  const pr = result.value?.perRound || []
  const maxW = Math.max(1, ...pr.map((r) => r.roundWeight || 0))
  return pr.map((r) => ({
    round: r.round,
    active: r.activeSboxes ?? 0,
    cumActive: r.cumActive ?? 0,
    roundWeight: r.roundWeight ?? 0,
    // 强度用于条带底色（0~1）
    intensity: Math.min(1, (r.roundWeight || 0) / maxW),
  }))
})

/** 逐轮状态（SM4 路径才有 state；SPN 路径为 undefined） */
const hasState = computed(() =>
  (result.value?.perRound || []).some((r) => Array.isArray(r.state)))

/* ---------------------------------------------------------------- 指标 */

const m = computed(() => result.value?.metrics || null)
const md = computed(() => result.value?.model || null)

function fmtBig(n) {
  if (n === null || n === undefined) return '—'
  const v = Number(n)
  if (!Number.isFinite(v)) return '—'
  if (v <= 0) return '0'
  if (v < 1e4) return v.toFixed(0)
  const e = Math.floor(Math.log10(v))
  const mant = v / Math.pow(10, e)
  return `${mant.toFixed(2)}×10${sup(e)}`
}

const SUP = { 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹' }
function sup(n) {
  return String(n).split('').map((c) => (c === '-' ? '⁻' : SUP[c] || c)).join('')
}

const fmtProb = (p) => {
  if (!Number.isFinite(p) || p <= 0) return '—'
  if (p >= 0.01) return (p * 100).toFixed(2) + '%'
  const w = -Math.log2(p)
  return `2${sup(-Math.round(w))}`
}

/** 时间复杂度（攻击侧）—— 2^猜测比特 × 数据量 */
const timeComplexityText = computed(() => {
  if (!m.value) return '—'
  if (Number.isFinite(m.value.timeComplexity) && m.value.timeComplexity > 0) {
    return fmtBig(m.value.timeComplexity)
  }
  return fmtBig(Math.pow(2, m.value.keyGuesses ?? 0) * (m.value.dataComplexity || 1))
})

const hitRateText = computed(() => {
  if (empirical.value?.feasible) return (empirical.value.measured * 100).toFixed(4) + '%'
  if (!m.value) return '—'
  return fmtProb(m.value.perRoundHitRate)
})

/** 概率的 2 的幂写法：权重可能是 647 这种大数，直接算 2^-647 会下溢成 0 */
const probText = computed(() =>
  (m.value ? `p ≈ 2${sup(-Math.round(m.value.weight))}` : ''))

const hitRateSub = computed(() => {
  if (empirical.value?.feasible) {
    return `实测（抽样 ${fmtInt(empirical.value.samples)} 对，命中 ${empirical.value.hits} 次）`
  }
  if (!m.value) return ''
  return '理论单轮命中率 2^(−平均权重)'
})

/* ---------------------------------------------------------------- 解析 */

const charExplain = computed(() => characteristicExplain.value?.summary || [])
const charDetail = computed(() => characteristicExplain.value?.perRound || [])
const secExplain = computed(() => securityExplain.value || [])

/* ---------------------------------------------------------------- 参数说明文案 */

const modelHelp = computed(() => MODEL_SPEC[params.model] || MODEL_SPEC.weight)

/* 页面挂载时提示当前上下文，让日志面板不至于一开始就是空的 */
onMounted(() => {
  log('info', `分析页就绪：${kindLabel.value}｜当前算法「${graph.value?.meta?.name || '未命名'}」`
    + `（模板 ${templateId.value}）`)
})
</script>

<template>
  <div class="page">
    <!-- ============================================================ 标题 -->
    <div class="head">
      <div>
        <h2 class="section-title">
          {{ isLinear ? '线性分析' : '差分分析' }}
          <span class="tag" :class="isLinear ? 'tag-violet' : 'tag-accent'">
            {{ isLinear ? '线性逼近搜索' : '差分特征搜索' }}
          </span>
        </h2>
        <p class="section-desc">
          引擎按结构编辑器里那张图逐轮推进，每一步查
          <b>{{ isLinear ? 'LAT' : 'DDT' }}</b> 得到{{ isLinear ? '掩码相关度' : '转移概率' }}，
          逐轮累加成 −log₂p。所有数字都是实测值，页面上不出现估算量。
        </p>
        <p class="small muted" style="margin-top: 4px">
          两种模式的 −log₂p <b>可能相等</b>，这不是算错：当 S 盒的最优差分概率与最优线性相关度
          数值相同（如 AES S 盒，差分 4/256 与相关度 16/128 的权重都恰好是 6.00），
          且各轮活跃 S 盒数一致时，总权重自然相同。此时比较<b>输入 / 输出掩码</b>即可分辨 ——
          引擎走的是两套独立计算（DDT vs LAT），不是同一份结果换个标签。
        </p>
        <p class="small muted" style="margin-top: 4px">
          口径提醒：本页的 −log₂p 由<b>后端 BCA 全空间 SAT 精确求解</b>给出 ——
          概率权重从 0 往上逐个判定到第一个可满足，该值<b>既可达、又是下界</b>，即真值。
          后端还没跑到的轮次会显示「<b>还未求解</b>」，不用近似值顶上。
          原始记录见 <a :href="href('bca')">后端搜索页</a>。
        </p>
      </div>
      <div class="row-wrap">
        <span class="tag tag-mono">第 {{ effectiveRange.start }}~{{ effectiveRange.end }} 轮</span>
        <span class="tag tag-mono">{{ effectiveRange.rounds }} 轮</span>
        <span v-if="m" class="tag tag-ok">−log₂p = {{ m.weight.toFixed(2) }}</span>
      </div>
    </div>

    <!-- 结果与当前页口径不一致：跨页跳转不会自动重算，不说明就会张冠李戴 -->
    <div v-if="staleMode" class="alert alert-warn stale-result" style="margin-bottom: 14px">
      <b>⚠ 下面显示的是「{{ staleMode === MODE.LINEAR ? '线性' : '差分' }}」模式的结果，不是本页的</b>
      <span>
        —— 它是在{{ staleMode === MODE.LINEAR ? '线性' : '差分' }}分析页算出来的。
        结果在整站内共享，换页<b>不会</b>自动重算：点 <b>运行分析</b> 才会用本页的
        {{ isLinear ? 'LAT（线性掩码）' : 'DDT（差分概率）' }} 重新算一遍。
      </span>
    </div>

    <!-- 查找表 / 大 S 盒的能力边界：数字旁边必须说清「哪些是精确的、哪些不是」 -->
    <div v-if="sboxCapability" class="alert alert-warn" style="margin-bottom: 14px">
      <b>⚠ 图里用了查找表 / 大 S 盒，结果的精确范围有限</b>
      <span v-if="sboxCapability.nonSquare.length">
        · <b>非等宽查找表</b>（{{ sboxCapability.nonSquare.map((s) => `${s.inBits}→${s.outBits}`).join('、') }}）：
        按「整字一次查表」应用（索引取字的低位），<b>不平铺</b>。
      </span>
      <span v-if="sboxCapability.truncating">
        · ⚠️ 该表输出 {{ sboxCapability.truncating.outBits }}bit 超过词宽
        {{ graph?.nodes?.find((n) => n.type === 'INPUT')?.props?.bits || 32 }}bit →
        <b>高位会被截断</b>。
      </span>
      <span v-if="sboxCapability.linearUnsupported">
        · ⚠️ <b>宽输出（≥31bit）的线性（Matsui）分析不支持</b>：宽输出的 γ 无法枚举，
        没有可行的精确算法。本页若显示 −log₂p = <b>0.00</b>，那是<b>占位值</b>，
        <b>不是</b>「存在零权重线性逼近」。
      </span>
      <span v-if="sboxCapability.oversized.length">
        · <b>超大 S 盒</b>（{{ sboxCapability.oversized.map((s) => `${s.inBits}×${s.outBits}`).join('、') }}）：
        DDT/LAT 全表建不起来 → <b>差分侧改「按需单行」，仍然精确</b>；
        差分均匀度 / 线性度等全局指标与线性侧不可用。
      </span>
    </div>

    <!-- 教学对照开关的显式提醒：不然用户会以为平台算错了 -->
    <div v-if="teachingFlags" class="alert alert-warn" style="margin-bottom: 14px">
      <b>⚠ 教学对照开关已打开</b>
      <span v-if="teachingFlags.linearS">
        · <b>线性化 S 盒</b>：S 盒被当作恒等映射，差分确定性直通，
        概率退化为 1 → 权重恒为 <b>0.00</b>，意味着存在「必然成立」的差分路径。
      </span>
      <span v-if="teachingFlags.tauOnly">
        · <b>仅 τ</b>：跳过 L 线性扩散层，差分无法跨字节传播 → 活跃 S 盒大幅减少、权重显著下降。
      </span>
      <div class="small" style="margin-top: 5px">
        两个开关都在「结构编辑 → 选中 T 变换节点」里关闭。这是用来观察扩散层作用的对照片段。
      </div>
    </div>

    <div v-if="roundRangeIssue" class="alert alert-warn small" style="margin-bottom: 14px">
      ⚠ {{ roundRangeIssue }}
    </div>

    <!-- ============================================================ 主体 -->
    <div class="main-grid">
      <!-- ---------------------------------------------------------- 参数 -->
      <aside class="params">
        <div class="card">
          <div class="card-head">
            <h2>分析参数</h2>
            <button class="btn btn-sm" @click="doReset">恢复默认</button>
          </div>

          <div class="card-body tight">
            <!-- 轮数区间 -->
            <div class="sub-title">轮数区间</div>
            <div class="two">
              <div class="field">
                <label>起始轮</label>
                <input class="input input-num" type="number" min="1" max="64"
                  :value="params.startRound"
                  @change="clampAndSave('startRound', $event.target.value, 1, 64)" />
              </div>
              <div class="field">
                <label>结束轮</label>
                <input class="input input-num" type="number" min="1" max="64"
                  :value="params.endRound"
                  @change="clampAndSave('endRound', $event.target.value, 1, 64)" />
              </div>
            </div>
            <div class="tip">
              从第 <b>1</b> 轮开始才能做抽样验证（起点必须是真实的加密中间态）。
              区间不从 1 开始时，平台仍会算，但抽样的那一项会诚实返回"不可行"。
            </div>

            <!-- 搜索模型 -->
            <div class="sub-title">搜索模型</div>
            <div class="models">
              <button
                v-for="mo in MODELS" :key="mo.id"
                class="opt-card"
                :class="{ on: params.model === mo.id }"
                @click="params.model = mo.id; saveParams()"
              >
                <div class="opt-name">{{ mo.name }} <span class="mono faint">{{ mo.short }}</span></div>
                <div class="opt-formula">{{ mo.formula }}</div>
              </button>
            </div>
            <div class="tip">{{ modelHelp.desc }}</div>
            <div class="tip faint">{{ modelHelp.note }}</div>

            <div v-if="params.model === SEARCH_MODEL.DUAL" class="field" style="margin-top: 10px">
              <label>λ（双权优化的扩散项权重）</label>
              <input class="input input-num" type="number" step="0.1" min="0" max="10"
                :value="params.lambda"
                @change="params.lambda = Number($event.target.value) || 0; saveParams()" />
              <div class="tip">λ = 0 时严格退化为概率权重模型；越大越偏好"差分稀疏"的特征。</div>
            </div>

            <!-- 搜索策略 -->
            <div class="sub-title">搜索策略</div>
            <div class="field">
              <label>策略</label>
              <select class="select" :value="params.searchDepth"
                @change="params.searchDepth = $event.target.value; saveParams()">
                <option value="greedy">贪心（最快，易陷局部最优）</option>
                <option value="beam">束搜索（推荐，默认）</option>
                <option value="exact">精确搜索（最慢，小轮数可用）</option>
              </select>
            </div>
            <div class="two">
              <div class="field">
                <label>束宽</label>
                <input class="input input-num" type="number" min="1" max="64"
                  :value="params.beamWidth"
                  @change="clampAndSave('beamWidth', $event.target.value, 1, 64)" />
              </div>
              <div class="field">
                <label>候选上限</label>
                <input class="input input-num" type="number" min="1" max="512"
                  :value="params.maxCandidates"
                  @change="clampAndSave('maxCandidates', $event.target.value, 1, 512)" />
              </div>
            </div>
            <div class="two">
              <div class="field">
                <label>分支上限</label>
                <input class="input input-num" type="number" min="0" max="64"
                  :value="params.branchLimit"
                  @change="clampAndSave('branchLimit', $event.target.value, 0, 64)" />
              </div>
              <div class="field">
                <label>时间预算 (ms)</label>
                <input class="input input-num" type="number" min="200" max="60000" step="500"
                  :value="params.timeBudgetMs"
                  @change="clampAndSave('timeBudgetMs', $event.target.value, 200, 60000)" />
              </div>
            </div>
            <div class="tip">
              束宽越大结果越优、越慢；候选上限决定每轮保留多少条分支。
              <b>分支上限 0 = 自动</b> —— 默认参数下概率映射模型会与权重模型给出同一条特征，
              想观察模型差异请把它设为 8。
            </div>

            <!-- 权重阈值 -->
            <div class="sub-title">目标与终止条件</div>
            <div class="field">
              <label>权重阈值 −log₂p</label>
              <input class="input input-num" type="number" min="0" max="200"
                :value="params.weightThreshold"
                @change="clampAndSave('weightThreshold', $event.target.value, 0, 200)" />
              <div class="tip">0 = 不限。全轮扫描时一旦累计权重超过此值就停止加轮。</div>
            </div>
            <div class="field">
              <label>起始差分 / 掩码（留空 = 自动遍历单比特起点）</label>
              <input class="input mono" placeholder="0x2,0,0,0 或 00000002"
                :class="{ bad: !initDiffsInfo.ok }"
                :value="params.initDiffs"
                @change="setText('initDiffs', $event.target.value)" />
              <div class="tip" :class="{ badtext: !initDiffsInfo.ok }">
                <template v-if="initDiffsInfo.ok">✓ {{ initDiffsInfo.text }}</template>
                <template v-else>✗ {{ initDiffsInfo.text }}</template>
              </div>
              <div class="tip">
                四个字 = 一个 128 bit 状态。写法两种都认：<b>逗号分隔</b>（<span class="mono">0x2,0,0,0</span>）
                或 <b>一个 8 位十六进制字</b>（<span class="mono">00000002</span>，按十六进制解读）。
                多个起点用分号隔开。不同起点会给出不同结果 —— 值得亲自试。
              </div>
            </div>

            <!-- 复杂度辅助变量 -->
            <div class="sub-title">辅助变量（影响复杂度与建模统计）</div>
            <div class="two">
              <div class="field">
                <label>信噪比 SNR</label>
                <input class="input input-num" type="number" min="0.1" max="64" step="0.5"
                  :value="params.snr"
                  @change="params.snr = Number($event.target.value) || 2; saveParams()" />
              </div>
              <div class="field">
                <label>密钥猜测轮数</label>
                <input class="input input-num" type="number" min="0" max="32"
                  :value="params.guessRounds"
                  @change="clampAndSave('guessRounds', $event.target.value, 0, 32)" />
              </div>
            </div>
            <div class="field">
              <label>额外辅助变量个数</label>
              <input class="input input-num" type="number" min="0" max="100000"
                :value="params.auxVars"
                @change="clampAndSave('auxVars', $event.target.value, 0, 100000)" />
              <div class="tip">
                数据复杂度 ≈ SNR / p（Matsui 定理）；猜测轮数决定时间复杂度里的 2^bits 因子。
                这两项直接进「变量数 / 子句数」的建模统计。
              </div>
            </div>
          </div>
        </div>

        <!-- 建模统计 -->
        <div v-if="md" class="card">
          <div class="card-head">
            <h2>建模规模</h2>
            <span class="hint">按当前结构遍历计数</span>
          </div>
          <div class="card-body tight">
            <div class="kv">
              <dt>布尔变量</dt>
              <dd class="mono">{{ fmtInt(md.variables.total) }}</dd>
              <dt>约束子句</dt>
              <dd class="mono">{{ fmtInt(md.clauses.total) }}</dd>
              <dt>子句/变量</dt>
              <dd class="mono">{{ md.ratio.toFixed(3) }}</dd>
              <dt>结构类型</dt>
              <dd>{{ md.structure }}</dd>
            </div>
            <div class="alert alert-info small" style="margin-top: 10px">
              {{ modelGrade.text }}
            </div>
            <details class="details">
              <summary>变量与子句的计数明细</summary>
              <ul class="formula-list">
                <li v-for="(f, i) in md.formula.variables" :key="'v' + i" class="mono small">{{ f }}</li>
              </ul>
              <ul class="formula-list">
                <li v-for="(f, i) in md.formula.clauses" :key="'c' + i" class="mono small">{{ f }}</li>
              </ul>
            </details>
          </div>
        </div>
      </aside>

      <!-- ---------------------------------------------------------- 结果区 -->
      <section class="results">
        <!-- 运行条 -->
        <div class="card runbar">
          <div class="card-body tight">
            <div class="row-wrap">
              <button class="btn btn-primary" :disabled="!canRun" @click="doRun">
                {{ running ? '运行中…' : '▶ 运行分析' }}
              </button>
              <button class="btn" :disabled="!canRun || scanning" @click="doScan">
                {{ scanning ? '扫描中…' : '全轮扫描' }}
              </button>
              <label class="inline-num">
                步长
                <input v-model.number="scanStep" class="input input-num" type="number" min="1" max="8" />
              </label>
              <span class="divider"></span>
              <button class="btn" :disabled="!canRun || !result" @click="doEmpirical">
                {{ empiricalRunning ? '抽样中…' : '抽样验证命中率' }}
              </button>
              <label class="inline-num">
                样本
                <select v-model.number="sampleCount" class="select" style="width: 110px">
                  <option :value="20000">2 万</option>
                  <option :value="100000">10 万</option>
                  <option :value="200000">20 万</option>
                  <option :value="500000">50 万</option>
                </select>
              </label>
            </div>

            <div v-if="progress.label" class="prog-row">
              <div class="progress" :class="{ indet: running && !progress.value }">
                <i :style="{ width: Math.max(2, progress.value) + '%' }"></i>
              </div>
              <span class="prog-label">
                <b>{{ progress.phase }}</b>
                {{ progress.label }}
                <template v-if="progress.value">· {{ progress.value }}%</template>
              </span>
            </div>

            <div v-if="pendingSolve" class="alert alert-warn small" style="margin-top: 10px">
              第 <b>{{ pendingSolve.from }}–{{ pendingSolve.to }}</b> 轮<b>还未求解</b>
              （后端逐轮递增，越往后越慢）。
              <button
                class="btn btn-sm" style="margin-left: 8px"
                :disabled="status === 'running'"
                @click="continueSolving"
              >继续求解剩余轮次</button>
              <span class="hint" style="margin-left: 6px">会让后端真的跑，可能要几分钟</span>
            </div>

            <div v-if="status === 'error'" class="alert alert-err small" style="margin-top: 10px">
              <b>运行失败：</b>{{ lastError || '原因见上方日志面板的最后几条。' }}
              <div v-if="!lastError" style="margin-top: 4px">
                常见原因：结构不连通、区间为空、结构中缺少 S 盒。
              </div>
            </div>
          </div>
        </div>

        <!-- 指标卡 -->
        <div v-if="m" class="metrics-grid">
          <MetricCard
            label="时间复杂度" :value="timeComplexityText"
            sub="猜测比特 × 数据量" color="var(--accent)"
            hint="攻击所需的总运算量：2^(密钥猜测比特) × 数据复杂度。"
          />
          <MetricCard
            label="运行时间" :value="fmtMs(m.elapsedMs)"
            :sub="timingNote"
            :color="m.budgetHit ? 'var(--warn)' : 'var(--ok)'"
            hint="从点击到拿到结果的实际耗时（含读取后端已有记录的时间）。"
          />
          <MetricCard
            label="运行轮数" :value="m.rounds" unit="轮"
            :sub="`第 ${m.startRound} ~ ${m.endRound} 轮`"
            hint="实际参与分析的轮数区间。"
          />
          <MetricCard
            label="命中率" :value="hitRateText" :sub="hitRateSub"
            :color="empirical?.feasible ? 'var(--ok)' : 'var(--violet)'"
            hint="单轮走在预测差分/掩码上的概率。默认是理论值 2^(−平均权重)；点「抽样验证」可用真实加密测出经验值。"
          />
          <MetricCard
            label="变量数" :value="fmtInt(md.variables.total)"
            :sub="`状态 ${fmtInt(md.variables.state)} · 边界 ${fmtInt(md.variables.boundary)}`"
            hint="把本次搜索建模成约束问题后的布尔变量总数。"
          />
          <MetricCard
            label="子句数" :value="fmtInt(md.clauses.total)"
            :sub="`比例 ${md.ratio.toFixed(3)} 子句/变量`"
            hint="约束条件总数。太少说明约束弱（搜索空间大），太多说明求解代价高。"
          />
          <MetricCard
            label="活跃 S 盒" :value="m.activeSboxes" unit="个"
            :sub="`平均 ${m.activePerRound.toFixed(2)} 个/轮`"
            hint="整条路径上被激活的 S 盒总数。它决定密钥恢复阶段能过滤多少比特。"
          />
          <MetricCard
            label="数据复杂度" :value="fmtBig(m.dataComplexity)" unit="对"
            :sub="`SNR=${params.snr} · ${probText}`"
            hint="差分 ≈ SNR/p；线性 ≈ SNR/corr²（Matsui 定理）。"
          />
        </div>

        <div v-else class="card">
          <div class="card-body">
            <div class="empty">
              还没有结果。左侧调好参数后点 <b>▶ 运行分析</b>。<br />
              <span class="faint small">
                第一次用？建议先点「全轮扫描」看权重随轮数怎么增长 —— 这是理解差分分析最快的方式。
              </span>
            </div>
          </div>
        </div>

        <!-- 搜索过程可视化 -->
        <div class="card">
          <div class="card-head">
            <h2>搜索过程 · 逐轮收敛</h2>
            <div class="row-wrap">
              <span class="hint">累计 −log₂p 随轮数增长（虚线 = 累计活跃 S 盒）</span>
            </div>
          </div>
          <div class="card-body">
            <LineChart
              :points="curvePoints"
              :second="curveSecond"
              :second-label="'累计活跃 S 盒'"
              :main-label="'累计权重 −log₂p'"
              x-label="轮数"
              :marker="replay"
              :threshold="Number(params.weightThreshold) || 0"
              :height="250"
            />

            <div v-if="replayMax > 0" class="replay">
              <button class="btn btn-sm" @click="setReplay(-1)">全部</button>
              <button class="btn btn-sm" @click="replayTo(0)">⏮</button>
              <input
                class="range" type="range" min="-1" :max="replayMax"
                :value="replay" @input="setReplay($event.target.value)"
              />
              <button class="btn btn-sm" @click="replayTo(replayMax)">⏭</button>
              <span class="mono small">
                {{ replay < 0 ? `共 ${curvePoints.length} 轮` : `画到第 ${curvePoints[replay]?.x} 轮` }}
              </span>
            </div>

            <div v-if="m" class="strip-wrap">
              <div class="strip-title">逐轮活跃 S 盒强度</div>
              <div class="strip">
                <div
                  v-for="c in activeStrip" :key="c.round"
                  class="cell"
                  :title="`第 ${c.round} 轮：本轮权重 ${c.roundWeight.toFixed(2)} bit，活跃 S 盒 ${c.active} 个，累计 ${c.cumActive} 个`"
                  @mouseenter="replayTo(c.round - activeStrip[0].round)"
                >
                  <i class="cell-fill" :style="{ opacity: 0.12 + c.intensity * 0.88 }"></i>
                  <span class="cell-n">{{ c.active }}</span>
                  <span class="cell-r">{{ c.round }}</span>
                </div>
              </div>
              <div class="legend-inline">
                <span class="faint small">颜色越深 = 该轮权重越大</span>
                <span class="faint small">上排数字 = 本轮活跃 S 盒个数，下排 = 轮号</span>
              </div>
            </div>
          </div>
        </div>

        <!-- 全轮扫描 -->
        <div v-if="scan.length" class="card">
          <div class="card-head">
            <h2>全轮扫描曲线</h2>
            <span class="hint">{{ scan.length }} 个轮数点 · 与「运行分析」同参数</span>
          </div>
          <div class="card-body">
            <LineChart
              :points="scanPoints"
              :second="scanSecond"
              second-label="活跃 S 盒"
              main-label="累计权重 −log₂p"
              x-label="轮数"
              :threshold="Number(params.weightThreshold) || 0"
              :height="230"
            />
            <div class="table-scroll" style="margin-top: 12px">
              <table class="table">
                <thead>
                  <tr>
                    <th>轮数</th><th class="num">−log₂p</th><th class="num">bit/轮</th>
                    <th class="num">活跃 S 盒</th><th class="num">耗时</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="r in scan" :key="r.rounds">
                    <td>{{ r.rounds }}</td>
                    <td class="num">{{ r.weight.toFixed(2) }}</td>
                    <td class="num">{{ r.bitsPerRound.toFixed(2) }}</td>
                    <td class="num">{{ r.activeSboxes }}</td>
                    <td class="num">{{ r.elapsedMs.toFixed(0) }} ms</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <!-- 逐轮明细 -->
        <div v-if="result?.perRound?.length" class="card">
          <div class="card-head">
            <h2>逐轮明细</h2>
            <span class="hint">每条都是引擎逐步算出来的，不是拟合值</span>
          </div>
          <div class="card-body tight">
            <div class="table-scroll">
              <table class="table">
                <thead>
                  <tr>
                    <th>轮</th>
                    <th class="num">本轮概率</th>
                    <th class="num">本轮权重</th>
                    <th class="num">累计 −log₂p</th>
                    <th class="num">活跃 S 盒</th>
                    <th class="num">累计</th>
                    <th v-if="hasState">输出状态</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="r in result.perRound" :key="r.round">
                    <td>{{ r.round }}</td>
                    <td class="num">{{ Number.isFinite(r.prob) ? fmtProb(r.prob) : '—' }}</td>
                    <td class="num">{{ (r.roundWeight ?? 0).toFixed(2) }}</td>
                    <td class="num"><b>{{ Number.isFinite(r.weight) ? r.weight.toFixed(2) : '—' }}</b></td>
                    <td class="num">{{ r.activeSboxes ?? 0 }}</td>
                    <td class="num">{{ r.cumActive ?? 0 }}</td>
                    <td v-if="hasState" class="mono small">
                      {{ (r.state || []).map((v) => (v >>> 0).toString(16).padStart(8, '0')).join(' ') || '—' }}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <!-- 抽样验证 -->
        <div v-if="empirical" class="card">
          <div class="card-head">
            <h2>抽样验证（真实加密）</h2>
            <span class="tag" :class="{
              'tag-ok': empirical.level === 'good',
              'tag-warn': empirical.level === 'weak' || empirical.level === 'low' || empirical.level === 'high',
              'tag-err': empirical.level === 'bad',
            }">{{ empirical.verdict ? '已给出判定' : '不可行' }}</span>
          </div>
          <div class="card-body tight">
            <div v-if="empirical.feasible" class="kv">
              <dt>样本对数</dt><dd class="mono">{{ fmtInt(empirical.samples) }}</dd>
              <dt>实测命中</dt><dd class="mono">{{ empirical.hits }} 次</dd>
              <dt>实测命中率</dt><dd class="mono">{{ (empirical.measured * 100).toFixed(5) }}%</dd>
              <dt>理论命中率</dt><dd class="mono">{{ (empirical.expected * 100).toFixed(5) }}%</dd>
              <dt>理论期望命中数</dt><dd class="mono">λ = {{ empirical.lambda.toFixed(2) }}</dd>
              <dt>耗时</dt><dd class="mono">{{ fmtMs(empirical.elapsedMs) }}</dd>
              <dt>输入差分</dt><dd class="mono small">{{ empirical.deltaIn.join(' ') }}</dd>
              <dt>输出差分</dt><dd class="mono small">{{ empirical.deltaOut.join(' ') }}</dd>
            </div>
            <div class="alert small" :class="empirical.level === 'good' ? 'alert-ok' : 'alert-warn'">
              {{ empirical.verdict || empirical.reason }}
            </div>
            <p class="faint small" style="margin: 8px 0 0">
              抽样用的是 <b>真实 SM4 加密</b>（随机密钥 + 随机明文对），
              统计量与理论值的比对是独立的正确性校验 —— 引擎算错了，这里就对不上。
            </p>
          </div>
        </div>

        <!--
          中文解析：说明性内容，默认收起。
          并且**只在出了结果之后才出现** —— 没有结果时"解析"无从谈起，
          空着一块只会让页面看起来坏了。
        -->
        <FoldPanel
          v-if="m && (charExplain.length || secExplain.length || charDetail.length)"
          title="中文解析 · 安全性解读 / 逐轮说明"
          :hint="`${kindLabel} · 基于本次搜索结果`"
        >
          <ExplainPanel v-if="charExplain.length" bare :items="charExplain" />
          <ExplainPanel v-if="secExplain.length" bare :items="secExplain" />

          <div v-if="charDetail.length" class="blk-group">
            <div class="sub-title">逐轮中文说明</div>
            <div v-for="(d, i) in charDetail" :key="i" class="blk-sm">
              <h3>{{ d.h }}</h3>
              <p v-html="d.p"></p>
            </div>
          </div>
        </FoldPanel>

        <!-- 日志 -->
        <LogPanel
          :logs="logs"
          :height="280"
          title="搜索过程日志"
          @clear="clearLogs"
        />
      </section>
    </div>
  </div>
</template>

<style scoped>
.head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}

.main-grid {
  display: grid;
  grid-template-columns: 320px minmax(0, 1fr);
  gap: 12px;
  align-items: start;
}

.params {
  display: flex;
  flex-direction: column;
  gap: 12px;
  position: sticky;
  top: calc(var(--nav-h) + 12px);
  max-height: calc(100vh - var(--nav-h) - 44px);
  overflow-y: auto;
  padding-right: 3px;
}

.results {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}

/* ---- 参数控件 ---- */

.two {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

.models {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.tip {
  margin-top: 6px;
  font-size: 11px;
  line-height: 1.65;
  color: var(--text-faint);
}

.tip b {
  color: var(--text-muted);
}

/* 起始差分输入非法时的视觉反馈（红色既是提示也是警告） */
.input.bad {
  border-color: var(--err);
  background: var(--err-soft);
}

.badtext {
  color: var(--err);
}

.details {
  margin-top: 10px;
  font-size: 11.5px;
}

.details summary {
  cursor: pointer;
  color: var(--accent);
}

.formula-list {
  margin: 6px 0 0;
  padding-left: 16px;
  color: var(--text-muted);
}

.formula-list li {
  line-height: 1.7;
}

/* ---- 运行条 ---- */

.runbar {
  border-left: 3px solid var(--accent);
}

.divider {
  width: 1px;
  height: 20px;
  background: var(--border);
  margin: 0 3px;
}

.inline-num {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-muted);
}

.inline-num .input-num {
  width: 66px;
}

.prog-row {
  display: flex;
  align-items: center;
  gap: 11px;
  margin-top: 12px;
}

.prog-row .progress {
  flex: 1;
  margin: 0;
}

.prog-label {
  font-size: 11.5px;
  color: var(--text-muted);
  white-space: nowrap;
}

.prog-label b {
  color: var(--accent);
}

/* ---- 指标 ---- */

.metrics-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
}

/* ---- 回放 ---- */

.replay {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
}

.range {
  flex: 1;
  accent-color: var(--accent);
}

/* ---- 条带 ---- */

.strip-wrap {
  margin-top: 16px;
}

.strip-title {
  font-size: 11.5px;
  color: var(--text-muted);
  margin-bottom: 7px;
}

.strip {
  display: flex;
  gap: 2px;
  overflow-x: auto;
  padding-bottom: 4px;
}

.cell {
  position: relative;
  flex: none;
  width: 26px;
  height: 44px;
  border-radius: 4px;
  border: 1px solid var(--border);
  background: var(--surface-3);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  cursor: crosshair;
  overflow: hidden;
}

.cell-fill {
  position: absolute;
  inset: 0;
  background: var(--accent);
}

.cell-n {
  position: relative;
  font-family: var(--mono);
  font-size: 11px;
  font-weight: 700;
  color: var(--text);
}

.cell-r {
  position: relative;
  font-family: var(--mono);
  font-size: 9px;
  color: var(--text-muted);
}

.cell:hover {
  border-color: var(--accent);
}

.legend-inline {
  display: flex;
  gap: 16px;
  margin-top: 6px;
  flex-wrap: wrap;
}

/* ---- 逐轮中文 ---- */

.blk-group {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px dashed var(--border);
}

.blk-sm {
  padding: 8px 0;
  border-bottom: 1px dashed var(--border);
}

.blk-sm:last-child {
  border-bottom: none;
}

.blk-sm h3 {
  margin: 0 0 4px;
  font-size: 12.5px;
  font-weight: 600;
}

.blk-sm p {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.78;
  color: var(--text-muted);
}

.blk-sm :deep(strong) {
  color: var(--text);
}

@media (max-width: 1180px) {
  .main-grid {
    grid-template-columns: minmax(0, 1fr);
  }
  .params {
    position: static;
    max-height: none;
  }
  .metrics-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
