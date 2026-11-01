/**
 * 页面注册表 —— 「本站有哪些页面」的唯一声明。
 *
 * 本平台是**多页站点（MPA）**，不是单页应用。每个页面各有三样东西，
 * 三处必须一一对应，靠的就是这份清单：
 *
 *   ① HTML 根文件   frontend/<html>            （Vite 的构建入口）
 *   ② 入口脚本      src/entries/<key>.js       （挂载哪一个根视图）
 *   ③ 服务端路由    analysis/pages.py 的同名 key（返回哪一个模板）
 *
 * 所以「加一个页面」= 改三处，缺一处页面就是死链。test:e2e 里有断言盯着这件事。
 *
 * 字段：
 *   key    页面标识，与 entries/<key>.js、analysis/pages.py 的 key 完全一致
 *   path   浏览器地址。**一律带尾斜杠**（Django 的 APPEND_SLASH 会把老的无斜杠链接 301 过来）
 *   html   Vite 构建入口文件名
 *   title  浏览器标题
 *   icon   App.vue 里的图标名
 *   nav    是否出现在顶部导航
 *   navKey 顶部导航高亮归属，缺省为自身（详情页要高亮它所属的列表页）
 *   mode   仅分析类页面用：告诉视图当前是差分还是线性
 */

export const SITE_NAME = '密码算法分析系统'

export const PAGES = [
  {
    key: 'home',
    path: '/',
    html: 'index.html',
    title: '首页',
    icon: 'home',
    nav: true,
  },
  {
    key: 'ciphers',
    path: '/ciphers/',
    html: 'ciphers.html',
    title: '算法选择',
    icon: 'cube',
    nav: true,
  },
  {
    key: 'structure',
    path: '/structure/',
    html: 'structure.html',
    title: '结构编辑',
    icon: 'blocks',
    nav: true,
  },
  {
    key: 'differential',
    path: '/differential/',
    html: 'differential.html',
    title: '差分分析',
    icon: 'delta',
    nav: true,
    mode: 'differential',
  },
  {
    key: 'linear',
    path: '/linear/',
    html: 'linear.html',
    title: '线性分析',
    icon: 'wave',
    nav: true,
    mode: 'linear',
  },
  {
    // 服务器端搜索（BCA_Light + kissat）：能推到浏览器引擎算不动的轮数。
    // 紧跟在两个浏览器内分析页后面 —— 三者是同一件事（找差分/线性路径）的三种口径。
    key: 'bca',
    path: '/bca/',
    html: 'bca.html',
    title: '后端搜索',
    icon: 'cpu',
    nav: true,
  },
  {
    key: 'results',
    path: '/results/',
    html: 'results.html',
    title: '结果与指标',
    icon: 'chart',
    nav: true,
  },
  {
    key: 'logs',
    path: '/logs/',
    html: 'logs.html',
    title: '运行日志',
    icon: 'terminal',
    nav: true,
  },
  {
    key: 'sbox',
    path: '/sbox/',
    html: 'sbox.html',
    title: 'S 盒库',
    icon: 'table',
    nav: true,
  },
  {
    // 详情页：路径带参数，服务端也只认这一条路由（id 由前端从地址里解析）
    key: 'sbox-detail',
    path: '/sbox/:id/',
    html: 'sbox-detail.html',
    title: 'S 盒详情',
    icon: 'table',
    nav: false,
    navKey: 'sbox',
  },
  {
    key: 'tutorial',
    path: '/tutorial/',
    html: 'tutorial.html',
    title: '初学者教程',
    icon: 'book',
    nav: true,
  },
  {
    // 运维自检页：不进导航，但同样是一个独立页面（有独立根文件与路由）
    key: 'check',
    path: '/check/',
    html: 'check.html',
    title: '接口自检',
    icon: 'terminal',
    nav: false,
  },
  {
    // 404：没有 path，由服务端兜底路由返回，HTTP 状态码是真 404
    key: 'not-found',
    path: '',
    html: '404.html',
    title: '页面不存在',
    icon: 'home',
    nav: false,
  },
]

/** 顶部导航条目（顺序即显示顺序） */
export const NAV = PAGES.filter((p) => p.nav)

const BY_KEY = new Map(PAGES.map((p) => [p.key, p]))

export function pageByKey(key) {
  return BY_KEY.get(key) || BY_KEY.get('home')
}

/** 顶部导航里应当高亮哪一项 */
export function navKeyOf(key) {
  const p = BY_KEY.get(key)
  return p ? (p.navKey || p.key) : ''
}

/**
 * 生成站内链接。
 *   href('sbox-detail', { id: 3 }) → '/sbox/3/'
 */
export function href(key, params = {}) {
  const p = BY_KEY.get(key)
  if (!p || !p.path) return '/'
  return p.path.replace(/:([a-zA-Z_][\w]*)/g, (whole, name) => (
    params[name] === undefined || params[name] === null
      ? whole
      : encodeURIComponent(String(params[name]))
  ))
}

/**
 * 程序化跳转（等价于点一个站内链接）。
 *
 * ⚠️ 视图的模板里**不能**直接写 `window.location.assign(...)` ——
 * Vue 模板表达式的作用域里没有 `window`，编译出来会变成 `_ctx.window` → undefined，
 * 点击时报 "window is not a function / cannot read property of undefined"。
 * 需要跳转就调这个函数。
 */
export function go(key, params = {}) {
  window.location.assign(href(key, params))
}

/** 当前页面是不是 404 之外的某个已知 key */
export function isKnownKey(key) {
  return BY_KEY.has(key) && key !== 'not-found'
}

/**
 * 用地址栏路径反查页面。
 *   matchPath('/sbox/3/') → { key: 'sbox-detail', params: { id: '3' } }
 * 只用于需要读路径参数的页面（如详情页）；其余页面由服务端直接把 key 给到模板。
 */
export function matchPath(pathname) {
  // 先归一到「恰好一个尾斜杠」的形式，这样 /sbox/3 与 /sbox/3/ 都认
  const body = String(pathname || '').replace(/^\/+/, '').replace(/\/+$/, '')
  const clean = body ? `/${body}/` : '/'
  for (const p of PAGES) {
    if (!p.path) continue
    if (!p.path.includes(':')) {
      if (p.path === clean) return { key: p.key, params: {} }
      continue
    }
    const names = []
    const rx = new RegExp('^' + p.path.replace(/:([a-zA-Z_][\w]*)/g, (w, n) => {
      names.push(n)
      return '([^/]+)'
    }) + '$')
    const m = clean.match(rx)
    if (m) {
      const params = {}
      names.forEach((n, i) => { params[n] = decodeURIComponent(m[i + 1]) })
      return { key: p.key, params }
    }
  }
  return { key: 'not-found', params: {} }
}
