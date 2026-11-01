"""把 Vite 构建产物注入 Django 模板。

用法：
    {% load vite_assets %}
    {% vite_assets %}

会输出入口的 CSS <link>、依赖 chunk 的 <link rel="modulepreload">，
以及入口的 <script type="module">。文件名取自 manifest，带哈希也无需改动模板。

未构建时输出一段可见的提示，而不是让页面静默白屏。
"""

from django import template
from django.templatetags.static import static
from django.utils.html import format_html
from django.utils.safestring import mark_safe

from ..frontend import ENTRY_KEY, entry_assets

register = template.Library()


@register.simple_tag
def vite_assets(entry: str = ENTRY_KEY):
    assets = entry_assets(entry=entry)

    if assets is None:
        # 注意：这里**不能**用 format_html —— 这段 HTML 里没有 {} 占位符，
        # 而 format_html 在没有 args/kwargs 时会直接抛
        # "TypeError: args or kwargs must be provided."。
        # 那样一来「前端未构建」就不再是友好提示，而是把每一页都变成 500。
        return mark_safe(
            '<div style="margin:24px;padding:16px;border:1px solid #fecaca;'
            'background:#fef2f2;color:#991b1b;border-radius:8px;'
            'font:13px/1.7 system-ui,sans-serif">'
            '前端产物不存在，页面无法渲染。<br>'
            '请在 <code>frontend/</code> 目录执行 <code>npm run build</code> '
            '（或在其中执行 <code>npm run dev</code> 走开发服务器）。'
            '</div>'
        )

    tags = []

    for css_path in assets['css']:
        tags.append(format_html('<link rel="stylesheet" href="{}">', static(css_path)))

    for preload_path in assets['preload']:
        tags.append(format_html('<link rel="modulepreload" href="{}">', static(preload_path)))

    for js_path in assets['js']:
        tags.append(format_html('<script type="module" src="{}"></script>', static(js_path)))

    return mark_safe('\n    '.join(str(tag) for tag in tags))
