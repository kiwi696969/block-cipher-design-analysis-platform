/**
 * 深浅主题管理。
 *
 * 实现方式：把主题名写到 <html data-theme="..."> 上，
 * 全部配色由 main.css 里的 CSS 变量切换 —— 组件里不要出现硬编码颜色，
 * 否则切到深色就会出现"白底白字"这类问题。
 *
 * 默认策略：`?theme=` 查询参数 → 用户上次的选择（localStorage）
 * → 跟随系统 prefers-color-scheme → 兜底浅色。
 *
 * 为什么要有 `?theme=` 这一条：纯靠 localStorage 的话，无头浏览器
 * 每次都是干净档案 → 永远只能验证浅色模式，**深色模式没法自动验证**。
 * 加了 URL 参数之后 `--dump-dom "...?theme=dark"` 就能拿到深色渲染结果，
 * 顺便也让用户能把"深色版"链接直接分享给别人。
 */

import { ref, computed } from 'vue'

const STORAGE_KEY = 'cda_theme'

export const THEMES = [
  { id: 'light', label: '浅色', icon: 'sun' },
  { id: 'dark', label: '深色', icon: 'moon' },
]

export const theme = ref('light')

export const isDark = computed(() => theme.value === 'dark')

/** 把主题写到 DOM 上。CSS 变量是按 [data-theme] 分组的，改这一个属性即可全局生效。 */
function paint(id) {
  const root = document.documentElement
  root.setAttribute('data-theme', id)
  // 让浏览器原生控件（滚动条、表单、日期选择器）也跟着切，避免深色下出现刺眼的白块
  root.style.colorScheme = id === 'dark' ? 'dark' : 'light'
}

export function setTheme(id, { persist = true } = {}) {
  const next = THEMES.some((t) => t.id === id) ? id : 'light'
  theme.value = next
  paint(next)
  if (persist) {
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      /* 隐私模式下 localStorage 可能不可用，静默降级即可 */
    }
  }
}

export function toggleTheme() {
  setTheme(theme.value === 'dark' ? 'light' : 'dark')
}

/** 应用启动时调用一次。返回实际生效的主题。 */
export function initTheme() {
  // 1) URL 参数优先 —— 便于分享指定主题的链接，也让无头验证能测到深色
  let fromUrl = ''
  try {
    fromUrl = new URLSearchParams(window.location.search).get('theme') || ''
  } catch {
    fromUrl = ''
  }
  if (THEMES.some((t) => t.id === fromUrl)) {
    setTheme(fromUrl)
    // 用后即从地址栏抹掉，避免之后手动切主题时"地址栏和实际不一致"的困惑
    try {
      const u = new URL(window.location.href)
      u.searchParams.delete('theme')
      window.history.replaceState({}, '', u.pathname + u.search + u.hash)
    } catch { /* 非关键路径，失败不影响功能 */ }
    return theme.value
  }

  // 2) 用户上次的选择
  let saved = ''
  try {
    saved = localStorage.getItem(STORAGE_KEY) || ''
  } catch {
    saved = ''
  }

  if (THEMES.some((t) => t.id === saved)) {
    setTheme(saved, { persist: false })
    return theme.value
  }

  // 3) 跟随系统
  let prefersDark = false
  try {
    prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)')?.matches === true
  } catch {
    prefersDark = false
  }

  setTheme(prefersDark ? 'dark' : 'light', { persist: false })
  return theme.value
}
