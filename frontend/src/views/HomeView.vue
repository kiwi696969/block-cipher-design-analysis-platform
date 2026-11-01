<script setup>
/**
 * 工作台（首页）。
 *
 * 定位：**一次分析的起点与出口**，不是宣传页。
 * 只回答四件事 —— 现在在算什么、上次算出了什么、下一步能去哪、会话里发生了什么。
 *
 * 改版前这里是一整屏英雄区（大标题 + 渐变字 + 三句话介绍 + 功能卡），
 * 那些内容属于「教学与介绍」，已经在教程页；工作台不再重复。
 * 平台定位与结果口径的说明保留，但折叠起来 —— 它是"需要时才看"的东西。
 */
import { computed } from 'vue'
import { href } from '@/pages.js'

import { graph, result, logs, currentSboxStats, mode, templateId } from '@/stores/platform.js'
import { fmtMs, fmtInt } from '@/core/explain.js'
import FoldPanel from '@/components/FoldPanel.vue'

const meta = computed(() => graph.value?.meta || {})

const stats = computed(() => {
  const s = currentSboxStats.value
  return [
    { label: '当前算法', value: meta.value.name || '未选择', sub: meta.value.standard || '从「算法选择」开始' },
    { label: '模板', value: templateId.value || '—', sub: meta.value.structure === 'feistel' ? '广义 Feistel' : 'SPN' },
    { label: '轮数', value: meta.value.rounds || '-', unit: '轮', sub: meta.value.blockSize ? `${meta.value.blockSize} bit 分组` : '' },
    {
      label: '默认 S 盒 · SM4',
      value: s ? `DU ${s.differentialUniformity}` : '-',
      sub: s ? `NL ${s.nonlinearity} · 代数次数 ${s.algebraicDegree}` : '',
    },
  ]
})

const lastResult = computed(() => {
  const r = result.value
  if (!r) return null
  return {
    weight: r.metrics.weight,
    active: r.metrics.activeSboxes,
    rounds: r.metrics.rounds,
    ms: r.metrics.elapsedMs,
    variables: r.model?.variables?.total,
    clauses: r.model?.clauses?.total,
  }
})

/** 下一步能去哪。顺序 = 推荐的操作顺序。 */
const TASKS = [
  { to: 'ciphers', title: '选择算法', desc: 'SM4 / AES-128 / PRESENT-64 / 类 AES / 空白画布' },
  { to: 'structure', title: '编辑结构', desc: '拖组件搭轮函数，改动立即反映到分析' },
  { to: 'differential', title: '差分分析', desc: '浏览器内搜索，秒级出结果，适合调参看趋势' },
  { to: 'linear', title: '线性分析', desc: '同一套流程，改走 LAT 与线性逼近' },
  { to: 'bca', title: '后端搜索', desc: '服务器端 SAT，能推到浏览器算不动的轮数' },
  { to: 'results', title: '结果与指标', desc: '把一次结果完整摊开，做横向比较' },
]

const recentLogs = computed(() => logs.value.slice(-6).reverse())

const fmtTime = (t) => {
  const d = new Date(t)
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, '0')).join(':')
}
</script>

<template>
  <div class="page">
    <div class="head">
      <div>
        <h2 class="section-title">工作台</h2>
        <p class="section-desc">
          一次分析的起点与出口。所有数字都来自本次会话 —— 刷新页面即清空，
          要留存请导出工程。
        </p>
      </div>
      <div class="row-wrap">
        <a :href="href('ciphers')" class="btn btn-sm btn-primary">选择算法 →</a>
        <a :href="href('differential')" class="btn btn-sm">去分析</a>
      </div>
    </div>

    <!-- -------------------------------------------------------------- 当前上下文 -->
    <div class="card">
      <div class="card-head">
        <h2>当前上下文</h2>
        <span class="hint">跨页面常驻，顶部上下文条同步显示</span>
      </div>
      <div class="card-body tight">
        <div class="grid-4">
          <div v-for="s in stats" :key="s.label" class="metric plain">
            <div class="m-label">{{ s.label }}</div>
            <div class="m-value sm">
              {{ s.value }}<span v-if="s.unit" class="m-unit">{{ s.unit }}</span>
            </div>
            <div v-if="s.sub" class="m-sub">{{ s.sub }}</div>
          </div>
        </div>
      </div>
    </div>

    <div class="grid-2 block-gap">
      <!-- -------------------------------------------------------------- 上次结果 -->
      <div class="card">
        <div class="card-head">
          <h2>上次分析结果</h2>
          <span v-if="lastResult" class="hint">
            {{ mode === 'linear' ? '线性' : '差分' }} · {{ lastResult.rounds }} 轮 ·
            {{ fmtMs(lastResult.ms) }}
          </span>
        </div>
        <div class="card-body tight">
          <template v-if="lastResult">
            <div class="kv">
              <dt>累计权重 −log₂p</dt>
              <dd>{{ lastResult.weight.toFixed(2) }}</dd>
              <dt>概率</dt>
              <dd>≈ 2^−{{ lastResult.weight.toFixed(0) }}</dd>
              <dt>活跃 S 盒</dt>
              <dd>{{ lastResult.active }}（平均 {{ (lastResult.active / lastResult.rounds).toFixed(2) }} /轮）</dd>
              <dt>建模变量 / 子句</dt>
              <dd>{{ fmtInt(lastResult.variables) }} / {{ fmtInt(lastResult.clauses) }}</dd>
            </div>
            <div class="row-wrap" style="margin-top: 10px">
              <a :href="href('results')" class="btn btn-sm btn-primary">完整指标 →</a>
              <a :href="href('logs')" class="btn btn-sm">日志（{{ logs.length }}）</a>
            </div>
          </template>
          <div v-else class="empty" style="padding: 18px 8px">
            本次会话还没有结果。<a :href="href('differential')">去差分分析页</a>跑一次。
          </div>
        </div>
      </div>

      <!-- -------------------------------------------------------------- 快捷入口 -->
      <div class="card">
        <div class="card-head">
          <h2>待办路径</h2>
          <span class="hint">按顺序走一遍即可完成一次分析</span>
        </div>
        <div class="card-body tight">
          <div class="tasks">
            <a v-for="(t, i) in TASKS" :key="t.to" :href="href(t.to)" class="task">
              <span class="t-i">{{ String(i + 1).padStart(2, '0') }}</span>
              <span class="t-b">
                <b>{{ t.title }}</b>
                <small>{{ t.desc }}</small>
              </span>
              <span class="t-a">→</span>
            </a>
          </div>
        </div>
      </div>
    </div>

    <!-- -------------------------------------------------------------- 最近日志 -->
    <FoldPanel
      v-if="recentLogs.length"
      class="block-gap"
      title="最近日志"
      :hint="`共 ${logs.length} 条 · 显示最近 ${recentLogs.length} 条`"
    >
      <div class="logpanel" style="max-height: 220px">
        <div v-for="l in recentLogs" :key="l.id" class="lg" :class="'lg-' + l.level">
          <span class="t">{{ fmtTime(l.t) }}</span>
          <span class="m">{{ l.msg }}</span>
        </div>
      </div>
      <div class="row-wrap" style="margin-top: 10px">
        <a :href="href('logs')" class="btn btn-sm">看全部日志 →</a>
      </div>
    </FoldPanel>

    <!-- -------------------------------------------------------------- 口径说明 -->
    <FoldPanel
      class="block-gap"
      title="平台定位与结果口径"
      hint="为什么这里的数字可以信，以及哪些数字不能当精确最优"
    >
      <p class="note">
        本平台是<b>分析工具</b>，不是密码库。底层引擎严格按 DDT / LAT 定义实算，
        基准值有自动化回归测试守着（<code>frontend/tests/verify-core.mjs</code>）。
      </p>
      <p class="note">
        求解一律走<b>后端 BCA</b>：用 kissat 在全空间上做 SAT，概率权重从 0 往上逐个判定，
        第一个可满足的值就是<b>最小权重</b> —— 它既可达、又是下界，即真值。
        页面只显示这一份数值；后端还没跑到的轮次显示「<b>还未求解</b>」，不用近似值顶上。
        代价是<b>结果可以慢</b>：全空间 SAT 越往后越贵，轮数高时要先预热或耐心等待。
      </p>
      <p class="note">
        <b>旧版本</b>曾在浏览器内用束搜索做近似（只保证给出权重<b>上界</b>），
        5 轮起必然偏高（<code>30.00</code> 对 <code>12.00</code>）。那条路径
        <b>已不再参与结果计算</b>，代码只留给回归测试 —— 页面上不会再出现
        「两列数字对不上」。来龙去脉见 <a :href="href('tutorial')">新手教程</a>。
      </p>
      <p class="note">
        第一次用建议先看<a :href="href('tutorial')">新手教程</a>，那里有概念解释与可一键执行的示例。
      </p>
    </FoldPanel>
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

.block-gap {
  margin-top: 12px;
}

/* ---------------------------------------------------------------- 待办路径 */

.tasks {
  display: flex;
  flex-direction: column;
}

.task {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 4px;
  border-bottom: 1px dashed var(--border);
  color: inherit;
  text-decoration: none;
  transition: background 0.12s;
}

.task:last-child {
  border-bottom: none;
}

.task:hover {
  text-decoration: none;
  background: var(--surface-2);
}

.t-i {
  font-family: var(--mono);
  font-size: 10.5px;
  color: var(--text-faint);
  flex: none;
}

.t-b {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
  flex: 1;
}

.t-b b {
  font-size: 12.5px;
  font-weight: 600;
}

.t-b small {
  font-size: 11px;
  color: var(--text-faint);
}

.t-a {
  color: var(--text-faint);
  font-size: 12px;
  flex: none;
}

.task:hover .t-a {
  color: var(--accent);
}

/* ---------------------------------------------------------------- 口径说明 */

.note {
  margin: 0 0 8px;
  font-size: 12px;
  line-height: 1.75;
  color: var(--text-muted);
}

.note:last-child {
  margin-bottom: 0;
}

.note b {
  color: var(--text);
}
</style>
