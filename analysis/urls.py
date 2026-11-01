"""analysis 应用的路由。

本站是**多页站点（MPA）**：每个页面一条路由、一个模板、一个前端入口，
页面之间整页跳转。旧的「catch-all 一律回 SPA 外壳」已经废弃 ——
那条规则让每个地址都返回同一份 HTML，既不是独立页面，也让 404 变成了 200。

路由分三层：
1. 页面层 —— 由 `pages.py` 的注册表逐条生成（一个页面一条，不合并）
2. 接口层 —— `/api/**`，只返回 JSON
3. 兜底层 —— 其余一律 404（**真的返回 404 状态码**，不是回壳）
"""

from django.urls import path, re_path

from . import views
from .pages import PAGES

app_name = 'analysis'

urlpatterns = [
    # ── 页面层：一个页面一条路由、一个模板、一个 Vite 入口 ──
    # 顺序无关（都是精确路径），但保持注册表顺序，读起来和 pages.py 对得上。
    *[
        path(page.url, views.make_page_view(page), name=page.key)
        for page in PAGES
    ],

    # ── 运维层 ──
    path('health/', views.health, name='health'),
    # 图标兜底：只有没声明 <link rel="icon"> 的客户端才会走到这里
    path('favicon.ico', views.favicon, name='favicon'),

    # ── 接口层 ──
    path('api/csrf/', views.csrf, name='csrf'),
    path('api/sboxes/', views.sbox_list, name='sbox-list'),
    path('api/sboxes/<int:pk>/', views.sbox_detail, name='sbox-detail'),

    # BCA 差分路径搜索后端。跑在 WSL 里（Django 侧经本地子进程调用），
    # 所以 Windows 原生起服务时这两个接口会明确报「需要 Linux」，不是静默失败。
    path('api/bca/status/', views.bca_status, name='bca-status'),
    path('api/bca/run/', views.bca_run, name='bca-run'),
    # 运行中的进度。**必须写在下面的兜底路由之前**，否则会被它吃掉。
    path('api/bca/progress/', views.bca_progress, name='bca-progress'),

    # ── 兜底层 ──
    # 只接**以斜杠结尾**的未知地址，另有两点讲究：
    #   · 排除真实存在的后端前缀，否则 /api/nope/ 会返回 HTML 而不是 JSON 404；
    #   · 要求尾斜杠，是为了把 `/ciphers` 这类无斜杠写法留给 CommonMiddleware 的
    #     APPEND_SLASH 去 301（它只在"没有任何 pattern 匹配"时才动手，
    #     而我们这条能匹配一切 —— 所以必须主动让路）。
    re_path(
        r'^(?P<path>(?!api/|health/|admin/|static/|media/).*/)$',
        views.page_not_found,
        name='not-found',
    ),
]
