/**
 * 后端接口封装。
 *
 * 关键点：Django 的 CsrfViewMiddleware 会拦截所有非安全的跨站请求。
 * 单页应用没有表单里那个隐藏的 csrfmiddlewaretoken，所以走
 * 「先取 token（/api/csrf/，服务端会顺带 Set-Cookie）→ 每个写请求带 X-CSRFToken 头」这条路。
 */

let csrfToken = ''

/** 从 document.cookie 里读一个值（Django 默认的 csrftoken 不是 HttpOnly）。 */
export function getCookie(name) {
  const match = document.cookie.match(new RegExp('(^|;\\s*)' + name + '=([^;]*)'))
  return match ? decodeURIComponent(match[2]) : ''
}

/** 启动时调用一次，把 CSRF token 取到内存里。失败也不阻塞应用启动。 */
export async function bootstrapCsrf() {
  try {
    const res = await fetch('/api/csrf/', {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    })
    if (res.ok) {
      const data = await res.json()
      csrfToken = data.csrfToken || getCookie('csrftoken')
      return csrfToken
    }
  } catch (err) {
    // 后端没起来时静默降级：页面仍然能渲染，只是写操作会失败。
    console.warn('[csrf] 获取失败，写操作可能被拒绝：', err.message)
  }
  csrfToken = getCookie('csrftoken')
  return csrfToken
}

const SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS', 'TRACE']

/** 统一的 fetch 包装：自动带 CSRF、自动解析 JSON、非 2xx 抛错。 */
export async function apiFetch(path, options = {}) {
  const method = (options.method || 'GET').toUpperCase()
  const headers = { Accept: 'application/json', ...(options.headers || {}) }

  if (!SAFE_METHODS.includes(method)) {
    headers['X-CSRFToken'] = csrfToken || getCookie('csrftoken')
    if (options.body && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json'
    }
  }

  const res = await fetch(path, { credentials: 'same-origin', ...options, headers })

  const text = await res.text()
  let data = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = text
    }
  }

  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} ${res.statusText}`)
    err.status = res.status
    err.data = data
    throw err
  }
  return data
}

export const api = {
  csrf: () => apiFetch('/api/csrf/'),
  health: () => apiFetch('/health/'),
  // full=true → 列表里附上完整的 table_hex。S 盒库启动同步用这个，
  // 否则要对着每条记录再打一次详情接口。
  listSboxes: (full = false) => apiFetch(`/api/sboxes/${full ? '?full=1' : ''}`),
  getSbox: (id) => apiFetch(`/api/sboxes/${id}/`),
  createSbox: (payload) =>
    apiFetch('/api/sboxes/', { method: 'POST', body: JSON.stringify(payload) }),
  deleteSbox: (id) => apiFetch(`/api/sboxes/${id}/`, { method: 'DELETE' }),

  // BCA_Light 差分路径搜索后端。
  // 注意：**执行结果一律走 HTTP 200**，成败看响应里的 `ok` 字段。
  // 只有「请求参数本身不合法」才 400 —— 那样 apiFetch 会抛错，body 在 err.data 里。
  // 这样设计是为了让"超时 / 后端没装好"这类现场常见情况也能把诊断信息读全。
  bcaStatus: (refresh = false) => apiFetch(`/api/bca/status/${refresh ? '?refresh=1' : ''}`),
  bcaRun: (payload) =>
    apiFetch('/api/bca/run/', { method: 'POST', body: JSON.stringify(payload) }),
  // 运行中的进度：读该任务已落盘的 results.csv，不跑搜索、不起子进程。
  // 它必须能与「还没返回的 bcaRun POST」并存 —— 后端那条路径不碰求解器，
  // 也不与搜索共享锁（runserver 是多线程的）。
  bcaProgress: ({ task, cipher, model }) =>
    apiFetch('/api/bca/progress/'
      + `?task=${encodeURIComponent(task || '')}`
      + `&cipher=${encodeURIComponent(cipher || '')}`
      + `&model=${encodeURIComponent(model || '')}`),
}
