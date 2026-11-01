/**
 * 页面挂载器 —— 所有入口脚本共用的一段启动逻辑。
 *
 * 每个 HTML 根文件只做一件事：加载自己的入口脚本，
 * 入口脚本调用本函数，把「我是谁（pageKey）」和「我渲染哪个根视图」交给它。
 *
 * 与旧单页形态的区别（重要）：
 *   旧：一个 index.html + Vue Router，路由在前端切，页面不刷新。
 *   新：每个页面一个 HTML，浏览器整页跳转，**没有客户端路由**。
 *
 * 因此这里有两件事必须做对：
 *   1. `initTheme()` 要在挂载前跑 —— 主题存 localStorage，跨页沿用，
 *      晚一步深色用户会看到一瞬白屏。
 *   2. platform.js 的**副作用导入**不能省 —— 引擎通过
 *      `globalThis.__SBOX_LIB__` 取 S 盒，少这一句任何分析都报「找不到 S 盒」。
 *      多页形态下每个页面都会重新执行一次，反而是好事（状态从 sessionStorage 恢复）。
 */

import { createApp } from 'vue'

import RootShell from '@/App.vue'
import { initTheme } from '@/stores/theme.js'
import { bootstrapCsrf } from '@/api/client'
// 导入 store 的同时也实例化了 S 盒库（挂到 globalThis.__SBOX_LIB__）
import { syncSboxesFromServer } from '@/stores/platform.js'
import '@/styles/main.css'

/**
 * 给启动步骤套一个时间上限。
 *
 * 启动期的等待必须有天花板：后端卡住（不是拒绝连接、是挂着不回）时
 * `fetch` 会一直 pending，页面就永远挂载不出来 —— 那是比功能缺失更糟的失败。
 * 超时按"这一步没成功"处理，功能降级，页面照常渲染。
 */
function withinBudget(promise, ms, fallback) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
  ])
}

/**
 * 挂载一个页面。
 *
 * @param {string} pageKey  页面标识，必须与 src/pages.js 的 key 一致
 * @param {object} view     该页面的根视图组件
 * @param {object} props    传给根视图的 props（如详情页的 id、分析页的 mode）
 */
export function mountPage(pageKey, view, props = {}) {
  initTheme()

  const app = createApp(RootShell, {
    pageKey,
    view,
    viewProps: props,
  })

  // 挂载前必须完成两件事：
  //
  //   1. **拿到 CSRF token** —— 否则首个写请求会被 403 挡掉。
  //   2. **把服务端的 S 盒拉进前端 S 盒库** —— 结构编辑器的 S 盒下拉是在
  //      渲染时就取好的（`computed` 里同步读 `sboxLib.list()`），挂载后再拉
  //      就来不及，用户会看到"我在 S 盒库页导入的盒子在画布里选不到"。
  //      这正是这次要修的问题，所以同步必须挡在挂载之前。
  //
  // 两者都带时间上限：任一环节卡住也要把页面渲染出来（降级而非白屏）。
  Promise.all([
    withinBudget(bootstrapCsrf(), 3000, ''),
    withinBudget(syncSboxesFromServer(), 2000, { total: 0, skipped: 0, previous: 0 }),
  ]).finally(() => app.mount('#app'))
}
