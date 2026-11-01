<script setup>
/**
 * 运行日志面板。
 *
 * 日志来源是引擎的 `onLog(level, msg, data)` 回调 —— 内容和命令行版完全一致，
 * 不是前端另编的"好看的进度文字"。这一点很重要：
 * 日志里出现 647.00 之类的数字，一定和结果区显示的是同一个。
 */
import { computed, nextTick, ref, watch } from 'vue'

const props = defineProps({
  logs: { type: Array, default: () => [] },
  height: { type: Number, default: 260 },
  /** 紧凑模式：不显示工具栏 */
  compact: { type: Boolean, default: false },
  autoscroll: { type: Boolean, default: true },
  title: { type: String, default: '运行日志' },
})

const emit = defineEmits(['clear'])

const filter = ref('')
const level = ref('all')
const box = ref(null)
const follow = ref(true)

const LEVELS = [
  { id: 'all', label: '全部' },
  { id: 'info', label: '信息' },
  { id: 'ok', label: '成功' },
  { id: 'warn', label: '警告' },
  { id: 'error', label: '错误' },
  { id: 'debug', label: '调试' },
]

const counts = computed(() => {
  const c = { info: 0, ok: 0, warn: 0, error: 0, debug: 0 }
  for (const l of props.logs) if (c[l.level] !== undefined) c[l.level]++
  return c
})

const shown = computed(() => {
  const kw = filter.value.trim().toLowerCase()
  return props.logs.filter((l) => {
    if (level.value !== 'all' && l.level !== level.value) return false
    if (kw && !l.msg.toLowerCase().includes(kw)) return false
    return true
  })
})

const fmtTime = (t) => {
  const d = new Date(t)
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, '0')).join(':')
    + '.' + String(d.getMilliseconds()).padStart(3, '0')
}

// 新增日志时滚到底（只在用户没往上翻时）
watch(() => props.logs.length, async () => {
  if (!follow.value || !box.value) return
  await nextTick()
  box.value.scrollTop = box.value.scrollHeight
})

function onScroll() {
  const el = box.value
  if (!el) return
  // 距底部 30px 内视为"跟随"
  follow.value = el.scrollHeight - el.scrollTop - el.clientHeight < 30
}

async function copyAll() {
  const text = shown.value.map((l) => `[${fmtTime(l.t)}] ${l.level.toUpperCase()}  ${l.msg}`).join('\n')
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

const copied = ref(false)
async function doCopy() {
  copied.value = await copyAll()
  setTimeout(() => { copied.value = false }, 1800)
}

function download() {
  const text = shown.value.map((l) => `[${fmtTime(l.t)}] ${l.level.toUpperCase()}  ${l.msg}`).join('\n')
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `analysis-log-${Date.now()}.txt`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}
</script>

<template>
  <div class="card">
    <div class="card-head">
      <h2>{{ title }}</h2>
      <span class="hint">
        共 {{ logs.length }} 条
        <template v-if="level !== 'all' || filter"> · 显示 {{ shown.length }} 条</template>
      </span>
    </div>

    <div v-if="!compact" class="toolbar">
      <div class="segmented">
        <button
          v-for="l in LEVELS" :key="l.id"
          :class="{ on: level === l.id }"
          @click="level = l.id"
        >
          {{ l.label }}
          <template v-if="l.id !== 'all' && counts[l.id]">({{ counts[l.id] }})</template>
        </button>
      </div>

      <input v-model="filter" class="input search" placeholder="搜索日志内容…" spellcheck="false" />

      <button class="btn btn-sm" :class="{ 'btn-primary': follow }"
        :title="follow ? '已开启自动滚动' : '已暂停自动滚动'"
        @click="follow = !follow">
        {{ follow ? '自动滚动' : '已暂停' }}
      </button>
      <button class="btn btn-sm" @click="doCopy">{{ copied ? '已复制' : '复制' }}</button>
      <button class="btn btn-sm" @click="download">下载</button>
      <button v-if="logs.length" class="btn btn-sm btn-danger" @click="emit('clear')">清空</button>
    </div>

    <div ref="box" class="logpanel" :style="{ maxHeight: height + 'px' }" @scroll="onScroll">
      <div v-if="!shown.length" class="empty" style="padding: 26px 16px">
        {{ logs.length ? '没有匹配的日志' : '还没有日志。运行一次分析后，这里会显示完整的搜索过程。' }}
      </div>
      <div v-for="l in shown" :key="l.id" class="lg" :class="'lg-' + l.level">
        <span class="t">{{ fmtTime(l.t) }}</span>
        <span class="m">{{ l.msg }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
  flex-wrap: wrap;
  background: var(--surface-2);
}

.search {
  flex: 1;
  min-width: 150px;
  max-width: 300px;
  font-size: 12px;
  padding: 5px 9px;
}

.logpanel {
  overflow: auto;
  border: none;
  border-radius: 0;
  background: var(--code-bg);
  padding: 8px 0;
}
</style>
