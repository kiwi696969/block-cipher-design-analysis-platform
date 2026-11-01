<script setup>
/**
 * 中文解析展示块。
 *
 * 结构编辑器、分析页、结果页三处都用它 —— 文案来自 core/explain.js，
 * 不在各个页面里硬编码（否则同一件事会写出三种说法）。
 */
defineProps({
  /** [{ h, p, level? }]，level ∈ good|warn|bad|ok|info */
  items: { type: Array, default: () => [] },
  title: { type: String, default: '' },
  /** 段落式（无卡片边框）还是卡片式 */
  bare: { type: Boolean, default: false },
})

const LEVEL_CLASS = {
  good: 'lv-good',
  ok: 'lv-ok',
  warn: 'lv-warn',
  bad: 'lv-bad',
  info: 'lv-info',
}

const LEVEL_TAG = {
  good: { text: '良好', cls: 'tag tag-ok' },
  ok: { text: '尚可', cls: 'tag tag-accent' },
  warn: { text: '需注意', cls: 'tag tag-warn' },
  bad: { text: '风险', cls: 'tag tag-err' },
}
</script>

<template>
  <div v-if="items.length" :class="bare ? '' : 'card'">
    <div v-if="title && !bare" class="card-head">
      <h2>{{ title }}</h2>
    </div>
    <div :class="bare ? '' : 'card-body'">
      <div
        v-for="(it, i) in items" :key="i"
        class="blk" :class="LEVEL_CLASS[it.level]"
      >
        <div class="blk-head">
          <h3>{{ it.h }}</h3>
          <span v-if="LEVEL_TAG[it.level]" :class="LEVEL_TAG[it.level].cls">
            {{ LEVEL_TAG[it.level].text }}
          </span>
        </div>
        <p v-html="it.p"></p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.blk {
  position: relative;
  padding: 11px 0 11px 14px;
  border-left: 2px solid var(--border);
}

.blk + .blk {
  margin-top: 4px;
  padding-top: 13px;
  border-top: 1px dashed var(--border);
}

.blk-head {
  display: flex;
  align-items: center;
  gap: 9px;
  margin-bottom: 4px;
}

.blk-head h3 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
}

.blk p {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.78;
  color: var(--text-muted);
}

/* 让 explain.js 里写的 **强调** 有样式 */
.blk :deep(strong) {
  color: var(--text);
  font-weight: 600;
}

.lv-good {
  border-left-color: var(--ok);
}
.lv-ok {
  border-left-color: var(--accent);
}
.lv-warn {
  border-left-color: var(--warn);
}
.lv-bad {
  border-left-color: var(--err);
}
.lv-info {
  border-left-color: var(--border-strong);
}
</style>
