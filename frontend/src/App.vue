<script setup>
/**
 * 页面外壳（RootShell）。
 *
 * 多页形态下它不再是「单页应用的外框 + 路由出口」，
 * 而是一个被每个页面独立复用的**工作台骨架**。改版后它的三段是：
 *
 *   ① 左侧竖栏   品牌 + 分组导航 + 全局动作（导入/导出/主题）
 *   ② 上下文条   常驻显示"现在在算什么"：算法 / 模板 / 结构 / 轮数 / 最近结果
 *   ③ 底部状态栏 状态 · 日志条数 · 当前页面标识
 *
 * 为什么导航从顶部横条挪到左侧竖栏：
 *   · 页面长到 10 个之后，横向标签条只能靠缩写和图标硬塞，看不出分组；
 *   · 竖栏天然能分组（建模 / 分析 / 数据 / 参考），主内容区也不再被
 *     导航挤掉宽度 —— 分析页的参数栏 + 结果区本来就吃宽度。
 *
 * ⚠️ 两条不能动的契约：
 *   1. 导航容器必须保持 `<nav class="nav">` 且每一项是 `<a>` ——
 *      E2E 的 `navTo()` 就是靠 `nav.nav a` 定位的。
 *   2. 每一项的可见文本必须与 pages.js 的 title 一致（结果 / 教程 / 差分分析…）。
 *
 * 每个页面在挂载时把自己的 pageKey 和根视图组件交给它（见 src/entries/boot.js），
 * 页面之间的跳转是**原生整页跳转**（<a href>），没有客户端路由。
 */
import { computed, ref } from 'vue'

import { toggleTheme, isDark } from '@/stores/theme.js'
import {
  status, logs, result, templateId, graph, mode,
  exportProject, importProject, downloadJSON, log,
} from '@/stores/platform.js'
import { NAV, SITE_NAME, href, navKeyOf, pageByKey } from '@/pages.js'

const props = defineProps({
  /** 当前页面标识（src/pages.js 的 key） */
  pageKey: { type: String, required: true },
  /** 当前页面的根视图组件 */
  view: { type: [Object, Function], required: true },
  /** 传给根视图的 props */
  viewProps: { type: Object, default: () => ({}) },
})

const ICONS = {
  home: 'M3 10.5 12 3l9 7.5M5.5 9.5V20h13V9.5M10 20v-5h4v5',
  cube: 'M12 2.8 21 7.5v9L12 21.2 3 16.5v-9L12 2.8zM3 7.5l9 4.6 9-4.6M12 12.1V21',
  blocks: 'M3.5 3.5h7v7h-7zM13.5 3.5h7v7h-7zM3.5 13.5h7v7h-7zM13.5 13.5h7v7h-7z',
  delta: 'M3 19h18M6 19 12 5l6 14M8.6 13.5h6.8',
  wave: 'M2.5 12h4l2-6.5 3.4 13L15 12h6.5',
  cpu: 'M9 9h6v6H9zM6.5 6.5h11v11h-11zM9.5 3v3.5M14.5 3v3.5M9.5 17.5V21M14.5 17.5V21M3 9.5h3.5M3 14.5h3.5M17.5 9.5H21M17.5 14.5H21',
  chart: 'M4 20V9M9.5 20V4M15 20v-8M20.5 20v-12',
  terminal: 'M3 4.5h18v15H3zM7 9.5l3 3-3 3M13 15.5h4',
  table: 'M3.5 4.5h17v15h-17zM3.5 10h17M9.5 4.5v15M3.5 15h17',
  book: 'M4 4.5h6a3 3 0 013 3v12a2.5 2.5 0 00-2.5-2.5H4zM20 4.5h-6a3 3 0 00-3 3v12a2.5 2.5 0 012.5-2.5H20z',
  sun: 'M12 6.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM12 1.5v2M12 20.5v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1.5 12h2M20.5 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4',
  moon: 'M20.5 14.3A8.7 8.7 0 019.7 3.5a8.7 8.7 0 1010.8 10.8z',
  download: 'M12 3.5v11M7.5 10.5l4.5 4.5 4.5-4.5M4 19.5h16',
  upload: 'M12 15.5v-11M7.5 8.5L12 4l4.5 4.5M4 19.5h16',
}

/* ---------------------------------------------------------------- 导航分组 */

/**
 * 侧栏分组。
 *
 * 只声明"哪些 key 归哪一组" —— 顺序、路径、标题一律从 pages.js 取，
 * 不在这里复制一份。这样加页面时只要在 pages.js 里写一次，
 * 标题改了这里也不会不同步。
 */
const NAV_GROUPS = [
  { title: '工作流', keys: ['home', 'ciphers', 'structure'] },
  { title: '分析', keys: ['differential', 'linear', 'bca'] },
  { title: '数据', keys: ['results', 'sbox', 'logs'] },
  { title: '参考', keys: ['tutorial'] },
]

/**
 * 把 NAV 按上面的分组切好，并**兜住漏网的项**：
 * 新加的页面如果忘了写进 NAV_GROUPS，会自动落进「其他」组，
 * 而不是从侧栏里凭空消失（那是最难查的一类 bug）。
 */
const navGroups = computed(() => {
  const used = new Set()
  const groups = NAV_GROUPS.map((g) => {
    const items = g.keys
      .map((k) => NAV.find((p) => p.key === k))
      .filter(Boolean)
    items.forEach((p) => used.add(p.key))
    return { title: g.title, items }
  }).filter((g) => g.items.length)

  const rest = NAV.filter((p) => !used.has(p.key))
  if (rest.length) groups.push({ title: '其他', items: rest })
  return groups
})

/**
 * 高亮归属：详情页（/sbox/3/）要让它的列表页（S 盒库）亮起来。
 * 规则来自 pages.js 的 navKey，不在这里重写一份。
 */
const activeNavKey = computed(() => navKeyOf(props.pageKey))

const siteName = SITE_NAME

/* ---------------------------------------------------------------- 上下文条 */

/** 当前工作上下文：现在在算什么。全站常驻，切页面不丢。 */
const context = computed(() => {
  const meta = graph.value?.meta || {}
  return [
    { k: '算法', v: meta.name || '未选择', mono: false },
    { k: '模板', v: templateId.value || '—', mono: true },
    { k: '结构', v: meta.structure === 'feistel' ? 'Feistel' : 'SPN', mono: false },
    { k: '轮数', v: meta.rounds ? String(meta.rounds) : '—', mono: true },
    { k: '模式', v: mode.value === 'linear' ? '线性' : '差分', mono: false },
  ]
})

const currentPage = computed(() => pageByKey(props.pageKey))

/* ---------------------------------------------------------------- 状态 */

const statusMap = {
  idle: { text: '待运行', cls: 'tag' },
  running: { text: '运行中', cls: 'tag tag-accent' },
  done: { text: '已完成', cls: 'tag tag-ok' },
  error: { text: '出错', cls: 'tag tag-err' },
  aborted: { text: '已中止', cls: 'tag tag-warn' },
}

const statusInfo = computed(() => statusMap[status.value] || statusMap.idle)

const resultBadge = computed(() => {
  const w = result.value?.metrics?.weight
  if (w === undefined || w === null) return ''
  return `−log₂p = ${w.toFixed(2)}`
})

const logCount = computed(() => logs.value.length)

/* ---------------------------------------------------------------- 导入 / 导出 */

const fileInput = ref(null)
const notice = ref('')
const noticeKind = ref('ok')

function flash(text, kind = 'ok') {
  notice.value = text
  noticeKind.value = kind
  setTimeout(() => { notice.value = '' }, 4200)
}

function doExport() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const name = `${templateId.value || 'cipher'}-${stamp}.json`
  downloadJSON(exportProject(), name)
  flash(`已导出 ${name}`)
}

function pickFile() {
  fileInput.value?.click()
}

async function onFile(e) {
  const f = e.target.files?.[0]
  e.target.value = '' // 允许连续导入同一个文件
  if (!f) return
  try {
    const text = await f.text()
    importProject(JSON.parse(text))
    flash(`已导入 ${f.name}`)
    // 多页站点：整页跳到结构编辑页（工程数据已写进 localStorage/sessionStorage）
    window.location.assign(href('structure'))
  } catch (err) {
    flash(`导入失败：${err.message}`, 'err')
    log('error', `导入工程失败：${err.message}`)
  }
}
</script>

<template>
  <div class="shell">
    <!-- ============================================================ 左侧竖栏 -->
    <aside class="side">
      <a :href="href('home')" class="brand">
        <span class="brand-mark">
          <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
            <path d="M12 3l8 3v6c0 4.5-3.2 8.3-8 9.5C7.2 20.3 4 16.5 4 12V6l8-3z"
              fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" />
            <path d="M9 12l2 2 4-4" fill="none" stroke="currentColor"
              stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </span>
        <span class="brand-text">
          <strong>{{ siteName }}</strong>
          <small>Cipher Analysis Platform</small>
        </span>
      </a>

      <nav class="nav">
        <div v-for="g in navGroups" :key="g.title" class="nav-group">
          <div class="nav-group-title">{{ g.title }}</div>
          <a
            v-for="item in g.items"
            :key="item.key"
            :href="href(item.key)"
            class="nav-item"
            :class="{ on: activeNavKey === item.key }"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
              <path :d="ICONS[item.icon]" fill="none" stroke="currentColor" stroke-width="1.7"
                stroke-linecap="round" stroke-linejoin="round" />
            </svg>
            <span class="nav-label">{{ item.title }}</span>
            <i v-if="item.key === 'logs' && logCount" class="dot-badge">{{ logCount > 99 ? '99+' : logCount }}</i>
            <i v-else-if="item.key === 'results' && resultBadge" class="dot-badge on">●</i>
          </a>
        </div>
      </nav>

      <div class="side-foot">
        <div class="side-actions">
          <button class="btn btn-sm" title="导入工程 JSON" @click="pickFile">
            <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
              <path :d="ICONS.upload" fill="none" stroke="currentColor" stroke-width="1.8"
                stroke-linecap="round" stroke-linejoin="round" />
            </svg>
            导入
          </button>
          <button class="btn btn-sm" title="导出工程 JSON（结构 + 参数 + 结果 + 日志）" @click="doExport">
            <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
              <path :d="ICONS.download" fill="none" stroke="currentColor" stroke-width="1.8"
                stroke-linecap="round" stroke-linejoin="round" />
            </svg>
            导出
          </button>
        </div>
        <button class="btn btn-sm btn-ghost side-theme" @click="toggleTheme">
          <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
            <path :d="isDark ? ICONS.sun : ICONS.moon" fill="none" stroke="currentColor"
              stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          {{ isDark ? '浅色主题' : '深色主题' }}
        </button>
        <a :href="href('check')" class="side-link">接口自检</a>
      </div>

      <input ref="fileInput" type="file" accept="application/json,.json"
        style="display: none" @change="onFile" />
    </aside>

    <!-- ============================================================ 主区 -->
    <div class="main">
      <!-- 上下文条：常驻显示"现在在算什么"，切页面不丢 -->
      <header class="ctxbar">
        <span class="ctx-page">{{ currentPage.title }}</span>
        <span class="ctx-sep"></span>
        <span v-for="c in context" :key="c.k" class="ctx-item">
          <span class="ctx-k">{{ c.k }}</span>
          <span class="ctx-v" :class="{ mono: c.mono }">{{ c.v }}</span>
        </span>
        <span class="ctx-spacer"></span>
        <span v-if="resultBadge" class="tag tag-ok">{{ resultBadge }}</span>
        <span :class="statusInfo.cls">{{ statusInfo.text }}</span>
      </header>

      <main class="content">
        <!-- 每个页面挂载的就是自己的根视图，不需要路由分发 -->
        <component :is="view" v-bind="viewProps" />
      </main>

      <!-- 状态栏：工程工具常驻的一条"仪表读数" -->
      <footer class="statusbar">
        <span class="sb-dot" :class="'sb-' + status"></span>
        <span>{{ statusInfo.text }}</span>
        <span class="sb-sep"></span>
        <span>日志 {{ logCount }}</span>
        <span v-if="resultBadge" class="sb-sep"></span>
        <span v-if="resultBadge">{{ resultBadge }}</span>
        <span class="ctx-spacer"></span>
        <span>{{ logCount ? '会话状态已落 sessionStorage' : '会话为空' }}</span>
        <span class="sb-sep"></span>
        <span>page:{{ pageKey }}</span>
      </footer>
    </div>

    <Transition name="fade" appear>
      <div v-if="notice" class="toast" :class="noticeKind === 'err' ? 'toast-err' : 'toast-ok'">
        {{ notice }}
      </div>
    </Transition>
  </div>
</template>

<style scoped>
/* ---------------------------------------------------------------- 骨架 */

.shell {
  display: grid;
  grid-template-columns: 214px minmax(0, 1fr);
  height: 100vh;
  overflow: hidden;
}

.main {
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
}

/* ---------------------------------------------------------------- 竖栏 */

.side {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-right: 1px solid var(--border);
  background: var(--surface);
}

.brand {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
  height: var(--nav-h);
  padding: 0 11px;
  border-bottom: 1px solid var(--border);
  color: inherit;
  text-decoration: none;
}
.brand:hover {
  text-decoration: none;
  background: var(--surface-2);
}

.brand-mark {
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border-radius: var(--radius-sm);
  background: var(--accent);
  color: #fff;
  flex: none;
}

.brand-text {
  display: flex;
  flex-direction: column;
  line-height: 1.15;
  min-width: 0;
}

.brand-text strong {
  font-size: 11.5px;
  font-weight: 650;
  white-space: nowrap;
}

.brand-text small {
  color: var(--text-faint);
  font-size: 9px;
  letter-spacing: 0.03em;
  white-space: nowrap;
}

.nav {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 6px 0 10px;
}

.nav-group + .nav-group {
  margin-top: 6px;
}

.nav-group-title {
  padding: 5px 11px 3px;
  font-size: 9.5px;
  font-weight: 650;
  letter-spacing: 0.1em;
  color: var(--text-faint);
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 5px 11px;
  border-left: 2px solid transparent;
  color: var(--text-muted);
  font-size: 12.5px;
  white-space: nowrap;
  text-decoration: none;
  transition: background 0.12s, color 0.12s, border-color 0.12s;
}

.nav-item:hover {
  background: var(--surface-2);
  color: var(--text);
  text-decoration: none;
}

.nav-item.on {
  border-left-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 650;
}

.nav-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.dot-badge {
  font-family: var(--mono);
  font-size: 9.5px;
  font-style: normal;
  padding: 0 4px;
  border-radius: var(--radius-sm);
  background: var(--surface-3);
  color: var(--text-faint);
  line-height: 14px;
  flex: none;
}

.dot-badge.on {
  background: transparent;
  color: var(--ok);
  font-size: 8px;
}

.side-foot {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 8px 9px;
  border-top: 1px solid var(--border);
  background: var(--surface-2);
}

.side-actions {
  display: flex;
  gap: 5px;
}

.side-actions .btn {
  flex: 1;
}

.side-theme {
  justify-content: flex-start;
  border-color: transparent;
  background: transparent;
}

.side-link {
  font-size: 10.5px;
  color: var(--text-faint);
  padding: 0 2px;
}

/* ---------------------------------------------------------------- 上下文条 */

.ctxbar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: none;
  height: var(--nav-h);
  padding: 0 12px;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
  overflow-x: auto;
  scrollbar-width: none;
}
.ctxbar::-webkit-scrollbar {
  display: none;
}

.ctx-page {
  font-size: 12.5px;
  font-weight: 650;
  white-space: nowrap;
}

.ctx-sep {
  width: 1px;
  height: 14px;
  background: var(--border);
  flex: none;
}

.ctx-item {
  display: inline-flex;
  align-items: baseline;
  gap: 5px;
  white-space: nowrap;
}

.ctx-k {
  font-size: 10.5px;
  color: var(--text-faint);
}

.ctx-v {
  font-size: 11.5px;
  color: var(--text);
}

.ctx-v.mono {
  font-family: var(--mono);
}

.ctx-spacer {
  flex: 1;
  min-width: 8px;
}

/* ---------------------------------------------------------------- 状态栏 */

.statusbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
  height: 22px;
  padding: 0 12px;
  border-top: 1px solid var(--border);
  background: var(--surface-2);
  font-family: var(--mono);
  font-size: 10.5px;
  color: var(--text-faint);
  overflow: hidden;
  white-space: nowrap;
}

.sb-sep {
  width: 1px;
  height: 10px;
  background: var(--border);
  flex: none;
}

.sb-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-faint);
  flex: none;
}
.sb-idle { background: var(--text-faint); }
.sb-running { background: var(--accent); }
.sb-done { background: var(--ok); }
.sb-error { background: var(--err); }
.sb-aborted { background: var(--warn); }

.content {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

/* ---------------------------------------------------------------- 提示 */

.toast {
  position: fixed;
  top: calc(var(--nav-h) + 10px);
  right: 16px;
  z-index: 50;
  padding: 7px 12px;
  border-radius: var(--radius-sm);
  font-size: 12px;
  box-shadow: var(--shadow);
  background: var(--surface);
  max-width: 420px;
}

.toast-ok {
  border: 1px solid var(--ok-border);
  border-left: 3px solid var(--ok);
  color: var(--ok);
}

.toast-err {
  border: 1px solid var(--err-border);
  border-left: 3px solid var(--err);
  color: var(--err);
}

/* ---------------------------------------------------------------- 窄屏 */

/* 竖栏收成图标条：只留图标，靠 title 提示。再窄就整体纵向堆叠。 */
@media (max-width: 1000px) {
  .shell {
    grid-template-columns: 46px minmax(0, 1fr);
  }
  .brand-text,
  .nav-label,
  .nav-group-title,
  .side-actions {
    display: none;
  }
  .brand {
    justify-content: center;
    padding: 0;
  }
  .nav-item {
    justify-content: center;
    padding: 7px 0;
  }
  .side-foot {
    align-items: center;
    padding: 6px 4px;
  }
  .side-theme {
    justify-content: center;
  }
  .side-theme span,
  .side-link {
    display: none;
  }
}

@media (max-width: 720px) {
  .shell {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto minmax(0, 1fr);
  }
  .side {
    flex-direction: row;
    align-items: center;
    border-right: none;
    border-bottom: 1px solid var(--border);
    overflow-x: auto;
  }
  .brand {
    border-bottom: none;
  }
  .nav {
    display: flex;
    padding: 0;
    overflow: visible;
  }
  .nav-group {
    display: flex;
    margin-top: 0 !important;
  }
  .nav-group-title {
    display: none;
  }
  .nav-item {
    border-left: none;
    border-bottom: 2px solid transparent;
    padding: 6px 9px;
  }
  .nav-item.on {
    border-bottom-color: var(--accent);
  }
  .side-foot {
    flex-direction: row;
    border-top: none;
    background: transparent;
  }
}
</style>
