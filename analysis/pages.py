"""页面注册表 —— 服务端的「哪个 URL 返回哪一个页面」。

这是**多页站点（MPA）**，不是单页应用：每个页面有自己的 HTML 根文件、
自己的 Vite 入口、自己的路由。不存在「所有路径都回同一个壳，
由前端路由去分发」这回事（旧方案已废弃）。

一份页面要三处对齐，缺一处这个页面就是死链：

    本文件 key  ←→  frontend/src/pages.js         （前端导航与链接生成）
                ←→  frontend/src/entries/<key>.js （该页面的挂载脚本）
                ←→  frontend/<html>               （Vite 构建入口）

所以「加一个页面」= 改这三处 + 加一个模板，缺一不可。

约定：
- `url` 一律**带尾斜杠**。无斜杠的老链接（如 `/ciphers`）由
  CommonMiddleware 的 APPEND_SLASH 301 过来，不需要额外兼容代码。
- 动态页面（S 盒详情）用 Django 的 `path()` 语法，一条路由接住所有 id；
  id 由前端从地址栏解析（见 frontend/src/entries/sbox-detail.js）。
"""

from dataclasses import dataclass

#: 站点名，同时是 <title> 的后缀
SITE_NAME = '密码算法分析系统'


@dataclass(frozen=True)
class Page:
    """一个页面在服务端的全部身份信息。"""

    #: 页面标识，与 frontend/src/pages.js 的 key 完全一致
    key: str
    #: Django path() 语法。空串表示站点根
    url: str
    #: templates/analysis/ 下的模板文件名 —— 每个页面一个独立模板，
    #: 这样「页面」在服务端也是看得见摸得着的一个文件，而不是靠参数变出来的
    template: str
    #: Vite 清单（.vite/manifest.json）里的入口名
    entry: str
    #: 页面标题，<title> 里拼成「标题 · 站点名」
    title: str


PAGES = (
    Page('home', '', 'home.html', 'index.html', '首页'),
    Page('ciphers', 'ciphers/', 'ciphers.html', 'ciphers.html', '算法选择'),
    Page('structure', 'structure/', 'structure.html', 'structure.html', '结构编辑'),
    Page('differential', 'differential/', 'differential.html', 'differential.html', '差分分析'),
    Page('linear', 'linear/', 'linear.html', 'linear.html', '线性分析'),
    # 服务器端搜索（BCA_Light + kissat）。跑在 WSL 里，见 settings.py 的 BCA_* 配置。
    Page('bca', 'bca/', 'bca.html', 'bca.html', '后端搜索'),
    Page('results', 'results/', 'results.html', 'results.html', '结果与指标'),
    Page('logs', 'logs/', 'logs.html', 'logs.html', '运行日志'),
    Page('sbox', 'sbox/', 'sbox.html', 'sbox.html', 'S 盒库'),
    # 详情页：URL 带参数，但服务端只有这一条路由，所有 id 共用同一个根文件
    Page('sbox-detail', 'sbox/<int:pk>/', 'sbox-detail.html', 'sbox-detail.html', 'S 盒详情'),
    Page('tutorial', 'tutorial/', 'tutorial.html', 'tutorial.html', '初学者教程'),
    Page('check', 'check/', 'check.html', 'check.html', '接口自检'),
)

#: 404 页面：没有 URL（由兜底路由接管），其余字段与其他页面同构
NOT_FOUND = Page('not-found', '', '404.html', '404.html', '页面不存在')

BY_KEY = {page.key: page for page in (*PAGES, NOT_FOUND)}

#: 进入导航的页面（实现在前端，这里仅用于文档与自检）
NAV_KEYS = (
    'home', 'ciphers', 'structure', 'differential', 'linear',
    'bca', 'results', 'logs', 'sbox', 'tutorial',
)


def page_title(page: Page) -> str:
    """`<title>` 的内容。"""
    return SITE_NAME if page.key == 'home' else f'{page.title} · {SITE_NAME}'
