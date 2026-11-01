<script setup>
/**
 * 多序列折线图（对比栏用，最多 3 条）。
 *
 * 为什么不复用 LineChart.vue：
 *   那个是「一条主曲线 + 一条次序列」的单结果视图（面积填充、回放 marker、
 *   右轴量纲），对比栏要的是「同一量纲、多条曲线、按绝对轮次对齐」——
 *   目标不同，硬塞进去只会让两边都变难读。
 *
 * ⚠️ 与 LineChart 同一条铁律：**颜色只能写在 CSS 类里**。
 *   SVG 的 presentation attribute（`stroke="var(--x)"`）不做 var() 替换，
 *   浏览器会当非法值回退成初始值 → 曲线全黑、深色模式下直接看不见。
 *
 * ⚠️ x 轴是**绝对轮次**，不是数组下标：两份快照的起始轮可能不同，
 *   按下标画会把「第 1 轮」和「第 5 轮」叠在同一个刻度上。
 */
import { computed, ref } from 'vue'

const props = defineProps({
  /** [{ id, label, points: [{ x, y, active? }] }]，最多 3 条 */
  series: { type: Array, default: () => [] },
  mainLabel: { type: String, default: '累计权重 −log₂p（bit）' },
  xLabel: { type: String, default: '轮次' },
  height: { type: Number, default: 260 },
})

const W = 680
const PAD = { l: 58, r: 18, t: 16, b: 34 }
const H = computed(() => props.height)
const plotW = computed(() => W - PAD.l - PAD.r)
const plotH = computed(() => H.value - PAD.t - PAD.b)

/** 只画有数据的序列（空数组不进图例，免得图例说有三条、图上只有两条） */
const live = computed(() => props.series.filter((s) => (s.points || []).length > 0).slice(0, 3))

const xMin = computed(() => {
  const xs = live.value.flatMap((s) => s.points.map((p) => Number(p.x)))
  return xs.length ? Math.min(...xs) : 1
})
const xMax = computed(() => {
  const xs = live.value.flatMap((s) => s.points.map((p) => Number(p.x)))
  return xs.length ? Math.max(...xs) : 1
})
const yMax = computed(() => {
  const ys = live.value.flatMap((s) => s.points.map((p) => Number(p.y)))
  const m = ys.length ? Math.max(...ys) : 1
  return m > 0 ? m * 1.06 : 1
})

function px(x) {
  const span = xMax.value - xMin.value
  if (span <= 0) return PAD.l + plotW.value / 2
  return PAD.l + ((Number(x) - xMin.value) / span) * plotW.value
}
function py(y) {
  return PAD.t + plotH.value - (Math.max(0, Number(y) || 0) / yMax.value) * plotH.value
}

const paths = computed(() => live.value.map((s) => s.points
  .map((p, i) => `${i === 0 ? 'M' : 'L'}${px(p.x).toFixed(1)},${py(p.y).toFixed(1)}`)
  .join(' ')))

const yTicks = computed(() => {
  const out = []
  for (let i = 0; i <= 4; i++) {
    const v = (yMax.value / 4) * i
    out.push({ v, y: py(v) })
  }
  return out
})

const xTicks = computed(() => {
  const a = xMin.value
  const b = xMax.value
  const n = Math.min(8, Math.max(2, b - a + 1))
  const out = []
  for (let i = 0; i < n; i++) {
    const x = Math.round(a + ((b - a) / (n - 1)) * i)
    out.push({ v: x, x: px(x) })
  }
  // 去重（轮次跨度小于刻度数时会重复）
  return out.filter((t, i) => i === 0 || t.v !== out[i - 1].v)
})

/* ---- 悬停：按轮次对齐读三条线 ---- */

const hoverRound = ref(null)

function nearest(s, round) {
  let best = null
  let bd = Infinity
  for (const p of s.points) {
    const d = Math.abs(Number(p.x) - round)
    if (d < bd) { bd = d; best = p }
  }
  return bd <= 0.5 ? best : null
}

const hoverInfo = computed(() => {
  if (hoverRound.value == null) return null
  const rows = live.value.map((s) => ({ label: s.label, p: nearest(s, hoverRound.value) }))
  if (rows.every((r) => !r.p)) return null
  return { round: hoverRound.value, rows }
})

function onMove(e) {
  const rect = e.currentTarget.getBoundingClientRect()
  if (!rect.width) return
  const mx = (e.clientX - rect.left) * (W / rect.width)
  const ratio = (mx - PAD.l) / plotW.value
  if (ratio < -0.02 || ratio > 1.02) { hoverRound.value = null; return }
  const span = xMax.value - xMin.value
  const raw = xMin.value + Math.min(1, Math.max(0, ratio)) * span
  hoverRound.value = Math.round(raw)
}

const fmt = (v) => (Number.isFinite(Number(v)) ? Number(v).toFixed(2) : '—')
</script>

<template>
  <div class="cmp-chart">
    <div v-if="!live.length" class="empty">
      这些快照都没有逐轮数据，画不出曲线（只比对表格里的总量）。
    </div>

    <svg
      v-else
      :viewBox="`0 0 ${W} ${H}`"
      class="chart"
      preserveAspectRatio="xMidYMid meet"
      @mousemove="onMove"
      @mouseleave="hoverRound = null"
    >
      <!-- 横向网格 -->
      <line
        v-for="t in yTicks" :key="'gy' + t.v"
        class="c-grid" :x1="PAD.l" :x2="W - PAD.r" :y1="t.y" :y2="t.y"
      />

      <!-- 左轴刻度 -->
      <text
        v-for="t in yTicks" :key="'ty' + t.v"
        class="c-tick" :x="PAD.l - 8" :y="t.y + 3.5" text-anchor="end"
      >{{ Math.round(t.v) }}</text>

      <!-- X 轴 -->
      <line class="c-axis" :x1="PAD.l" :x2="W - PAD.r"
        :y1="PAD.t + plotH" :y2="PAD.t + plotH" />
      <text
        v-for="t in xTicks" :key="'tx' + t.v"
        class="c-tick" :x="t.x" :y="PAD.t + plotH + 17" text-anchor="middle"
      >{{ t.v }}</text>

      <!-- 曲线（颜色由 0/1/2 号类声明，见 style） -->
      <path
        v-for="(d, i) in paths" :key="'ln' + i"
        :class="['c-line', `c-line-${i}`]" :d="d"
      />

      <!-- 悬停：竖线 + 每条线的点 -->
      <g v-if="hoverInfo">
        <line class="c-hover-line" :x1="px(hoverInfo.round)" :x2="px(hoverInfo.round)"
          :y1="PAD.t" :y2="PAD.t + plotH" />
        <template v-for="(r, i) in hoverInfo.rows" :key="'hd' + i">
          <circle v-if="r.p" :class="['c-dot', `c-dot-${i}`]"
            :cx="px(r.p.x)" :cy="py(r.p.y)" r="3.5" />
        </template>
      </g>

      <!-- 轴标题 -->
      <text class="c-axis-title" :x="PAD.l + plotW / 2" :y="H - 3" text-anchor="middle">{{ xLabel }}</text>
      <text class="c-axis-title" :x="12" :y="PAD.t + plotH / 2" text-anchor="middle"
        :transform="`rotate(-90 12 ${PAD.t + plotH / 2})`">{{ mainLabel }}</text>
    </svg>

    <div class="legend">
      <span v-for="(s, i) in live" :key="s.id || i" class="lg-item">
        <i :class="['sw', `sw-${i}`]"></i>{{ s.label }}
      </span>
      <span class="spacer"></span>
      <span v-if="hoverInfo" class="readout">
        第 <b>{{ hoverInfo.round }}</b> 轮：
        <template v-for="(r, i) in hoverInfo.rows" :key="'ro' + i">
          <span v-if="r.p" class="ro-item">
            <i :class="['sw', `sw-${i}`]"></i>−log₂p <b>{{ fmt(r.p.y) }}</b>
            <span class="faint">（活跃 {{ r.p.active }}）</span>
          </span>
        </template>
      </span>
      <span v-else class="faint small">把鼠标移到图上，按轮次读三条线</span>
    </div>
  </div>
</template>

<style scoped>
.cmp-chart { width: 100%; }

.chart {
  width: 100%;
  height: auto;
  display: block;
  cursor: crosshair;
}

/* ---- 颜色全部用类声明：SVG 属性里的 var() 不生效 ---- */

.c-grid {
  stroke: var(--border);
  stroke-width: 1;
  stroke-dasharray: 3 4;
}

.c-axis {
  stroke: var(--border-strong);
  stroke-width: 1;
}

.c-line {
  fill: none;
  stroke-width: 2;
  stroke-linejoin: round;
  stroke-linecap: round;
}
.c-line-0 { stroke: var(--accent); }
.c-line-1 { stroke: var(--violet); }
.c-line-2 { stroke: var(--cyan); }

.c-tick {
  fill: var(--text-faint);
  font-size: 10px;
  font-family: var(--mono);
}

.c-axis-title {
  fill: var(--text-muted);
  font-size: 10.5px;
}

.c-hover-line {
  stroke: var(--text-faint);
  stroke-width: 1;
  stroke-dasharray: 2 3;
}

.c-dot { fill: var(--surface); stroke-width: 2; }
.c-dot-0 { stroke: var(--accent); }
.c-dot-1 { stroke: var(--violet); }
.c-dot-2 { stroke: var(--cyan); }

/* ---- 图例 ---- */

.legend {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 8px;
  font-size: 11.5px;
  color: var(--text-muted);
  flex-wrap: wrap;
}

.lg-item,
.ro-item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.spacer { flex: 1; }

.sw {
  width: 14px;
  height: 3px;
  border-radius: 2px;
  display: inline-block;
  flex: none;
}
.sw-0 { background: var(--accent); }
.sw-1 { background: var(--violet); }
.sw-2 { background: var(--cyan); }

.readout {
  font-family: var(--mono);
  color: var(--text);
  display: inline-flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.readout b { color: var(--text); }
</style>
