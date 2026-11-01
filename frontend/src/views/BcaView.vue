<script setup>
/**
 * 后端搜索页 —— 把 WSL 里的 BCA_Light 拉到界面上来。
 *
 * 与另外两个分析页的分工（很重要，别混淆）：
 *   差分分析 / 线性分析 = **浏览器内**的引擎。秒级出结果，适合调参看趋势，
 *                        但轮数一上去就撑不住。
 *   本页               = **服务器端**的 SAT 搜索（BCA_Light + kissat）。
 *                        能推到全轮，代价是耗时从秒变成分钟乃至小时。
 *
 * 三个使用要点：
 *  1. 后端跑在 WSL 里 —— BCA 的 `bca/solver.py` 要用 Linux 专属的
 *     `PR_SET_PDEATHSIG` 防孤儿进程，kissat 也是 ELF 二进制。
 *     所以 Windows 侧起的 Django 打开这页会显示「不可用」，那是预期行为。
 *  2. `auto` 模式是**现场演示的秒出通道**：已有记录覆盖了整段轮数就直接返回，
 *     完全不碰求解器。演示前先把要展示的任务预热跑一遍即可。
 *  3. 搜索是一次同步 HTTP 请求，可能跑很久。页面上的计时器只是让你确认
 *     「它还活着」，真正能兜住它的是下面那个「子进程超时」参数。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'

import { api } from '@/api/client'
import { BCA_QUERY_KEYS } from '@/core/bca-reference.js'

/* ---------------------------------------------------------------- 状态自检 */

const status = ref(null)
const probing = ref(false)
const probeError = ref('')

async function probe(force = false) {
  if (probing.value) return
  probing.value = true
  probeError.value = ''
  try {
    status.value = await api.bcaStatus(force)
  } catch (err) {
    probeError.value = err.data?.error || err.message
    status.value = null
  } finally {
    probing.value = false
  }
}

const caps = computed(() => status.value?.capabilities || null)
const available = computed(() => status.value?.available === true)
const ciphers = computed(() => caps.value?.ciphers || [])
const models = computed(() => caps.value?.models || [])

/* ---------------------------------------------------------------- 参数 */

const form = ref({
  cipher: 'SM4',
  model: 'MAP',
  startRound: 1,
  endRound: 4,
  taskName: 'web',
  mode: 'auto',
  procTimeout: 120,
  solveTimeout: '',
})

const currentCipher = computed(() => ciphers.value.find((c) => c.name === form.value.cipher) || null)
const fullRounds = computed(() => currentCipher.value?.full_rounds ?? null)

/**
 * 攻击类型**由模型推导**，不另设开关 —— 这样不可能选出非法组合。
 * `LIN` 是线性（Matsui）模型，必须配 `attack=linear` 才走 LAT 数据；
 * 其余模型一律差分。（后端 `LINModel` 见到 attack != linear 会直接报错。）
 */
const attack = computed(() => (form.value.model === 'LIN' ? 'linear' : 'differential'))

/**
 * 快捷预设：都是从"能很快看到结果"的角度挑的，方便现场演示时少点几下。
 * 轮数上限会按算法实际总轮数收窄，免得选出一个 BCA 接不住的组合。
 */
const PRESETS = [
  { label: 'SM4 · 1–4 轮', cipher: 'SM4', model: 'MAP', start: 1, end: 4 },
  { label: 'SM4 · 1–6 轮（精确下界对照）', cipher: 'SM4', model: 'MAP', start: 1, end: 6 },
  { label: 'SM4 · 1–8 轮', cipher: 'SM4', model: 'MAP', start: 1, end: 8 },
  { label: 'SM4 · 1–16 轮', cipher: 'SM4', model: 'MAP', start: 1, end: 16 },
  { label: 'AES · 1–3 轮', cipher: 'AES', model: 'MAP', start: 1, end: 3 },
  { label: 'SM4 · MDW 1–4 轮', cipher: 'SM4', model: 'MDW', start: 1, end: 4 },
  { label: 'SM4 · AS 1–4 轮', cipher: 'SM4', model: 'AS', start: 1, end: 4 },
  { label: 'SM4 · LIN 1–4 轮（线性）', cipher: 'SM4', model: 'LIN', start: 1, end: 4 },
]

function applyPreset(p) {
  form.value.cipher = p.cipher
  form.value.model = p.model
  form.value.startRound = p.start
  form.value.endRound = p.end
}

/** 参数是否齐全到可以发出去（不做语义校验，那交给后端，错误信息更权威） */
const canRun = computed(() =>
  available.value
  && form.value.cipher
  && form.value.model
  && form.value.startRound >= 1
  && form.value.endRound >= form.value.startRound,
)

/* ---------------------------------------------------------------- 运行 */

const running = ref(false)
const elapsed = ref(0)
const result = ref(null)
let timer = null

function startTimer() {
  elapsed.value = 0
  const t0 = performance.now()
  timer = setInterval(() => {
    elapsed.value = (performance.now() - t0) / 1000
  }, 200)
}

function stopTimer() {
  if (timer !== null) {
    clearInterval(timer)
    timer = null
  }
}

/* ------------------------------------------------ 运行中的进度（轮次） */

/**
 * 进度是**读出来的**，不是估出来的。
 *
 * BCA 每算完一组 (轮, 概率权重) 就把一行追加进该任务的 results.csv
 * （见 backend/bca_light/bca/record.py 的 Record.write，append 模式）。
 * 所以运行中轮询这个文件，就能拿到"已经落到第几轮"—— 比按耗时估百分比
 * 诚实得多：轮数一上去耗时不是线性增长，估算出来的条会一直骗人。
 *
 * 轮数范围由**前端**自己算（分母）—— 服务端只回"哪些轮已经落盘"，
 * 不在两个地方各写一份轮数解析规则。
 */
const progress = ref(null)
let poller = null

const totalRounds = computed(() => {
  const a = Number(form.value.startRound)
  const b = Number(form.value.endRound)
  return Number.isFinite(a) && Number.isFinite(b) && b >= a ? b - a + 1 : 0
})

/** 只数落在本次请求区间里的轮（同一任务里可能有别的区间的历史记录） */
const doneRounds = computed(() => {
  const a = Number(form.value.startRound)
  const b = Number(form.value.endRound)
  return (progress.value?.finished || []).filter((r) => r >= a && r <= b).length
})

const progressPct = computed(() => (
  totalRounds.value ? Math.round((doneRounds.value / totalRounds.value) * 100) : 0
))

async function pollProgress() {
  try {
    progress.value = await api.bcaProgress({
      task: String(form.value.taskName || '').trim() || 'web',
      cipher: form.value.cipher,
      model: form.value.model,
    })
  } catch {
    // 轮询失败不打扰用户：进度只是锦上添花，POST 那边的结果才是权威
  }
}

function startPolling() {
  progress.value = null
  pollProgress()
  poller = setInterval(pollProgress, 2000)
}

function stopPolling() {
  if (poller !== null) {
    clearInterval(poller)
    poller = null
  }
}

onUnmounted(() => {
  stopTimer()
  stopPolling()
})

function buildPayload() {
  const p = {
    cipher: form.value.cipher,
    model: form.value.model,
    attack: attack.value,
    rounds: [Number(form.value.startRound), Number(form.value.endRound)],
    task: String(form.value.taskName || '').trim() || 'web',
    mode: form.value.mode,
  }
  // 空字符串 = 不传这个字段。传 null 会被后端 int() 成 0，语义就变了。
  if (form.value.procTimeout !== '' && form.value.procTimeout !== null) {
    p.timeout = Number(form.value.procTimeout)
  }
  if (form.value.solveTimeout !== '' && form.value.solveTimeout !== null) {
    p.solve_timeout = Number(form.value.solveTimeout)
  }
  return p
}

async function run() {
  if (!canRun.value || running.value) return
  running.value = true
  result.value = null
  startTimer()
  startPolling()
  try {
    result.value = await api.bcaRun(buildPayload())
  } catch (err) {
    // 非 2xx：400 的 body 里带的是"请求参数错"的说明，比 HTTP 状态码有用得多
    result.value = (err.data && typeof err.data === 'object')
      ? err.data
      : { ok: false, reason: 'http', error: `${err.message}` }
  } finally {
    stopTimer()
    stopPolling()
    running.value = false
  }
}

/* ---------------------------------------------------------------- 结果整理 */

const rows = computed(() => result.value?.records || [])
const summary = computed(() => result.value?.summary || null)
const paths = computed(() => result.value?.paths || [])
const bounds = computed(() => result.value?.bounds || {})

const RESULT_TAG = {
  SATISFIABLE: 'tag-ok',
  UNSATISFIABLE: 'tag',
  UNKNOWN: 'tag-warn',
  TIMEOUT: 'tag-warn',
}

function resultTag(v) {
  return RESULT_TAG[v] || 'tag-warn'
}

function fmtNum(v, digits = 4) {
  if (v === null || v === undefined || v === '') return '—'
  const n = Number(v)
  if (!Number.isFinite(n)) return String(v)
  if (n === 0) return '0'
  if (Math.abs(n) < 1e-4) return n.toExponential(3)
  return String(Number(n.toFixed(digits)))
}

/**
 * 按轮汇总：每一轮「最小的 SAT 概率权重」才是这轮的答案。
 *
 * BCA 的工作方式是从小到大递增试探概率权重，一路 UNSAT 直到某个值 SAT ——
 * 所以 records 里同一轮会有一串 UNSATISFIABLE 加一条 SATISFIABLE。
 * 把这条规律在界面上直接算出来，比让看的人自己去表里数强得多。
 */
const perRound = computed(() => {
  const byRound = new Map()
  for (const r of rows.value) {
    const rd = Number(r.round)
    if (!Number.isFinite(rd)) continue
    const cur = byRound.get(rd) || { round: rd, tried: 0, unsat: 0, best: null, bestTime: null }
    cur.tried += 1
    if (r.result === 'SATISFIABLE') {
      const p = Number(r.prob)
      if (Number.isFinite(p) && (cur.best === null || p < cur.best)) {
        cur.best = p
        cur.bestTime = r.solve_time
      }
    } else if (r.result === 'UNSATISFIABLE') {
      cur.unsat += 1
    }
    byRound.set(rd, cur)
  }
  return [...byRound.values()].sort((a, b) => a.round - b.round)
})

/** summary 的键随模型而变（MAP 给 ProbWeightBound、MDW 给 pBound/qBound、AS 给 ASB、LIN 给线性权重） */
const summaryEntries = computed(() => {
  if (!summary.value || typeof summary.value !== 'object') return []
  return Object.entries(summary.value).map(([k, v]) => [k, fmtValue(v)])
})

/**
 * 当前**结果**是不是线性（不是看表单 —— 表单切到 LIN 但结果还是旧差分时不能错标口径）。
 * 以 summary.attack 为准（LINModel 回填 `attack: "linear"`），task.model 兜底。
 */
const isLinear = computed(() => (
  result.value?.summary?.attack === 'linear' || result.value?.task?.model === 'LIN'
))

function fmtValue(v) {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'boolean') return v ? '是' : '否'
  if (typeof v === 'number') return fmtNum(v)
  if (Array.isArray(v)) return `[${v.map(fmtValue).join(', ')}]`
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

const boundsText = computed(() => (
  Object.keys(bounds.value).length ? JSON.stringify(bounds.value, null, 2) : ''
))

function downloadJSON(payload, name) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}

function exportResult() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const t = result.value?.task || {}
  downloadJSON(result.value, `bca-${t.cipher || 'x'}-${t.model || 'x'}-${stamp}.json`)
}

/** 从链接参数预填表单的提示文案（空串 = 没预填） */
const prefilled = ref('')

/**
 * 结果页的「用 SAT 复核这 N 轮」会带 ?cipher=SM4&model=MAP&start=1&end=5 过来。
 * ★ 键名与构建端共用 BCA_QUERY_KEYS —— 各写一套字符串迟早错位。
 */
function prefillFromUrl() {
  const sp = new URLSearchParams(window.location.search)
  const cipher = sp.get(BCA_QUERY_KEYS.cipher)
  const model = sp.get(BCA_QUERY_KEYS.model)
  const start = Number(sp.get(BCA_QUERY_KEYS.start))
  const end = Number(sp.get(BCA_QUERY_KEYS.end))
  const parts = []
  if (cipher) { form.value.cipher = cipher; parts.push(cipher) }
  if (model) { form.value.model = model; parts.push(model) }
  if (Number.isFinite(start) && start >= 1) { form.value.startRound = start; parts.push(`第 ${start} 起`) }
  if (Number.isFinite(end) && end >= 1) { form.value.endRound = end; parts.push(`到第 ${end} 轮`) }
  if (form.value.endRound < form.value.startRound) form.value.endRound = form.value.startRound
  prefilled.value = parts.length ? parts.join(' · ') : ''
}

onMounted(() => {
  prefillFromUrl()
  probe(false)
})
</script>

<template>
  <div class="page">
    <div class="head">
      <div>
        <h2 class="section-title">
          后端搜索
          <span class="tag tag-violet">BCA_Light · SAT</span>
        </h2>
        <p class="section-desc">
          BCA_Light 把路径搜索编码成 CNF 交给 kissat，是<b>平台的求解后端</b> ——
          分析页、结果页、全轮扫描的数字都从这里来。同任务重跑会<b>从断点继续</b>，
          只补没跑过的轮次。
          <br />
          它给的是<b>精确值</b>：概率权重从 0 往上逐个判定到第一个可满足，该值既可达、又是下界。
          轮数越高越慢 —— 想现场秒出，先在这里跑一遍预热。
        </p>
        <p v-if="prefilled" class="section-desc">
          参数已从链接带入（<code>{{ prefilled }}</code>），确认后直接点「运行搜索」即可复核。
        </p>
      </div>
      <div class="row-wrap">
        <button class="btn btn-sm" :disabled="probing" @click="probe(true)">
          {{ probing ? '自检中…' : '重新自检' }}
        </button>
        <button class="btn btn-sm btn-primary" :disabled="!canRun || running" @click="run">
          {{ running ? '搜索中…' : '运行搜索' }}
        </button>
      </div>
    </div>

    <!-- 后端状态 -->
    <div class="card">
      <div class="card-head">
        <h2>后端状态</h2>
        <span class="hint">走的是和真实搜索完全相同的链路（起一次子进程、调同一个入口）</span>
      </div>
      <div class="card-body tight">
        <div v-if="probeError" class="alert alert-err">
          <strong>自检请求失败：</strong>{{ probeError }}
        </div>

        <div v-else-if="!status" class="empty">正在自检…</div>

        <template v-else>
          <div class="kv">
            <dt>可用性</dt>
            <dd>
              <span class="tag" :class="available ? 'tag-ok' : 'tag-err'">
                {{ available ? '可用' : '不可用' }}
              </span>
              <span v-if="status.reason" class="faint small" style="margin-left: 8px">
                {{ status.reason }}
              </span>
            </dd>
            <dt>运行平台</dt><dd>{{ status.platform }}</dd>
            <dt>BCA 目录</dt><dd>{{ status.bca_dir || '（未配置）' }}</dd>
            <dt>解释器</dt><dd>{{ status.python }}</dd>
            <template v-if="caps">
              <dt>求解器</dt>
              <dd>
                {{ caps.solver.path }}
                <span class="tag" :class="caps.solver.ok ? 'tag-ok' : 'tag-err'" style="margin-left: 6px">
                  {{ caps.solver.ok ? '已就位' : '找不到' }}
                </span>
                <div v-if="caps.solver.resolved && caps.solver.resolved !== caps.solver.path"
                  class="faint small">→ {{ caps.solver.resolved }}</div>
              </dd>
              <dt>算法</dt>
              <dd>
                <span v-for="c in ciphers" :key="c.name" class="tag tag-mono" style="margin-right: 5px">
                  {{ c.name }}
                  <template v-if="c.full_rounds">· {{ c.full_rounds }} 轮</template>
                </span>
                <span v-if="!ciphers.length" class="faint">—</span>
              </dd>
              <dt>搜索模型</dt>
              <dd>
                <span v-for="m in models" :key="m" class="tag tag-mono" style="margin-right: 5px">{{ m }}</span>
              </dd>
            </template>
          </div>

          <div v-if="!available" class="alert alert-warn" style="margin-top: 12px">
            <strong>后端当前跑不了。</strong>{{ status.detail }}
            <div v-if="status.hints?.length" class="small" style="margin-top: 6px">
              <div v-for="(h, i) in status.hints" :key="i">· {{ h }}</div>
            </div>
            <div v-if="status.traceback" class="small" style="margin-top: 8px">
              <details>
                <summary>回溯信息</summary>
                <span class="code" style="margin-top: 6px">{{ status.traceback }}</span>
              </details>
            </div>
          </div>
        </template>
      </div>
    </div>

    <!-- 参数 -->
    <div class="card">
      <div class="card-head">
        <h2>搜索参数</h2>
        <span class="hint">任务名 = 输出目录名，同一个名字重跑会续跑</span>
      </div>
      <div class="card-body">
        <div class="row-wrap" style="margin-bottom: 14px">
          <button v-for="p in PRESETS" :key="p.label" class="btn btn-sm" @click="applyPreset(p)">
            {{ p.label }}
          </button>
        </div>

        <div class="params">
          <div class="field">
            <label>算法</label>
            <select v-model="form.cipher" class="select">
              <option v-for="c in ciphers" :key="c.name" :value="c.name">
                {{ c.name }}<template v-if="c.full_rounds">（共 {{ c.full_rounds }} 轮）</template>
              </option>
              <option v-if="!ciphers.length" :value="form.cipher">{{ form.cipher }}</option>
            </select>
          </div>

          <div class="field">
            <label>搜索模型</label>
            <select v-model="form.model" class="select">
              <option v-for="m in models" :key="m" :value="m">{{ m }}</option>
              <option v-if="!models.length" :value="form.model">{{ form.model }}</option>
            </select>
            <div class="tip">
              MAP = 概率权重；MDW = 概率映射（额外给 pBound / qBound）；AS = 最少活跃 S 盒；
              <b>LIN</b> = 线性（Matsui，自动切到线性数据，给权重下界 + 精确权重）
            </div>
          </div>

          <div class="field">
            <label>任务名</label>
            <input v-model="form.taskName" class="input" placeholder="web" />
            <div class="tip">结果落在 results/&lt;任务名&gt;/ 下</div>
          </div>

          <div class="field">
            <label>起始轮</label>
            <input v-model.number="form.startRound" class="input input-num" type="number" min="1" />
          </div>

          <div class="field">
            <label>结束轮</label>
            <input v-model.number="form.endRound" class="input input-num" type="number" min="1"
              :max="fullRounds || undefined" />
            <div class="tip">
              <template v-if="fullRounds">该算法共 {{ fullRounds }} 轮</template>
              <template v-else>单填一个数按「1 到该轮」解读</template>
            </div>
          </div>

          <div class="field">
            <label>模式</label>
            <div class="segmented">
              <button :class="{ on: form.mode === 'auto' }" @click="form.mode = 'auto'">auto</button>
              <button :class="{ on: form.mode === 'run' }" @click="form.mode = 'run'">run</button>
              <button :class="{ on: form.mode === 'cache' }" @click="form.mode = 'cache'">cache</button>
            </div>
            <div class="tip">
              <template v-if="form.mode === 'auto'">已有记录覆盖整段轮数就秒回，否则真跑（默认）</template>
              <template v-else-if="form.mode === 'run'">总是跑搜索；已记录过的轮次会被跳过</template>
              <template v-else>只读已有产物，完全不碰求解器 —— 演示秒出通道</template>
            </div>
          </div>

          <div class="field">
            <label>子进程超时（秒）</label>
            <input v-model="form.procTimeout" class="input input-num" type="number" min="0" />
            <div class="tip">这一层起进程的护栏。超了就把 BCA 杀掉，已落盘的记录还在。填 0 = 不限</div>
          </div>

          <div class="field">
            <label>单次求解超时（秒）</label>
            <input v-model="form.solveTimeout" class="input input-num" type="number" min="1"
              placeholder="留空 = 不限" />
            <div class="tip">进 BCA 内部，约束**单次** SAT 求解，不是整个过程</div>
          </div>
        </div>

        <div class="alert alert-info small">
          这里有两个超时，名字必须分清楚：<b>子进程超时</b>管的是「这一层起进程等多久」，
          <b>单次求解超时</b>管的是「kissat 解一个 CNF 最多解多久」。混在一起会让你在排查时
          分不清到底是等太久还是算不动。
        </div>
      </div>
    </div>

    <!-- 运行中 -->
    <div v-if="running" class="card">
      <div class="card-body tight">
        <div class="row" style="justify-content: space-between; margin-bottom: 10px">
          <b>搜索进行中…</b>
          <span class="mono">{{ elapsed.toFixed(1) }} s</span>
        </div>
        <div class="row" style="justify-content: space-between; margin-bottom: 6px">
          <span class="small">
            已完成 <b class="mono">{{ doneRounds }} / {{ totalRounds }}</b> 轮
            <span v-if="progress && progress.lastRound != null" class="faint">
              （最新落盘：第 {{ progress.lastRound }} 轮）
            </span>
          </span>
          <span class="faint small">
            <template v-if="progress">已落盘 {{ progress.records }} 条记录</template>
            <template v-else>读取进度中…</template>
          </span>
        </div>
        <div class="progress" :class="{ indet: !doneRounds }">
          <i v-if="doneRounds" :style="{ width: progressPct + '%' }" />
          <i v-else />
        </div>

        <div class="faint small" style="margin-top: 10px">
          低轮数通常几秒出结果；轮数一上去耗时增长很快（8 轮 SM4 就可能要十几分钟）。
          到时间还没回来，就是撞上了上面的子进程超时 —— 那不算失败，重跑会从断点继续。
          <br />
          进度是<b>读</b>出来的：BCA 每算完一轮就往该任务的 results.csv 追加记录，
          页面每 2 秒读一次，所以它在真的动，不是按耗时估的。
        </div>
      </div>
    </div>

    <!-- 结果 -->
    <template v-if="result">
      <div class="card">
        <div class="card-head">
          <h2>
            执行结果
            <span class="tag" :class="result.ok ? 'tag-ok' : 'tag-err'">
              {{ result.ok ? '已执行' : '失败' }}
            </span>
            <span v-if="result.cached" class="tag tag-cyan">缓存秒出</span>
            <span v-else-if="result.mode" class="tag tag-mono">{{ result.mode }}</span>
          </h2>
          <div class="row-wrap">
            <span v-if="result.wall != null" class="faint small">服务端 {{ fmtNum(result.wall, 2) }} s</span>
            <span v-if="result.elapsed != null" class="faint small">BCA {{ fmtNum(result.elapsed, 2) }} s</span>
            <button class="btn btn-sm" @click="exportResult">导出 JSON</button>
          </div>
        </div>
        <div class="card-body tight">
          <div v-if="result.task" class="kv" style="margin-bottom: 12px">
            <dt>任务</dt><dd>{{ result.task.name }}</dd>
            <dt>算法 / 模型</dt><dd>{{ result.task.cipher }} / {{ result.task.model }}</dd>
            <dt>轮数</dt>
            <dd>{{ (result.task.rounds || []).join(' – ') }}</dd>
            <dt>记录数</dt><dd>{{ rows.length }} 条（含历史断点续跑攒下的）</dd>
            <dt v-if="result.result_root">输出目录</dt>
            <dd v-if="result.result_root">{{ result.result_root }}</dd>
          </div>

          <div v-if="!result.ok" class="alert alert-err">
            <strong>{{ result.error || '执行失败' }}</strong>
            <div v-if="result.reason" class="small" style="margin-top: 4px">
              reason = <span class="mono">{{ result.reason }}</span>
            </div>
            <div v-if="result.hints?.length" class="small" style="margin-top: 6px">
              <div v-for="(h, i) in result.hints" :key="i">· {{ h }}</div>
            </div>
            <details v-if="result.traceback" style="margin-top: 8px">
              <summary class="small">回溯信息</summary>
              <span class="code" style="margin-top: 6px">{{ result.traceback }}</span>
            </details>
          </div>

          <div v-if="result.partial" class="alert alert-warn" style="margin-top: 10px">
            超时前已经产出 {{ (result.partial.records || []).length }} 条记录，未丢失。
            用 <span class="mono">cache</span> 模式可以立刻把它们读出来。
          </div>

          <div v-if="result.stdout_tail" style="margin-top: 10px">
            <details>
              <summary class="small">BCA 自己的输出（末尾片段）</summary>
              <span class="code" style="margin-top: 6px">{{ result.stdout_tail }}</span>
            </details>
          </div>
        </div>
      </div>

      <!-- 按轮汇总 -->
      <div v-if="perRound.length" class="card">
        <div class="card-head">
          <h2>按轮汇总</h2>
          <span class="hint">
            每轮最小的 SAT 概率权重 = <b>全空间精确下界</b> —— 从 0 往上递增试探，第一个 SAT 就是它
          </span>
        </div>
        <div class="card-body tight">
          <div class="table-scroll">
            <table class="table">
              <thead>
                <tr>
                  <th>轮</th>
                  <th class="num">最小 SAT 权重</th>
                  <th class="num">该次求解(s)</th>
                  <th class="num">UNSAT 次数</th>
                  <th class="num">累计记录</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="r in perRound" :key="r.round">
                  <td>{{ r.round }}</td>
                  <td class="num">
                    <b v-if="r.best !== null" class="mono">{{ r.best }}</b>
                    <span v-else class="faint">未收敛</span>
                  </td>
                  <td class="num mono">{{ r.bestTime != null ? fmtNum(r.bestTime, 2) : '—' }}</td>
                  <td class="num">{{ r.unsat }}</td>
                  <td class="num">{{ r.tried }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- 模型返回的摘要 -->
      <div v-if="summaryEntries.length" class="card">
        <div class="card-head">
          <h2>模型摘要</h2>
          <span class="hint">字段随模型而变（MAP / MDW / AS / LIN 各有各的口径）</span>
        </div>
        <div class="card-body tight">
          <!-- 线性口径必须钉在数字旁边：两个权重含义不同，混看就会把下界当最优值 -->
          <div v-if="isLinear" class="tip lin-note">
            <b>线性口径</b>：<code>LinearWeightBound</code> = 6 × 活跃 S 盒 = <b>严格下界</b>
            （<code>max|LAT| = 16 ⇒ 每活跃盒 6 bit</code>）；<code>LinearWeightExact</code> 是
            <b>一条具体特征</b>的真实权重 <code>Σ(−log₂corr²)</code>，两者相等才标记「(最优)」。
            ⚠️ 精确权重未必全局最优（SAT 只返回任意一条最小活跃解），对外引用请用下界。
          </div>
          <div class="kv">
            <template v-for="[k, v] in summaryEntries" :key="k">
              <dt class="mono small">{{ k }}</dt>
              <dd>{{ v }}</dd>
            </template>
          </div>
        </div>
      </div>

      <!-- 原始记录 -->
      <div v-if="rows.length" class="card">
        <div class="card-head">
          <h2>求解记录</h2>
          <span class="hint">results.csv 原文，含断点续跑之前跑出来的行</span>
        </div>
        <div class="card-body tight">
          <div class="table-scroll">
            <table class="table">
              <thead>
                <tr>
                  <th>轮</th>
                  <th class="num">概率权重</th>
                  <th>结果</th>
                  <th class="num">求解(s)</th>
                  <th class="num">CNF(s)</th>
                  <th class="num">变量</th>
                  <th class="num">子句</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(r, i) in rows" :key="i">
                  <td>{{ r.round }}</td>
                  <td class="num mono">{{ r.prob }}</td>
                  <td><span class="tag" :class="resultTag(r.result)">{{ r.result }}</span></td>
                  <td class="num mono">{{ fmtNum(r.solve_time, 2) }}</td>
                  <td class="num mono">{{ fmtNum(r.cnf_time, 2) }}</td>
                  <td class="num mono">{{ r.var_count ?? '—' }}</td>
                  <td class="num mono">{{ r.clause_count ?? '—' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- 路径明文 -->
      <div v-if="paths.length" class="card">
        <div class="card-head">
          <h2>差分路径明文</h2>
          <span class="hint">按（轮数, 概率）降序，高轮数的最有展示价值</span>
        </div>
        <div class="card-body tight">
          <details v-for="p in paths" :key="p.file" style="margin-bottom: 10px">
            <summary class="small mono">
              {{ p.file }}
              <span v-if="p.truncated" class="faint">（已截断）</span>
            </summary>
            <span class="code" style="margin-top: 6px">{{ p.content }}</span>
          </details>
        </div>
      </div>

      <!-- 上下界 -->
      <div v-if="boundsText" class="card">
        <div class="card-head">
          <h2>变量上下界</h2>
          <span class="hint">MILP 收紧后的每格界</span>
        </div>
        <div class="card-body tight">
          <details>
            <summary class="small">展开 bounds.json</summary>
            <span class="code" style="margin-top: 6px">{{ boundsText }}</span>
          </details>
        </div>
      </div>

      <div v-if="result.ok && !rows.length" class="card">
        <div class="card-body">
          <div class="empty">
            这次没有产出记录。若用的是 <span class="mono">cache</span> 模式，说明该任务还没有跑过产物 ——
            换成 <span class="mono">run</span> 或 <span class="mono">auto</span> 真跑一次。
          </div>
        </div>
      </div>
    </template>
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
  margin-top: 16px;
}

.params {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0 18px;
}

@media (max-width: 1100px) {
  .params {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 720px) {
  .params {
    grid-template-columns: minmax(0, 1fr);
  }
}

/* 线性口径说明：钉在权重数字上方，用 warn 色系（与结果页「上界」徽标同一套语义色） */
.lin-note {
  margin: 0 0 12px;
  padding: 10px 12px;
  border: 1px solid var(--warn-border);
  border-left-width: 3px;
  border-radius: 4px;
  background: var(--warn-soft);
  color: var(--text-muted);
  font-size: 12.5px;
  line-height: 1.75;
}

.lin-note code {
  font-family: var(--mono);
  font-size: 12px;
  color: var(--warn);
}
</style>
