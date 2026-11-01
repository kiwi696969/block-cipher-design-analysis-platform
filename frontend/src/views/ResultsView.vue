<script setup>
/**
 * 结果与指标页。
 *
 * 与「差分/线性分析页」的分工：
 *   分析页 = 边调参边跑，看过程；
 *   本页   = 把一次结果完整摊开，做**横向比较**和归档。
 *
 * 这里最有用的一块是「三种搜索模型对比」——它用同一套参数分别跑三次，
 * 把差异摆在桌上。这比在参数面板里来回切换要直观得多，
 * 也顺便证明了「模型只影响挑候选的目标函数，不影响概率怎么算」。
 */
import { computed, ref } from 'vue'
import { href } from '@/pages.js'

import { MODE } from '@/core/analysis.js'
import { bcaCheckQuery } from '@/core/bca-reference.js'
import { BCA_ANALYSIS_TASK } from '@/core/bca-solve.js'
import { fmtMs, fmtInt, fmtState, stateDigits } from '@/core/explain.js'
import { modelVerdict } from '@/core/model.js'
import {
  result, searchOptions,
  characteristicExplain, securityExplain, empirical,
  exportProject, downloadJSON, templateId, graph, log, mode,
  compareSnaps, addResultToCompare, dropCompare, clearCompare,
} from '@/stores/platform.js'
import {
  compareRows as buildCompareRows, comparability, curveOf, titleOf,
  structuralDiffSummary, COMPARE_MAX,
} from '@/core/compare.js'

import MetricCard from '@/components/MetricCard.vue'
import ExplainPanel from '@/components/ExplainPanel.vue'
import FoldPanel from '@/components/FoldPanel.vue'
import CompareChart from '@/components/CompareChart.vue'

/* ---------------------------------------------------------------- 指标 */

const m = computed(() => result.value?.metrics || null)
const md = computed(() => result.value?.model || null)
const grade = computed(() => (md.value ? modelVerdict(md.value) : null))
const char = computed(() => result.value?.char || null)

/**
 * **结果自己的**模式 —— 徽标与中文解析的口径必须跟着结果走，不能跟着当前页走。
 *
 * 结果在整站内共享，换页不会重算：在差分页跑完再走导航去「线性分析」，
 * store 的 `mode` 变成 linear，而 `result` 还是那份差分结果。
 * 从前这里读的是 `mode.value`，于是徽标显示「线性」、解析也说「线性」，
 * 下面的数字却全是差分算出来的 —— 界面在替结果说谎。
 */
const resultMode = computed(() => result.value?.char?.mode || result.value?.mode || mode.value)
const isLinearResult = computed(() => resultMode.value === MODE.LINEAR)

const SUP = { 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹' }
const sup = (n) => String(n).split('').map((c) => (c === '-' ? '⁻' : SUP[c] || c)).join('')

/**
 * 状态字渲染。
 *
 * ⚠️ 后端路径明细里的字可能**超过 32bit**（AES 的 128bit 状态按 4×32bit 存放时
 * 不会，但 `parsePathDetail` 对超过安全整数范围的字会保留十六进制字符串）。
 * 直接 `(v >>> 0)` 会把它变成 0 —— 那是最难发现的一类错：页面有数字，但是假的。
 */
function fmtStateCell(st) {
  if (!Array.isArray(st) || !st.length) return '—'
  return st.map((v) => (typeof v === 'number'
    ? (v >>> 0).toString(16).padStart(8, '0')
    : String(v).replace(/^0x/i, '').padStart(8, '0'))).join(' ')
}

const metricsList = computed(() => {
  if (!m.value) return []
  const e = empirical.value
  const be = result.value?.backend || null
  const pending = be?.pendingRounds?.length ? be.pendingRounds : []
  const known = m.value.weight != null
  /* 后端不提供的口径一律显示「—」，不拿前端引擎补一份 —— 同一张卡片里
     一半数字来自后端、一半来自前端，是最难解释的那种错。 */
  const NA = (sub) => ({ value: '—', sub, hint: '后端 BCA 精确求解通道暂不提供该口径。' })

  return [
    { label: '累计权重 −log₂p', value: known ? m.value.weight.toFixed(2) : '—', unit: 'bit',
      badge: pending.length ? '部分求解' : '精确值',
      sub: pending.length
        ? `已解到第 ${be.solvedThrough} 轮；第 ${pending[0]}–${pending[pending.length - 1]} 轮还未求解`
        : (known
          ? `存在概率 2${sup(-Math.round(m.value.weight))} 的特征（全空间最优）`
          : '后端尚未求解'),
      hint: '后端 BCA 用 kissat 在**全空间**上做 SAT：概率权重从 0 往上判定，'
        + '第一个可满足的值就是最小权重 —— 它既可达、又是下界，即真值。'
        + '这与「束搜索给出的上界」是两种量，不要混着讲。' },
    { label: '平均每轮权重',
      value: m.value.bitsPerRound != null ? m.value.bitsPerRound.toFixed(2) : '—',
      unit: 'bit/轮',
      sub: `权重 ÷ 已解 ${m.value.rounds} 轮`,
      hint: '衡量每加一轮泄漏多少信息。这个值接近 S 盒的固有下界时，说明扩散已经饱和。' },
    { label: '求解耗时', value: fmtMs(m.value.elapsedMs),
      sub: be?.followed ? '沿用进行中的任务（只读）'
        : be?.cached ? '命中已有记录（秒出）' : '本次后端实跑',
      hint: '从提交到拿回结果的墙钟时间。命中已有记录说明这一组轮次之前已经跑过。' },
    { label: '已解轮数', value: m.value.rounds, unit: '轮',
      sub: pending.length
        ? `请求第 ${m.value.startRound}–${m.value.requestedEnd} 轮，还差 ${pending.length} 轮`
        : `第 ${m.value.startRound} ~ ${m.value.endRound} 轮`,
      hint: '后端逐轮递增求解，越往后越慢。未解的轮次在逐轮表里显示「还未求解」。' },
    { label: '命中率', value: e?.feasible
      ? (e.measured * 100).toFixed(4) + '%'
      : (known
        ? `2${sup(-Math.round(m.value.weight / m.value.rounds))}`
        : '—'),
      sub: e?.feasible ? `实测（${fmtInt(e.samples)} 样本）` : '理论单轮命中率',
      hint: '单轮走在预测差分上的比例。抽样验证给出的是真实加密下的经验值。' },
    { label: '变量数', value: fmtInt(char.value?.varCount ?? 0),
      sub: '该轮 CNF 布尔变量数（后端实测）',
      hint: '后端为最后一轮真实建出来的 CNF 规模，与求解器记录里的 var_count 一致。' },
    { label: '子句数', value: fmtInt(char.value?.clauseCount ?? 0),
      sub: '该轮 CNF 子句数（后端实测）',
      hint: '后端为最后一轮真实建出来的 CNF 规模，与求解器记录里的 clause_count 一致。' },
    { label: '活跃 S 盒',
      value: m.value.activeSboxes != null ? m.value.activeSboxes : '—', unit: '个',
      sub: m.value.activePerRound != null
        ? `平均 ${m.value.activePerRound.toFixed(2)} 个/轮`
        : '路径明细未落盘',
      hint: '整条路径上被激活的 S 盒总数，从后端落盘的路径明细（details/path）解析。' },
    { label: '数据复杂度', ...NA('SNR / p（Matsui 定理）') },
    { label: '时间复杂度', ...NA('2^猜测比特 × 数据复杂度') },
    { label: '内存复杂度', ...NA('计数器表规模') },
    { label: '映射权重', ...NA('概率映射模型口径') },
    { label: '扩散权重', ...NA('差分铺开的活跃比特') },
    { label: '双权目标 J', ...NA(`W + λ·D（λ=${result.value?.params?.lambda ?? '—'}）`) },
    { label: '映射规模', ...NA('可达差分个数（量级）') },
  ]
})

/* ---------------------------------------------------------------- 求解来源 */

/**
 * 这张卡片替代了原来的「束搜索上界 vs BCA 精确下界」对照。
 *
 * 为什么不再对照：页面上现在**只有后端这一份数值**，左边那列已经不存在了。
 * 继续摆「≥」和「上界 ≠ 精确下界」会让人以为页面里还藏着一个近似值。
 * 现在要说清的是「这个数是谁算的、算到第几轮、还有哪些轮没算」。
 */
const backendInfo = computed(() => {
  const be = result.value?.backend
  if (!be) return null
  const pending = be.pendingRounds || []
  return {
    task: be.task?.name || BCA_ANALYSIS_TASK,
    cipher: be.task?.cipher || '—',
    model: be.task?.model || '—',
    attack: be.task?.attack || 'differential',
    complete: Boolean(be.complete),
    solvedThrough: be.solvedThrough ?? 0,
    pendingFrom: pending.length ? pending[0] : null,
    pendingTo: pending.length ? pending[pending.length - 1] : null,
    pendingCount: pending.length,
    cached: Boolean(be.cached),
    followed: Boolean(be.followed),
    timedOut: Boolean(be.timedOut),
  }
})

/**
 * 「本次使用的参数」——后端求解时**必须过滤掉只对前端引擎有意义的旋钮**。
 *
 * `beamWidth: 8` / `searchDepth: beam` / `timeBudgetMs: 12000` 这些是束搜索的
 * 调节项，后端 BCA 用 kissat 做全空间 SAT，**一个都不读**。把它们和
 * 「后端精确解」并排展示，会让人以为「后端也是束宽 8 跑出来的」——
 * 与「界面写 0,0,0,1、数字却是全空间最小值」是同一类错（§4.40）。
 */
const ENGINE_ONLY_PARAMS = new Set([
  'searchDepth', 'beamWidth', 'branchLimit', 'maxCandidates', 'timeBudgetMs',
  'lambda', 'snr', 'guessRounds', 'auxVars',
])
const usedParams = computed(() => {
  const all = Object.entries(result.value?.params || {})
  if (!result.value?.backend) return all
  return all.filter(([k]) => !ENGINE_ONLY_PARAMS.has(k))
})

/** 复核链接：直接落在 /bca/ 页的同参数表单里 */const bcaCheckHref = computed(() =>
  href('bca') + bcaCheckQuery(m.value?.endRound ?? 4))

/* ---------------------------------------------------------------- 特征摘要 */

const charSummary = computed(() => {
  const c = char.value
  if (!c) return []
  const rows = [
    ['分析模式', c.mode === MODE.LINEAR ? '线性逼近' : '差分特征'],
    ['轮数区间', `第 ${c.startRound ?? 1} ~ ${c.endRound ?? c.rounds} 轮（跨 ${c.rounds} 轮）`],
    ['累计权重 −log₂p', c.weight != null ? c.weight.toFixed(2) : '—'],
    ['输入差分 / 掩码', fmtState(c.inputState, stateDigits(c))],
    ['输出差分 / 掩码', fmtState(c.outputState, stateDigits(c))],
    ['活跃 S 盒', String(c.activeSboxes ?? '—')],
    ['分支数', c.branchCount != null ? String(c.branchCount) : '—'],
  ]
  return rows
})

/** 逐轮状态演化（SM4 路径有 state；SPN 路径没有） */
const hasState = computed(() =>
  (result.value?.perRound || []).some((r) => Array.isArray(r.state)))

/** 已求解的轮数（逐轮表头要能说清「请求 32 轮、已解 8 轮」） */
const solvedCount = computed(() =>
  (result.value?.perRound || []).filter((r) => !r.pending).length)

/* ---------------------------------------------------------------- 模型对比（已停用） */

/* 这张表原来是「用同一套参数在前端跑三种搜索模型」。现在结果只来自后端 BCA
   的 MAP 精确求解，前端引擎不参与求值 —— 保留一个空壳按钮只会让人以为
   还能用前端算一遍。模板里换成了说明文字，这里不再保留任何计算逻辑。 */

/* ---------------------------------------------------------------- 方案对比 */

/**
 * 「换个 S 盒 / 换条线性层，到底变好还是变差」—— 这个问题靠记数字答不了。
 * 对比栏把最多 3 份结果冻成快照并排放，跨模板、跨算法都保留。
 *
 * ★ 一切以「口径先于数字」为顺序：先给出 `comparability` 的提示
 *   （模式/轮数/束宽/分支/起点是否一致），再摆数字。不这么做的后果和
 *   SM4「5 轮起偏高」那次一模一样 —— 用户看到两组数不一样，
 *   第一反应是「平台算错了」，而不是「口径不同」。
 */
const cmpMsg = ref('')

const cmpRows = computed(() => buildCompareRows(compareSnaps.value))
const cmpNotes = computed(() => comparability(compareSnaps.value))
const cmpSeries = computed(() => compareSnaps.value.map((s, i) => ({
  id: s.id,
  label: `#${i + 1} ${titleOf(s)}`,
  points: curveOf(s),
})))
/** 相邻两份的结构差异（#1→#2、#2→#3）：说清「改了哪一处」 */
const cmpDiffs = computed(() => compareSnaps.value.slice(1).map((s, i) => ({
  from: i,
  to: i + 1,
  text: structuralDiffSummary(compareSnaps.value[i], s),
})))

/** 全部来自后端精确求解？决定卡片底部那段话怎么说（口径不能一套打天下） */
const cmpAllExact = computed(() => compareSnaps.value.length > 0
  && compareSnaps.value.every((s) => s.exact))

function addCompare() {
  const r = addResultToCompare()
  cmpMsg.value = r.action === 'added' ? `已加入第 ${(r.index ?? 0) + 1} 项`
    : r.action === 'replaced' ? '同配置重跑得到不同数值，已覆盖原项（详见日志）'
      : r.action === 'duplicate' ? '这份配置已在对比栏，且数值相同'
        : r.action === 'full' ? `对比栏已满（${COMPARE_MAX} 项），请先移除一项`
          : '还没有结果可加入'
}

function clearAllCompare() {
  clearCompare()
  cmpMsg.value = ''
}

/* ---------------------------------------------------------------- 导出 */

function exportResult() {
  const payload = {
    exportedAt: new Date().toISOString(),
    cipher: graph.value?.meta?.name,
    templateId: templateId.value,
    // 用**结果自己的**模式，不是当前会话模式 —— 导出的报告得跟里面的数字同口径
    mode: resultMode.value,
    params: result.value?.params,
    metrics: m.value,
    model: md.value,
    perRound: result.value?.perRound,
    characteristic: char.value
      ? {
        mode: char.value.mode,
        rounds: char.value.rounds,
        startRound: char.value.startRound,
        endRound: char.value.endRound,
        weight: char.value.weight,
        activeSboxes: char.value.activeSboxes,
        inputState: char.value.inputState,
        outputState: char.value.outputState,
      }
      : null,
    empirical: empirical.value,
    /* 求解来源：谁算的、算到第几轮 —— 导出的报告也要能自己说清口径 */
    backend: result.value?.backend || null,
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  downloadJSON(payload, `result-${templateId.value}-${stamp}.json`)
  log('info', '已导出结果与指标 JSON')
}

function exportProjectFile() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  downloadJSON(exportProject(), `${templateId.value}-${stamp}.json`)
}
</script>

<template>
  <div class="page">
    <div class="head">
      <div>
        <h2 class="section-title">
          结果与指标
          <span v-if="m" class="tag" :class="isLinearResult ? 'tag-violet' : 'tag-accent'">
            {{ isLinearResult ? '线性' : '差分' }}
          </span>
        </h2>
        <p class="section-desc">
          一次分析的完整拆解与横向比较。数字来源：运行时间取 <code>performance.now()</code>、
          命中率来自真实加密抽样、建模规模遍历图结构逐节点计数 —— 没有估算量。
        </p>
      </div>
      <div class="row-wrap">
        <button class="btn btn-sm" :disabled="!result" @click="addCompare">
          加入对比栏（{{ compareSnaps.length }}/{{ COMPARE_MAX }}）
        </button>
        <button class="btn btn-sm" :disabled="!result" @click="exportResult">导出结果 JSON</button>
        <button class="btn btn-sm" @click="exportProjectFile">导出完整工程</button>
        <a :href="href('differential')" class="btn btn-sm btn-primary">去运行分析 →</a>
      </div>
    </div>

    <!-- 空态 -->
    <div v-if="!result" class="card">
      <div class="card-body">
        <div class="empty">
          还没有结果数据。<a :href="href('differential')">去差分分析页</a>
          运行一次即可。
          <div class="faint small" style="margin-top: 8px">
            结果只存在于内存中，刷新页面会丢失 —— 需要留存请点「导出完整工程」。
          </div>
        </div>
      </div>
    </div>

    <template v-else>
      <!-- 指标 -->
      <div class="metrics-grid">
        <MetricCard
          v-for="it in metricsList" :key="it.label"
          :label="it.label" :value="it.value" :unit="it.unit || ''"
          :sub="it.sub" :hint="it.hint" :badge="it.badge || ''"
        />
      </div>

      <!-- 求解来源：数值来自后端 BCA 全空间 SAT，不是浏览器里的近似搜索 -->
      <div v-if="backendInfo" class="card card-check" :class="{ 'is-exact': backendInfo.complete }">
        <div class="card-head">
          <h2>
            求解来源
            <span class="tag" :class="backendInfo.complete ? 'tag-ok' : 'tag-warn'">
              {{ backendInfo.complete ? '全空间精确解' : '部分求解' }}
            </span>
          </h2>
          <span class="hint">
            {{ backendInfo.cipher }} · {{ backendInfo.model }} · 第 1～{{ backendInfo.solvedThrough }} 轮
            · 任务 <code>{{ backendInfo.task }}</code>
          </span>
        </div>
        <div class="card-body">
          <div class="cmp-row">
            <div class="cmp-cell">
              <div class="cmp-k">求解器</div>
              <div class="cmp-v">kissat（SAT）</div>
            </div>
            <div class="cmp-op">·</div>
            <div class="cmp-cell">
              <div class="cmp-k">结果来源</div>
              <div class="cmp-v">
                {{ backendInfo.followed ? '沿用进行中的任务'
                  : backendInfo.cached ? '已有记录（秒出）'
                    : backendInfo.timedOut ? '本次实跑（护栏中止）' : '本次实跑' }}
              </div>
            </div>
            <div class="cmp-op">·</div>
            <div class="cmp-cell">
              <div class="cmp-k">已解 / 请求</div>
              <div class="cmp-v">{{ backendInfo.solvedThrough }} / {{ m.requestedEnd }}</div>
            </div>
          </div>

          <p class="cmp-note">
            概率权重从 0 往上逐个判定，<b>第一个可满足的值就是最小权重</b> ——
            它既可达、又是下界，即真值；全空间不存在比它更轻的特征。
          </p>

          <p v-if="!backendInfo.complete" class="cmp-explain">
            后端还在往后推进：第 <b>{{ backendInfo.pendingFrom }}–{{ backendInfo.pendingTo }}</b> 轮
            <b>还未求解</b>（共 {{ backendInfo.pendingCount }} 轮）。
            逐轮表里这些行显示「还未求解」，页面<b>不会</b>用近似值顶上。
          </p>

          <p v-if="backendInfo.timedOut" class="cmp-explain">
            本次求解在后端子进程护栏处被中止，<b>已落盘的轮次不会丢</b>：
            再点一次「运行分析」会从断点继续，已完成的轮次直接跳过。
          </p>

          <div class="row-wrap">
            <a :href="bcaCheckHref" class="btn btn-sm">去 BCA 页查看原始记录 →</a>
            <a :href="href('tutorial')" class="btn btn-sm">为什么不再用束搜索</a>
          </div>
        </div>
      </div>

      <!-- 特征摘要 -->
      <div class="grid-2">
        <div class="card">
          <div class="card-head">
            <h2>特征摘要</h2>
            <span class="hint">这是本次搜索命中的最优路径</span>
          </div>
          <div class="card-body tight">
            <div class="kv">
              <template v-for="[k, v] in charSummary" :key="k">
                <dt>{{ k }}</dt>
                <dd :class="{ mono: k.includes('差分') || k.includes('权重') }">{{ v }}</dd>
              </template>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-head">
            <h2>本次使用的参数</h2>
            <span class="hint">
              {{ backendInfo ? '后端只用到 模型 / 攻击 / 轮数 —— 束宽与时间预算不参与求解' : '来自唯一装配入口' }}
            </span>
          </div>
          <div class="card-body tight">
            <div class="kv">
              <template v-for="[k, v] in usedParams" :key="k">
                <dt class="mono small">{{ k }}</dt>
                <dd class="mono">{{ v === '' ? '（自动）' : v }}</dd>
              </template>
            </div>
          </div>
        </div>
      </div>

      <!-- 建模规模（前端建模范式） -->
      <div v-if="md" class="card">
        <div class="card-head">
          <h2>建模规模分解</h2>
          <span class="hint">{{ backendInfo ? '前端建模范式 · 不适用于本次后端求解' : md.summary }}</span>
        </div>
        <div class="card-body tight">
          <!-- ⚠️ 后端求解时这里必须让位：`md` 是**前端**那套模型（状态变量/边界变量…），
               而上方指标卡里的变量数/子句数是**后端 CNF 实测**。两套数并排就是
               「同一页两个来源」（§4.37 那类错）—— 实测差得很远（4,417 vs 1,676）。 -->
          <p v-if="backendInfo" class="cmp-note">
            本次结果来自后端 BCA 的 CNF，规模在上方指标卡里（变量
            <b>{{ fmtInt(char?.varCount) }}</b> / 子句 <b>{{ fmtInt(char?.clauseCount) }}</b>，后端实测）。
            下面这套「状态变量 / 边界变量」是<b>前端</b>建模口径，后端不用它，故不展示明细。
          </p>
          <template v-if="!backendInfo">
          <div class="grid-2">
            <div>
              <div class="sub-title">布尔变量 {{ fmtInt(md.variables.total) }}</div>
              <div class="kv">
                <dt>状态变量</dt><dd class="mono">{{ fmtInt(md.variables.state) }}</dd>
                <dt>边界变量</dt><dd class="mono">{{ fmtInt(md.variables.boundary) }}</dd>
                <dt>密钥变量</dt><dd class="mono">{{ fmtInt(md.variables.key) }}</dd>
                <dt>辅助变量</dt><dd class="mono">{{ fmtInt(md.variables.aux) }}</dd>
                <dt>目标变量</dt><dd class="mono">{{ fmtInt(md.variables.objective) }}</dd>
              </div>
            </div>
            <div>
              <div class="sub-title">约束子句 {{ fmtInt(md.clauses.total) }}</div>
              <div class="kv">
                <dt>状态约束</dt><dd class="mono">{{ fmtInt(md.clauses.state) }}</dd>
                <dt>边界约束</dt><dd class="mono">{{ fmtInt(md.clauses.boundary) }}</dd>
                <dt>目标约束</dt><dd class="mono">{{ fmtInt(md.clauses.objective) }}</dd>
                <dt>子句/变量</dt><dd class="mono">{{ md.ratio.toFixed(3) }}</dd>
              </div>
            </div>
          </div>
          <div v-if="grade" class="alert alert-info small" style="margin-top: 12px">
            {{ grade.text }}
          </div>

          <details class="details">
            <summary>逐组件计数明细（{{ md.perNode.length }} 个组件贡献了变量或子句）</summary>
            <div class="table-scroll" style="margin-top: 10px">
              <table class="table">
                <thead>
                  <tr><th>组件</th><th class="num">变量</th><th class="num">子句</th><th>计数依据</th></tr>
                </thead>
                <tbody>
                  <tr v-for="n in md.perNode" :key="n.id">
                    <td>{{ n.label }}</td>
                    <td class="num">{{ fmtInt(n.vars) }}</td>
                    <td class="num">{{ fmtInt(n.clauses) }}</td>
                    <td class="small faint">{{ n.note }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </details>
          </template>
        </div>
      </div>

      <!-- 搜索模型对比：已停用（前端引擎不再参与求解） -->
      <div class="card">
        <div class="card-head">
          <h2>搜索模型对比</h2>
          <span class="tag tag-warn">已停用</span>
        </div>
        <div class="card-body">
          <div class="faint small">
            这张表原来是「用同一套参数在前端跑三种模型、把差异摆出来」。
            现在结果只来自后端 BCA 的 <b>MAP（Matsui 概率权重）</b>精确求解 ——
            后端另外两个模型（MDW 是 dual Matsui 变体；AS 只搜活跃 S 盒界、
            不写概率编码）与本页口径<b>不可比</b>，摆在一起只会误导。<br />
            想比较「换 S 盒 / 换结构」的影响，用下面的<b>方案对比</b>：
            它把多份结果冻成快照并排，并会先校验口径是否一致。
          </div>
        </div>
      </div>

      <!-- 逐轮 -->
      <div v-if="result.perRound?.length" class="card">
        <div class="card-head">
          <h2>逐轮完整数据</h2>
          <span class="hint">{{ solvedCount }} / {{ result.perRound.length }} 轮已求解</span>
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
                  <th class="num">累计活跃</th>
                  <th v-if="hasState">输出状态<template v-if="stateWords">（{{ stateWords }}×32 bit）</template></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="r in result.perRound" :key="r.round">
                  <td>{{ r.round }}</td>

                  <!-- 后端还没解到这一轮：明确写「还未求解」，不留空、不拿近似值顶上 -->
                  <template v-if="r.pending">
                    <td colspan="5" class="small faint">
                      还未求解 —— 后端仍在往这一轮推进（全空间 SAT 逐轮递增，越往后越慢）
                    </td>
                  </template>

                  <template v-else>
                    <td class="num mono">2{{ sup(-Math.round(r.roundWeight ?? 0)) }}</td>
                    <td class="num">{{ (r.roundWeight ?? 0).toFixed(2) }}</td>
                    <td class="num"><b>{{ Number.isFinite(r.weight) ? r.weight.toFixed(2) : '—' }}</b></td>
                    <td class="num">{{ r.activeSboxes ?? '—' }}</td>
                    <td class="num">{{ r.cumActive ?? '—' }}</td>
                  </template>

                  <td v-if="hasState" class="mono small">{{ fmtStateCell(r.state) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- 抽样 -->
      <div v-if="empirical" class="card">
        <div class="card-head"><h2>抽样验证</h2></div>
        <div class="card-body tight">
          <div v-if="empirical.feasible" class="kv">
            <dt>样本对数</dt><dd class="mono">{{ fmtInt(empirical.samples) }}</dd>
            <dt>命中次数</dt><dd class="mono">{{ empirical.hits }}</dd>
            <dt>实测 / 理论</dt>
            <dd class="mono">
              {{ (empirical.measured * 100).toFixed(5) }}% / {{ (empirical.expected * 100).toFixed(5) }}%
            </dd>
            <dt>理论期望 λ</dt><dd class="mono">{{ empirical.lambda.toFixed(2) }}</dd>
          </div>
          <div class="alert small" :class="empirical.level === 'good' ? 'alert-ok' : 'alert-warn'">
            {{ empirical.verdict || empirical.reason }}
          </div>
        </div>
      </div>

      <!-- 中文解析（说明性内容：默认收起） -->
      <FoldPanel
        v-if="characteristicExplain?.summary?.length || securityExplain.length
          || characteristicExplain?.perRound?.length"
        title="中文解析 · 特征解读 / 安全性 / 逐轮说明"
        :hint="`${isLinearResult ? '线性' : '差分'} · 基于本次结果`"
      >
        <ExplainPanel
          v-if="characteristicExplain?.summary?.length"
          bare :items="characteristicExplain.summary"
        />
        <ExplainPanel v-if="securityExplain.length" bare :items="securityExplain" />
        <ExplainPanel
          v-if="characteristicExplain?.perRound?.length"
          bare :items="characteristicExplain.perRound"
        />
      </FoldPanel>
    </template>

      <!-- 方案对比（跨结果） -->
      <div class="card">
        <div class="card-head">
          <h2>
            方案对比
            <span class="tag tag-mono">{{ compareSnaps.length }}/{{ COMPARE_MAX }}</span>
          </h2>
          <div class="row-wrap">
            <button class="btn btn-sm btn-primary" :disabled="!result" @click="addCompare">
              加入对比栏
            </button>
            <button class="btn btn-sm" :disabled="!compareSnaps.length" @click="clearAllCompare">
              清空
            </button>
          </div>
        </div>
        <div class="card-body tight">
          <p class="cmp-lead">
            把当前结果冻成一份快照，最多 {{ COMPARE_MAX }} 份并排 ——
            换 S 盒、换线性层、加轮数之后再跑一次，就能看出「改了到底有没有用」。
            <span class="faint">
              跨模板、跨算法都保留（SM4 与 AES 并排才是它的主用途），页面刷新也不丢。
            </span>
          </p>

          <div v-if="cmpMsg" class="alert alert-info small" style="margin-bottom: 10px">
            {{ cmpMsg }}
          </div>

          <div v-if="!compareSnaps.length" class="empty" style="padding: 22px 8px">
            对比栏还是空的。点上面的「加入对比栏」存一份，再改结构重跑一次、再加一份。
            <div class="faint small" style="margin-top: 6px">
              每一列都会标出<b>数值来源</b>：后端 BCA 是全空间精确值（真值），
              浏览器束搜索只是上界（本次改造前跑出来的结果属于后者）。
              对比栏先校验「能不能比」（模式 / 轮数 / 来源 / 是否已解到同一轮），再摆数字。
            </div>
          </div>

          <template v-else>
            <div class="cmp-notes">
              <div
                v-for="(n, i) in cmpNotes" :key="i" class="alert small"
                :class="n.level === 'warn' ? 'alert-warn' : n.level === 'ok' ? 'alert-ok' : 'alert-info'"
              >{{ n.text }}</div>
            </div>

            <div class="table-scroll cmp-scroll">
              <table class="table cmp-table">
                <thead>
                  <tr>
                    <th class="rowlab">指标</th>
                    <th v-for="(s, i) in compareSnaps" :key="s.id">
                      <span class="idx">{{ '#' + (i + 1) }}</span> {{ s.structureName }}
                      <button class="cmp-x" title="移除这一项" @click="dropCompare(s.id)">×</button>
                      <span class="faint small block">
                        {{ s.modeLabel }} · 第 {{ s.startRound }}~{{ s.endRound }} 轮
                      </span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="r in cmpRows" :key="r.key">
                    <td class="rowlab">{{ r.label }}</td>
                    <td
                      v-for="(v, i) in r.values" :key="i"
                      :class="{ num: r.kind === 'num', mono: r.kind === 'mono' }"
                    >
                      {{ v }}
                      <span
                        v-if="r.deltas && r.deltas[i]" class="delta"
                        :class="r.deltas[i].startsWith('+') ? 'up' : 'down'"
                      >{{ r.deltas[i] }}</span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p class="cmp-foot faint small">
              差值相对 <b>#1</b>（基线），#1 自身恒为空。
              <template v-if="cmpAllExact">
                这几份都来自后端全空间 SAT 的<b>精确值</b>（既可达又是下界）——
                差值就是真实差距，可以直接引用。
              </template>
              <template v-else>
                权重变高 = 已知最好的那条特征更难，也就是对该类差分/线性逼近更抗。
                但束搜索给的是<b>上界</b>：「更难」只相对已知特征成立，不是安全证明；
                若某列是精确值，它的高低还受"算到第几轮"影响（见「求解完整性」行）。
              </template>
            </p>

            <div class="sub-title" style="margin-top: 16px">逐轮收敛曲线</div>
            <CompareChart :series="cmpSeries" />
            <p class="cmp-foot faint small">
              横轴是<b>绝对轮次</b>，不是「第几个点」—— 两份快照起始轮不同时，
              按绝对轮次对齐才不会把「第 1 轮」和「第 5 轮」画在同一个刻度上。
            </p>

            <div v-if="cmpDiffs.length" class="cmp-diffs">
              <div class="sub-title">结构差异</div>
              <div v-for="d in cmpDiffs" :key="d.from" class="diff-line">
                <span class="mono">{{ '#' + (d.from + 1) }} → {{ '#' + (d.to + 1) }}</span>
                {{ d.text }}
              </div>
            </div>
          </template>
        </div>
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
  margin-bottom: 18px;
}

.page > * + * {
  margin-top: 12px;
}

.metrics-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
}

.details {
  margin-top: 10px;
  font-size: 11.5px;
}

.details summary {
  cursor: pointer;
  color: var(--accent);
}

.err-text {
  color: var(--err);
}

/* ---- 口径对照卡 ---- */
.card-check {
  border-left: 2px solid var(--warn);
}
.card-check.is-exact {
  border-left-color: var(--ok);
}

.cmp-row {
  display: flex;
  align-items: center;
  gap: 18px;
  flex-wrap: wrap;
}

.cmp-cell {
  min-width: 180px;
}

.cmp-k {
  font-size: 11px;
  color: var(--text-muted);
  margin-bottom: 2px;
}

.cmp-v {
  font-family: var(--mono);
  font-size: 26px;
  line-height: 1.15;
}

.cmp-v.warn {
  color: var(--warn);
}

.cmp-v.ok {
  color: var(--ok);
}

.cmp-op {
  font-family: var(--mono);
  font-size: 20px;
  color: var(--text-faint);
}

.cmp-note {
  margin: 10px 0 0;
  font-size: 12px;
  color: var(--text-muted);
}

.cmp-explain {
  margin: 6px 0 12px;
  font-size: 12px;
  line-height: 1.65;
  color: var(--text-muted);
  max-width: 78ch;
}

/* ---- 方案对比 ---- */
.cmp-lead {
  margin: 0 0 10px;
  font-size: 12px;
  line-height: 1.65;
  color: var(--text-muted);
  max-width: 84ch;
}

.cmp-notes {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 12px;
}

.cmp-table th,
.cmp-table td {
  vertical-align: top;
}

/* 对比表的每一行都要**同时**看到才有意义 —— 全局 .table-scroll 的
   max-height:420px 会把最后几行（搜索参数 / 指纹）裁进内层滚动条里，
   横着比的时候还得在格子里竖着滚一次。这里放开高度。 */
.cmp-scroll {
  max-height: none;
  overflow: visible;
}

.cmp-table .rowlab {
  width: 150px;
  color: var(--text-muted);
  font-weight: 400;
  white-space: nowrap;
}

.cmp-table .idx {
  font-family: var(--mono);
  color: var(--accent);
  margin-right: 2px;
}

.block {
  display: block;
  margin-top: 2px;
}

.cmp-x {
  border: 1px solid var(--border);
  background: var(--surface-2);
  color: var(--text-faint);
  border-radius: 4px;
  width: 18px;
  height: 18px;
  line-height: 1;
  font-size: 13px;
  cursor: pointer;
  padding: 0;
  margin-left: 6px;
  vertical-align: middle;
}

.cmp-x:hover {
  color: var(--err);
  border-color: var(--err-border);
  background: var(--err-soft);
}

.delta {
  font-family: var(--mono);
  font-size: 10.5px;
  margin-left: 4px;
}

.delta.up {
  color: var(--ok);
}

.delta.down {
  color: var(--warn);
}

.cmp-foot {
  margin: 6px 0 0;
  line-height: 1.6;
}

.cmp-diffs {
  margin-top: 14px;
  padding-top: 10px;
  border-top: 1px dashed var(--border);
}

.diff-line {
  font-size: 12px;
  color: var(--text-muted);
  margin-top: 4px;
}

.diff-line .mono {
  color: var(--accent);
  margin-right: 6px;
}

@media (max-width: 1180px) {
  .metrics-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
