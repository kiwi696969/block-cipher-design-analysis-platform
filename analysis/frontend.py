"""Vite 构建清单的读取与解析。

前端由 `frontend/` 目录下的 Vite 工程构建，产物落在 `static/dist/`，
并生成 `.vite/manifest.json`。因为文件名带内容哈希，不能硬编码，
必须通过清单把「逻辑入口」映射到「实际文件」。

本模块同时被模板标签（注入 <script>/<link>）和健康检查视图使用。
"""

import json
from pathlib import Path

from django.conf import settings

#: 清单相对于 STATICFILES_DIRS 中第一个目录的位置
MANIFEST_RELATIVE = Path('dist') / '.vite' / 'manifest.json'

#: 缺省入口（首页）。本站是**多页站点**，每个页面各有自己的入口 ——
#: 具体用哪个由 `analysis/pages.py` 的 Page.entry 决定，这里只是兜底值。
ENTRY_KEY = 'index.html'


def manifest_path() -> Path:
    """清单文件的绝对路径。"""
    return Path(settings.BASE_DIR) / 'static' / MANIFEST_RELATIVE


def load_manifest() -> dict | None:
    """读取清单；尚未构建或文件损坏时返回 None（调用方不应因此报错）。"""
    path = manifest_path()
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError):
        return None


def entry_assets(manifest: dict | None = None, entry: str = ENTRY_KEY) -> dict | None:
    """解析入口资源。

    ⚠️ 必须**递归整棵静态依赖树**，不能只看入口自己那一份。
    多页构建会把页面共享的代码（Vue、引擎、样式）提成公共 chunk，
    入口节点的 `css` 往往只有一两项甚至为空 ——
    只收自己的那份，页面就会出现「JS 跑起来了但没有样式」。
    （这个坑踩过：differential.html 入口的 css 是空的，
      而它依赖的 AnalysisView / boot 各自带着样式。）

    遍历用**后序**（先子后自身），这样 CSS 的先后顺序与 Vite 生成的
    HTML 完全一致，避免同名选择器被覆盖反了。

    @returns None 表示未构建或找不到入口；否则返回
             {'js': [...], 'css': [...], 'preload': [...]}，
             其中路径均相对于 static/ 根（例如 'dist/assets/index-xxx.js'）。
    """
    manifest = manifest if manifest is not None else load_manifest()
    if not manifest:
        return None

    root = manifest.get(entry)
    if not root:
        return None

    js: list[str] = []
    css: list[str] = []
    preload: list[str] = []
    seen: set[str] = set()

    def walk(key: str) -> None:
        if key in seen:
            return
        seen.add(key)

        node = manifest.get(key)
        if not node:
            return

        # 先走静态依赖（后序：子在前，自身在后）
        for child in node.get('imports', []) or []:
            child_file = str(manifest.get(child, {}).get('file', ''))
            if child_file.endswith('.js'):
                item = f'dist/{child_file}'
                if item not in preload:
                    preload.append(item)
            walk(child)

        for css_path in node.get('css', []) or []:
            item = f'dist/{css_path}'
            if item not in css:
                css.append(item)

    if root.get('file'):
        js.append(f"dist/{root['file']}")
    walk(entry)

    return {'js': js, 'css': css, 'preload': preload}
