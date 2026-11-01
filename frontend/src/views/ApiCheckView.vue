<script setup>
import { onMounted, ref } from 'vue'

const TARGETS = [
  { path: '/health/', desc: '健康检查' },
  { path: '/api/sboxes/', desc: 'S 盒列表接口' },
  { path: '/api/csrf/', desc: 'CSRF token 发放' },
  { path: '/admin/login/', desc: 'SimpleUI 后台登录页' },
]

const rows = ref(TARGETS.map((t) => ({ ...t, state: 'pending', status: null, type: '', size: 0, preview: '' })))
const running = ref(false)

async function probe(row) {
  row.state = 'pending'
  row.status = null
  row.type = ''
  row.size = 0
  row.preview = ''
  try {
    const res = await fetch(row.path, { credentials: 'same-origin' })
    const text = await res.text()
    row.status = res.status
    row.type = res.headers.get('content-type') || '—'
    row.size = new Blob([text]).size
    row.preview = text.slice(0, 300).replace(/\s+/g, ' ').trim()
    row.state = res.ok ? 'ok' : 'fail'
  } catch (err) {
    row.state = 'error'
    row.preview = err.message
  }
}

async function runAll() {
  running.value = true
  for (const row of rows.value) {
    await probe(row)
  }
  running.value = false
}

onMounted(runAll)
</script>

<template>
  <div>
    <div class="head">
      <div>
        <h2 class="section-title">接口自检</h2>
        <p class="section-desc">
          在浏览器里直接探测后端各条通路。这个页面走的是真实网络请求，能反映前端实际访问时的状态，
          比在服务器上 curl 更有参考价值。
        </p>
      </div>
      <button class="btn btn-primary" :disabled="running" @click="runAll">
        {{ running ? '探测中…' : '重新探测' }}
      </button>
    </div>

    <div class="card">
      <table class="table">
        <thead>
          <tr>
            <th style="width: 60px">状态</th>
            <th style="width: 190px">路径</th>
            <th style="width: 190px">Content-Type</th>
            <th style="width: 90px">大小</th>
            <th>响应片段</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.path">
            <td>
              <span v-if="row.state === 'pending'" class="tag">…</span>
              <span v-else-if="row.state === 'ok'" class="tag tag-ok">{{ row.status }}</span>
              <span v-else class="tag tag-err">{{ row.status || 'ERR' }}</span>
            </td>
            <td>
              <div class="mono" style="font-size: 12px">{{ row.path }}</div>
              <div class="muted" style="font-size: 11.5px">{{ row.desc }}</div>
            </td>
            <td class="mono" style="font-size: 11.5px">{{ row.type || '—' }}</td>
            <td class="num" style="font-size: 12px">{{ row.size ? row.size + ' B' : '—' }}</td>
            <td>
              <div class="preview mono">{{ row.preview || '—' }}</div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="alert alert-info" style="margin-top: 16px">
      <strong>为什么这页有意义：</strong>
      它区分了「后端跑着」和「浏览器能连上」。如果你在这里看到全部 200，就说明前端构建产物、
      Django 路由、静态资源托管、CSRF 中间件这几条链路都是通的。
    </div>
  </div>
</template>

<style scoped>
.head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.preview {
  max-width: 460px;
  color: var(--text-muted);
  font-size: 11.5px;
  line-height: 1.5;
  word-break: break-all;
}
</style>
