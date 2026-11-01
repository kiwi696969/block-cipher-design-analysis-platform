<script setup>
/**
 * DDT / LAT 的画布热力图。
 *
 * 为什么用 canvas 而不是 <table>：8 bit S 盒的 DDT 是 256×256 = 65,536 个格子，
 * 用 <td> 渲染等于往 DOM 里塞六万多个节点，页面会直接卡住。canvas 只画一张
 * n×n 的位图，再用 CSS 放大（image-rendering: pixelated 保证放大后是方块）。
 *
 * 取色用固定的四档色阶（蓝 → 青 → 黄 → 红）而不是"单一色相 + 透明度"，
 * 是因为 **canvas 拿不到 CSS 变量**，位图颜色只能写死在像素里；而 DDT 的取值
 * 常常只有 0/2/4 三档，只靠透明度区分时中间档几乎看不出差别。色相分离之后
 * 深浅两套主题下都能一眼读出来，代价是主题切换时不能靠 CSS 自动换色 —— 但
 * 这个色阶对两种主题都够清晰，不需要重画。
 *
 * 尺度上**跳过第 0 行与第 0 列**：DDT[0][0] = 2^n、LAT[0][0] = 2^(n-1) 是平凡项，
 * 把它们算进最大值会让真正要看的那几个格子全部淡到看不见
 * （这也正是 differentialUniformity() / linearity() 从下标 1 开始扫的原因）。
 */
import { computed, onMounted, ref, watch } from 'vue'

const props = defineProps({
  /** 二维数组（行可以是 TypedArray）：matrix[行][列] */
  matrix: { type: Array, required: true },
  /** 'ddt' 取原值；'lat' 取绝对值 —— 线性逼近表有正有负，看的是相关强度 */
  kind: { type: String, default: 'ddt' },
  /** 要标出的极值格 {row, col} */
  highlight: { type: Object, default: null },
  /** 坐标的十六进制位数（4 bit 盒 1 位、8 bit 盒 2 位） */
  hexWidth: { type: Number, default: 2 },
})

const canvas = ref(null)
const hover = ref(null)

const size = computed(() => props.matrix?.length || 0)

/** 非平凡最大值（跳过第 0 行/列），0 时回落到 1 避免除零 */
const maxValue = computed(() => {
  const m = props.matrix || []
  let mx = 0
  for (let a = 1; a < m.length; a++) {
    const row = m[a]
    for (let b = 1; b < row.length; b++) {
      const v = props.kind === 'lat' ? Math.abs(row[b]) : row[b]
      if (v > mx) mx = v
    }
  }
  return mx || 1
})

/**
 * 热力色阶：蓝 → 青 → 黄 → 红。
 *
 * 不用"单一色相 + 透明度"是因为 DDT 的取值往往只有 0/2/4 三种 ——
 * 只靠透明度区分时，2 和 4 在屏幕上几乎一样，等于白画。
 * 换色相之后同样的三档一眼就能分开。
 */
const STOPS = [
  [47, 109, 246],   // 低 —— 蓝
  [34, 211, 238],   // 青
  [250, 204, 21],   // 黄
  [239, 68, 68],    // 高 —— 红
]

function rampColor(t) {
  const clamped = Math.min(1, Math.max(0, t))
  const scaled = clamped * (STOPS.length - 1)
  const i = Math.min(STOPS.length - 2, Math.floor(scaled))
  const f = scaled - i
  const lo = STOPS[i]
  const hi = STOPS[i + 1]
  return [
    Math.round(lo[0] + (hi[0] - lo[0]) * f),
    Math.round(lo[1] + (hi[1] - lo[1]) * f),
    Math.round(lo[2] + (hi[2] - lo[2]) * f),
  ]
}

function hex(v) {
  return '0x' + Number(v).toString(16).toUpperCase().padStart(props.hexWidth, '0')
}

function paint() {
  const el = canvas.value
  const m = props.matrix || []
  const n = m.length
  if (!el || !n) return
  el.width = n
  el.height = n
  const ctx = el.getContext('2d')
  const img = ctx.createImageData(n, n)
  const data = img.data
  const mx = maxValue.value

  for (let a = 0; a < n; a++) {
    const row = m[a]
    for (let b = 0; b < n; b++) {
      const v = props.kind === 'lat' ? Math.abs(row[b]) : row[b]
      const i = (a * n + b) * 4
      if (!v) {
        // 零格：极淡的中性灰 —— 深浅主题都能看出"这里是 0"，又不至于抢眼
        data[i] = 127
        data[i + 1] = 127
        data[i + 2] = 127
        data[i + 3] = 26
        continue
      }
      // 先开方再上色阶：DDT 的取值是 0/2/4 这种量级，线性映射会把中间档压到最底
      const [r, g, bl] = rampColor(Math.sqrt(v / mx))
      data[i] = r
      data[i + 1] = g
      data[i + 2] = bl
      data[i + 3] = 255
    }
  }
  ctx.putImageData(img, 0, 0)
}

/**
 * 极值格的定位与大小（百分比，跟随画布实际显示尺寸缩放）。
 * 边长取"一个格子"与 1.6% 中的较大者 —— 256×256 时单格只有 0.39%，
 * 直接用一个格子的尺寸会细到看不见，所以给它一个可见下限。
 */
const markStyle = computed(() => {
  const h = props.highlight
  const n = size.value
  if (!h || !n || h.row == null || h.col == null) return null
  const box = Math.max(100 / n, 1.6)
  return {
    left: `${((h.col + 0.5) / n) * 100}%`,
    top: `${((h.row + 0.5) / n) * 100}%`,
    width: `${box}%`,
    height: `${box}%`,
  }
})

function onMove(event) {
  const el = canvas.value
  const n = size.value
  if (!el || !n) return
  const rect = el.getBoundingClientRect()
  if (!rect.width || !rect.height) return
  const clamp = (x, hi) => Math.min(hi, Math.max(0, x))
  const col = clamp(Math.floor(((event.clientX - rect.left) / rect.width) * n), n - 1)
  const row = clamp(Math.floor(((event.clientY - rect.top) / rect.height) * n), n - 1)
  hover.value = { row, col, value: props.matrix[row][col] }
}

onMounted(paint)
// flush: 'post' —— 必须等 DOM 更新完再画，否则拿到的还是旧尺寸的画布
watch([() => props.matrix, () => props.kind], paint, { flush: 'post' })
</script>

<template>
  <div class="heat">
    <div class="heat-wrap">
      <canvas
        ref="canvas"
        class="heat-canvas"
        @mousemove="onMove"
        @mouseleave="hover = null"
      ></canvas>
      <span v-if="markStyle" class="heat-mark" :style="markStyle"></span>
    </div>

    <div class="heat-legend">
      <span class="faint">0</span>
      <span class="heat-bar"></span>
      <span class="faint mono">{{ maxValue }}</span>
      <span class="heat-readout mono">
        <template v-if="hover">
          [{{ hex(hover.row) }}] → [{{ hex(hover.col) }}] = {{ hover.value }}
        </template>
        <template v-else>悬停查看任意格子</template>
      </span>
    </div>
  </div>
</template>

<style scoped>
.heat-wrap {
  position: relative;
  width: min(100%, 420px);
}

.heat-canvas {
  display: block;
  width: 100%;
  aspect-ratio: 1 / 1;
  border: 1px solid var(--border);
  border-radius: 6px;
  /* 放大后保持方块，不要被插值糊成一片渐变 */
  image-rendering: pixelated;
  cursor: crosshair;
}

.heat-mark {
  position: absolute;
  border: 1.5px solid var(--amber);
  border-radius: 2px;
  transform: translate(-50%, -50%);
  pointer-events: none;
}

.heat-legend {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
  font-size: 11.5px;
}

/* 图例条必须与画布的色阶一致，否则"看颜色读强度"就失效了 */
.heat-bar {
  width: 92px;
  height: 8px;
  border-radius: 4px;
  border: 1px solid var(--border);
  background: linear-gradient(
    to right,
    rgb(47, 109, 246),
    rgb(34, 211, 238),
    rgb(250, 204, 21),
    rgb(239, 68, 68)
  );
}

.heat-readout {
  margin-left: auto;
  color: var(--text-muted);
  font-size: 11.5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
