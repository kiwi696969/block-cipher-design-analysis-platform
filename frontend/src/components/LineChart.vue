<script setup>
/**
 * 轻量 SVG 折线图。
 *
 * 为什么自己画而不用图表库：
 *   1. 零依赖 —— 这个项目刻意不引第三方图表库（ECharts 也是 1MB+）；
 *   2. 需要"逐轮回放"这种自定义交互；
 *   3. 主题切换靠 CSS 变量自动跟随，图表库通常要手动 re-init。
 *
 * ⚠️ 关键实现细节：**所有颜色都走 CSS 类，不要写成 SVG 属性**。
 *   SVG 的 presentation attribute（`stroke="var(--x)"`）**不做 var() 替换**，
 *   浏览器会把它当成非法值并回退到初始值 → 曲线全黑、深色模式下看不见。
 *   必须在 <style> 里用类声明颜色。
 */
import { computed, ref } from 'vue'

const props = defineProps({
  /** 主序列：[{ x, y, active? }]，x 通常为轮数 */
  points: { type: Array, default: () => [] },
  /** 次序列（可选），用于对比，如"累计活跃 S 盒" */
  second: { type: Array, default: () => [] },
  secondLabel: { type: String, default: '' },
  mainLabel: { type: String, default: '累计权重 −log₂p' },
  xLabel: { type: String, default: '轮数' },
  /** 高亮到第几个点（回放用），-1 表示全部显示 */
  marker: { type: Number, default: -1 },
  /** 参考线（权重阈值），0 = 不画 */
  threshold: { type: Number, default: 0 },
  height: { type: Number, default: 240 },
  area: { type: Boolean, default: true },
})

const W = 680
const PAD = { l: 58, r: 58, t: 18, b: 34 }

const hover = ref(-1)

/** marker >= 0 时只画到 marker，实现"进度条式"回放 */
const shown = computed(() => {
  const n = props.marker >= 0 ? props.marker + 1 : props.points.length
  return props.points.slice(0, Math.max(0, n))
})

const H = computed(() => props.height)
const plotW = computed(() => W - PAD.l - PAD.r)
const plotH = computed(() => H.value - PAD.t - PAD.b)

const xMax = computed(() => {
  const all = [...props.points, ...props.second]
  const m = all.length ? Math.max(...all.map((p) => Number(p.x) || 0)) : 1
  return m > 0 ? m : 1
})

const yMax = computed(() => {
  const all = [...props.points]
  const m = all.length ? Math.max(...all.map((p) => Number(p.y) || 0)) : 1
  const withThreshold = Math.max(m, props.threshold || 0)
  return withThreshold > 0 ? withThreshold * 1.08 : 1
})

/** 次序列有自己的量纲（活跃 S 盒数），用右侧独立刻度 */
const secondMax = computed(() => {
  const m = props.second.length ? Math.max(...props.second.map((p) => Number(p.y) || 0)) : 0
  return m > 0 ? m * 1.08 : 1
})

function px(x) {
  return PAD.l + ((Number(x) || 0) / xMax.value) * plotW.value
}
function py(y) {
  return PAD.t + plotH.value - ((Number(y) || 0) / yMax.value) * plotH.value
}
function py2(y) {
  return PAD.t + plotH.value - ((Number(y) || 0) / secondMax.value) * plotH.value
}

function pathOf(pts, useSecond = false) {
  if (!pts.length) return ''
  const f = useSecond ? py2 : py
  return pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${px(p.x).toFixed(1)},${f(p.y).toFixed(1)}`).join(' ')
}

const mainPath = computed(() => pathOf(shown.value))

const areaPath = computed(() => {
  const pts = shown.value
  if (!pts.length) return ''
  const base = PAD.t + plotH.value
  return `${pathOf(pts)} L${px(pts[pts.length - 1].x).toFixed(1)},${base} L${px(pts[0].x).toFixed(1)},${base} Z`
})

const secondPath = computed(() => {
  const n = props.marker >= 0 ? props.marker + 1 : props.second.length
  return pathOf(props.second.slice(0, Math.max(0, n)), true)
})

/** Y 轴 5 条刻度 */
const yTicks = computed(() => {
  const out = []
  for (let i = 0; i <= 4; i++) {
    const v = (yMax.value / 4) * i
    out.push({
      v,
      y: py(v),
      // 右侧次要刻度：按两个量纲的比例换算
      v2: (secondMax.value / 4) * i,
    })
  }
  return out
})

const xTicks = computed(() => {
  const out = []
  const n = Math.min(8, Math.max(2, props.points.length))
  for (let i = 0; i < n; i++) {
    const x = Math.round((xMax.value / (n - 1)) * i) || 1
    out.push({ v: x, x: px(x) })
  }
  return out
})

const thresholdY = computed(() => (props.threshold > 0 ? py(props.threshold) : null))

const hoverPoint = computed(() => {
  if (hover.value < 0 || hover.value >= shown.value.length) return null
  return shown.value[hover.value]
})

/** 鼠标移动 → 换算到最近的轮数下标 */
function onMove(e) {
  const rect = e.currentTarget.getBoundingClientRect()
  if (!rect.width) return
  const scale = W / rect.width
  const mx = (e.clientX - rect.left) * scale
  const ratio = (mx - PAD.l) / plotW.value
  const idx = Math.round(ratio * (shown.value.length - 1))
  hover.value = idx >= 0 && idx < shown.value.length ? idx : -1
}

const fmt = (v, d = 2) => (Number.isFinite(Number(v)) ? Number(v).toFixed(d) : '-')
const fmtTick = (v) => (v >= 10000 ? (v / 1000).toFixed(1) + 'k' : Math.round(v).toString())
</script>

<template>
  <div class="chart-wrap">
    <div v-if="!points.length" class="empty">
      还没有数据。运行一次分析后，这里会画出收敛曲线。
    </div>

    <svg
      v-else
      :viewBox="`0 0 ${W} ${H}`"
      class="chart"
      preserveAspectRatio="xMidYMid meet"
      @mousemove="onMove"
      @mouseleave="hover = -1"
    >
      <defs>
        <linearGradient id="lcAreaFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" class="c-stop0" />
          <stop offset="100%" class="c-stop1" />
        </linearGradient>
      </defs>

      <!-- 横向网格 -->
      <line
        v-for="t in yTicks" :key="'gy' + t.v"
        class="c-grid"
        :x1="PAD.l" :x2="W - PAD.r" :y1="t.y" :y2="t.y"
      />

      <!-- 权重阈值参考线 -->
      <g v-if="thresholdY !== null">
        <line class="c-thresh" :x1="PAD.l" :x2="W - PAD.r" :y1="thresholdY" :y2="thresholdY" />
        <text class="c-thresh-t" :x="W - PAD.r - 4" :y="thresholdY - 5" text-anchor="end">
          阈值 {{ threshold }}
        </text>
      </g>

      <!-- 左轴刻度（主序列量纲） -->
      <text
        v-for="t in yTicks" :key="'ty' + t.v"
        class="c-tick" :x="PAD.l - 8" :y="t.y + 3.5" text-anchor="end"
      >{{ fmtTick(t.v) }}</text>

      <!-- 右轴刻度（次序列量纲） -->
      <text
        v-for="t in yTicks" :key="'ty2' + t.v"
        class="c-tick2" :x="W - PAD.r + 8" :y="t.y + 3.5" text-anchor="start"
      >{{ fmtTick(t.v2) }}</text>

      <!-- X 轴 -->
      <line class="c-axis" :x1="PAD.l" :x2="W - PAD.r"
        :y1="PAD.t + plotH" :y2="PAD.t + plotH" />
      <text
        v-for="t in xTicks" :key="'tx' + t.v"
        class="c-tick" :x="t.x" :y="PAD.t + plotH + 18" text-anchor="middle"
      >{{ t.v }}</text>

      <!-- 面积 + 主曲线 -->
      <path v-if="area && shown.length > 1" :d="areaPath" fill="url(#lcAreaFill)" />
      <path class="c-main" :d="mainPath" />

      <!-- 次序列 -->
      <path v-if="second.length" class="c-second" :d="secondPath" />

      <!-- 悬停十字线 -->
      <g v-if="hoverPoint">
        <line class="c-hover-line" :x1="px(hoverPoint.x)" :x2="px(hoverPoint.x)"
          :y1="PAD.t" :y2="PAD.t + plotH" />
        <circle class="c-hover-dot" :cx="px(hoverPoint.x)" :cy="py(hoverPoint.y)" r="4" />
      </g>

      <!-- 轴标题 -->
      <text class="c-axis-title" :x="PAD.l + plotW / 2" :y="H - 4" text-anchor="middle">{{ xLabel }}</text>
      <text class="c-axis-title" :x="13" :y="PAD.t + plotH / 2" text-anchor="middle"
        :transform="`rotate(-90 13 ${PAD.t + plotH / 2})`">{{ mainLabel }}</text>
    </svg>

    <div class="legend">
      <span class="lg-item">
        <i class="sw sw-main"></i>{{ mainLabel }}
      </span>
      <span v-if="second.length" class="lg-item">
        <i class="sw sw-dash"></i>{{ secondLabel || '次序列' }}
      </span>
      <span class="spacer"></span>
      <span v-if="hoverPoint" class="readout">
        第 <b>{{ hoverPoint.x }}</b> 轮 ·
        −log₂p = <b>{{ fmt(hoverPoint.y) }}</b>
        <template v-if="hoverPoint.active !== undefined">
          · 活跃 S 盒 <b>{{ hoverPoint.active }}</b>
        </template>
      </span>
      <span v-else class="faint small">把鼠标移到曲线上可看逐轮数值</span>
    </div>
  </div>
</template>

<style scoped>
.chart-wrap {
  width: 100%;
}

.chart {
  width: 100%;
  height: auto;
  display: block;
  cursor: crosshair;
}

/* ---- 颜色全部用类声明：SVG 属性里的 var() 不生效 ---- */

.c-stop0 {
  stop-color: var(--accent);
  stop-opacity: 0.22;
}
.c-stop1 {
  stop-color: var(--accent);
  stop-opacity: 0.01;
}

.c-grid {
  stroke: var(--border);
  stroke-width: 1;
  stroke-dasharray: 3 4;
}

.c-axis {
  stroke: var(--border-strong);
  stroke-width: 1;
}

.c-thresh {
  stroke: var(--warn);
  stroke-width: 1.2;
  stroke-dasharray: 6 4;
}

.c-thresh-t {
  fill: var(--warn);
  font-size: 10px;
  font-family: var(--mono);
}

.c-main {
  fill: none;
  stroke: var(--accent);
  stroke-width: 2;
  stroke-linejoin: round;
  stroke-linecap: round;
}

.c-second {
  fill: none;
  stroke: var(--violet);
  stroke-width: 1.6;
  stroke-dasharray: 5 3;
  stroke-linejoin: round;
}

.c-tick {
  fill: var(--text-faint);
  font-size: 10px;
  font-family: var(--mono);
}

.c-tick2 {
  fill: var(--violet);
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

.c-hover-dot {
  fill: var(--surface);
  stroke: var(--accent);
  stroke-width: 2;
}

/* ---- 图例 ---- */

.legend {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-top: 8px;
  font-size: 11.5px;
  color: var(--text-muted);
  flex-wrap: wrap;
}

.lg-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.sw {
  width: 14px;
  height: 3px;
  border-radius: 2px;
  display: inline-block;
}

.sw-main {
  background: var(--accent);
}

.sw-dash {
  background-image: repeating-linear-gradient(90deg, var(--violet) 0 3px, transparent 3px 5px);
}

.readout {
  font-family: var(--mono);
  color: var(--text);
}

.readout b {
  color: var(--accent);
}
</style>
