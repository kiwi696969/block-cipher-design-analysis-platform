<script setup>
/**
 * 指标卡。
 *
 * 刻意保持"哑"组件：只负责展示，不做任何计算或格式化以外的逻辑。
 * 所有数值都由调用方算好传进来 —— 避免同一个指标在两个页面算出不同结果。
 */
const props = defineProps({
  label: { type: String, required: true },
  value: { type: [String, Number], required: true },
  unit: { type: String, default: '' },
  sub: { type: String, default: '' },
  hint: { type: String, default: '' },
  /**
   * 口径徽标（如「上界」）。
   * 为什么要有：数值本身看不出它是估计量还是精确量 —— 观众只看到 30，
   * 而真值是 12。把口径钉在标签旁边，才不至于被当成「算错了」。
   */
  badge: { type: String, default: '' },
  color: { type: String, default: '' },
  small: { type: Boolean, default: false },
  plain: { type: Boolean, default: false },
})
</script>

<template>
  <div
    class="metric"
    :class="{ plain }"
    :style="color ? { '--metric-color': color } : null"
  >
    <div class="m-label">
      <span>{{ label }}</span>
      <span v-if="badge" class="m-badge">{{ badge }}</span>
      <span v-if="hint" class="q" :title="hint">?</span>
    </div>
    <div class="m-value" :class="{ sm: small }">
      {{ value }}<span v-if="unit" class="m-unit">{{ unit }}</span>
    </div>
    <div v-if="sub" class="m-sub">{{ sub }}</div>
  </div>
</template>

<style scoped>
.q {
  display: inline-grid;
  place-items: center;
  width: 13px;
  height: 13px;
  border-radius: 50%;
  border: 1px solid var(--border-strong);
  color: var(--text-faint);
  font-size: 9px;
  cursor: help;
  flex: none;
}
.m-badge {
  flex: none;
  padding: 0 4px;
  border: 1px solid var(--warn-border);
  border-radius: var(--radius-sm);
  background: var(--warn-soft);
  color: var(--warn);
  font-size: 10px;
  line-height: 15px;
  letter-spacing: 0.02em;
}
</style>
