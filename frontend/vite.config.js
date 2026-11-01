import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

/**
 * 多页站点（MPA）的构建配置。
 *
 * 本平台**不是单页应用**：每个页面有自己的 HTML 根文件与入口脚本，
 * 页面之间是整页跳转，没有客户端路由。
 * 下面这份清单必须与 src/pages.js、analysis/pages.py 一一对应。
 */
const PAGES = [
  'index',
  'ciphers',
  'structure',
  'differential',
  'linear',
  'bca',
  'results',
  'logs',
  'sbox',
  'sbox-detail',
  'tutorial',
  'check',
  '404',
]

/** URL 里的干净路径 → 构建入口名（开发态用，产物态由 Django 路由负责） */
function entryForPath(pathname) {
  const clean = pathname.replace(/\/+$/, '') || '/'
  if (clean === '/') return 'index'
  // 动态详情页：/sbox/3 → sbox-detail.html
  if (/^\/sbox\/[^/]+$/.test(clean)) return 'sbox-detail'
  const name = clean.replace(/^\//, '')
  return PAGES.includes(name) ? name : null
}

/**
 * 开发态让 Vite 也认 `/ciphers/` 这种干净 URL。
 * 不加这个中间件，开发时只能手输 `/ciphers.html`，
 * 和线上（Django 的路由）表现不一致，容易埋雷。
 */
function cleanUrls() {
  return {
    name: 'cipher-clean-urls',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const [pathname, search] = String(req.url || '/').split('?')
        const entry = entryForPath(pathname)
        if (entry && !pathname.endsWith('.html')) {
          req.url = `/${entry}.html${search ? `?${search}` : ''}`
        }
        next()
      })
    },
  }
}

// 说明：开发态由 Vite 自己伺服（base=/），产物态交给 Django 托管（base=/static/dist/）。
// 两种形态共用一个 src/，不需要改代码。
export default defineConfig(({ command }) => ({
  plugins: [vue(), cleanUrls()],

  base: command === 'build' ? '/static/dist/' : '/',

  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },

  build: {
    // 直接产出到 Django 的静态目录，collectstatic 时会被一并收走
    outDir: '../static/dist',
    emptyOutDir: true,
    // 生成 .vite/manifest.json —— Django 的 vite_assets 标签靠它找到带哈希的文件名
    manifest: true,
    assetsDir: 'assets',
    sourcemap: false,
    rollupOptions: {
      // 每个页面一个入口；页面共享的代码（引擎、样式）会被 Rollup 自动提成公共 chunk
      input: Object.fromEntries(
        PAGES.map((name) => [name, fileURLToPath(new URL(`./${name}.html`, import.meta.url))]),
      ),
    },
  },

  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    open: false,
    // 开发态把后端请求转发给 Django:8011，前端代码里一律写相对路径
    proxy: {
      '/api': { target: 'http://127.0.0.1:8011', changeOrigin: false },
      '/health': { target: 'http://127.0.0.1:8011', changeOrigin: false },
      '/admin': { target: 'http://127.0.0.1:8011', changeOrigin: false },
      '/static': { target: 'http://127.0.0.1:8011', changeOrigin: false },
    },
  },
}))
