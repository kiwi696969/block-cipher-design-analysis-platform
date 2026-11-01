<script setup>
/**
 * 运行日志页。
 *
 * 日志不是前端拼的"好看的进度文字"—— 全部来自引擎的 `onLog(level, msg)` 回调。
 * 所以日志里出现的数字和结果页显示的**必然**一致，对不上就说明有 bug。
 */
import { computed } from 'vue'
import { href } from '@/pages.js'

import { logs, clearLogs, result, status, mode, log } from '@/stores/platform.js'
import { fmtMs } from '@/core/explain.js'

import MetricCard from '@/components/MetricCard.vue'
import LogPanel from '@/components/LogPanel.vue'

const counts = computed(() => {
  const c = { info: 0, ok: 0, warn: 0, error: 0, debug: 0 }
  for (const l of logs.value) if (c[l.level] !== undefined) c[l.level]++
  return c
})

const errWarn = computed(() => counts.value.error + counts.value.warn)

const firstAt = computed(() => (logs.value.length ? logs.value[0].t : null))
const spanMs = computed(() => {
  if (logs.value.length < 2) return 0
  return logs.value[logs.value.length - 1].t - logs.value[0].t
})

const m = computed(() => result.value?.metrics || null)

const statusText = computed(() => ({
  idle: '待运行', running: '运行中', done: '已完成', error: '出错', aborted: '已中止',
}[status.value] || '待运行'))

function doClear() {
  clearLogs()
  log('info', '日志已清空')
}
</script>

<template>
  <div class="page">
    <div class="head">
      <div>
        <h2 class="section-title">运行日志</h2>
        <p class="section-desc">
          搜索过程的完整记录，由引擎逐条输出。排查结果异常时先看这里 ——
          报错原因、是否触达时间预算、用了哪条模型路径，都会写在这儿。
        </p>
      </div>
      <div class="row-wrap">
        <button class="btn btn-sm" :disabled="!logs.length" @click="doClear">清空日志</button>
        <a :href="href('differential')" class="btn btn-sm btn-primary">去运行分析 →</a>
      </div>
    </div>

    <div class="metrics-grid">
      <MetricCard label="日志条数" :value="logs.length" sub="上限 2000 条，超出自动淘汰最早" />
      <MetricCard label="当前状态" :value="statusText"
        :sub="mode === 'linear' ? '线性分析模式' : '差分分析模式'" />
      <MetricCard label="错误 / 警告" :value="errWarn"
        :sub="`${counts.error} 错误 · ${counts.warn} 警告`"
        :color="counts.error ? 'var(--err)' : (counts.warn ? 'var(--warn)' : 'var(--ok)')" />
      <MetricCard label="最近一次结果" :value="m ? m.weight.toFixed(2) : '—'" unit="bit"
        :sub="m ? `−log₂p · ${m.rounds} 轮 · ${fmtMs(m.elapsedMs)}` : '尚未运行'" />
      <MetricCard label="日志时间跨度"
        :value="spanMs ? (spanMs / 1000).toFixed(1) : '—'" unit="s"
        :sub="firstAt ? new Date(firstAt).toLocaleTimeString() + ' 起' : '无日志'" />
      <MetricCard label="日志级别分布" :value="`${counts.info}/${counts.debug}`"
        sub="信息 / 调试" />
    </div>

    <LogPanel
      :logs="logs"
      :height="560"
      title="完整日志"
      @clear="doClear"
    />

    <div class="card">
      <div class="card-head"><h2>日志里的数字都是什么</h2></div>
      <div class="card-body tight">
        <div class="kv">
          <dt class="mono">−log₂p</dt>
          <dd>累计权重。差分概率（或线性相关平方）的负对数 —— 越小说明这条特征越好用。</dd>
          <dt class="mono">bit/轮</dt>
          <dd>平均每轮泄漏多少 bit 的信息。这个值越大，越多的轮数就能把差分"洗掉"。</dd>
          <dt class="mono">活跃 S 盒</dt>
          <dd>路径上被激活的 S 盒个数。它决定密钥恢复阶段能过滤多少比特。</dd>
          <dt class="mono">束宽 / 候选上限</dt>
          <dd>束搜索每层保留的状态数。加大能让结果更优，代价是更慢。</dd>
          <dt class="mono">时间预算触顶</dt>
          <dd>出现"达到时间预算"警告时，结果可能是次优的 —— 提高预算或减小束宽后重跑。</dd>
        </div>
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
  margin-top: 16px;
}

.metrics-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}

@media (max-width: 1180px) {
  .metrics-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
