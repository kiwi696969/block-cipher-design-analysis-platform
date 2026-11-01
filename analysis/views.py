"""密码算法分析系统 —— 视图层。

分层约定：
- **页面层**：一个 URL 一个页面。每个页面有自己的根模板与自己的 Vite 入口，
  映射表在 `pages.py`。本站是**多页站点（MPA）**，没有客户端路由，
  所以不存在"所有路径都回同一个壳"这种事。
- **接口层**：`/api/**` 全部返回 JSON，不返回 HTML，供前端 fetch 调用。
- **运维层**：`/health/` 不查库、不依赖外部资源，用于快速判断服务状态。

S 盒的 DDT / LAT / 非线性度等指标一律由前端计算层实时算出，**不落库**。
"""

import json
import re
import sys

import django
from django.conf import settings
from django.http import HttpResponseRedirect, JsonResponse
from django.middleware.csrf import get_token
from django.shortcuts import render
from django.templatetags.static import static
from django.views.decorators.csrf import ensure_csrf_cookie
from django.views.decorators.http import require_http_methods

from . import bca_bridge
from .frontend import load_manifest
from .models import SBox
from .pages import NOT_FOUND, Page, page_title

# 用户粘贴表数据时可能带上的分隔符（空格、逗号、换行、冒号、下划线、连字符）
_SEPARATORS = re.compile(r'[\s,;:_\-]+')
_HEX_PREFIX = re.compile(r'0[xX]')


# ---------------------------------------------------------------------------
# 页面层
# ---------------------------------------------------------------------------


def _render_page(request, page: Page, *, status: int = 200):
    """渲染一个页面。

    页面身份（模板、Vite 入口、标题）全部来自 `pages.py` 的注册表，
    模板只负责骨架，内容由该页面自己的入口脚本挂载。
    """
    return render(
        request,
        f'analysis/{page.template}',
        {
            # 模板用它写 data-page、挑对应的 Vite 入口
            'page_key': page.key,
            'page_entry': page.entry,
            'title': page_title(page),
        },
        status=status,
    )


def make_page_view(page: Page):
    """为注册表里的一个页面造出视图函数。

    十来个页面每个都手写一个只差一行的函数没有必要，但**每个页面仍然真的
    拥有自己的路由和自己的模板** —— 这里只是消掉重复，不是把页面并成一个。

    `@ensure_csrf_cookie` 确保首屏就下发 csrftoken Cookie，
    这样前端做写操作时不必额外等待一次请求。
    """

    def view(request, **kwargs):
        # **kwargs 接住 URL 捕获组（详情页的 pk 等）。
        # 页面本身不关心这些参数 —— 动态段由前端从地址栏解析
        # （见 frontend/src/entries/sbox-detail.js）——
        # 但视图必须能收下它们，否则 Django 传参时会直接 TypeError。
        return _render_page(request, page)

    view.__name__ = f'page_{page.key}'
    view.__qualname__ = view.__name__
    view.__doc__ = f'页面：{page.title}（{page.url or "/"}）'
    return ensure_csrf_cookie(view)


@ensure_csrf_cookie
def page_not_found(request, path=''):
    """兜底：不存在的地址返回**真正的 404 页面**（HTTP 404 + 独立根文件）。

    旧实现是「回 SPA 外壳 + 200」—— 那在单页应用里是对的（前端路由要靠它接管）；
    多页站点没有前端路由，兜底就该老实报 404，否则搜索引擎和监控会把一堆
    垃圾地址当成正常页面。`path` 由 URL 捕获组传入，这里用不到，留着便于排查。
    """
    return _render_page(request, NOT_FOUND, status=404)


# ---------------------------------------------------------------------------
# 运维层
# ---------------------------------------------------------------------------


def favicon(request):
    """`/favicon.ico` 兜底。

    页面已经用 `<link rel="icon">` 声明了 SVG 图标，正常浏览器不会再要这个地址；
    但老爬虫、部分工具仍会直接来取，不接的话每次访问都在控制台留一条 404。
    这里重定向到真正的图标文件。

    注意：图标由 `npm run build` 产出到 static/dist/，前端尚未构建时会跟着 404 ——
    这属于"本来就没构建"的正常表现，不做额外兜底。
    """
    return HttpResponseRedirect(static('dist/favicon.svg'))


def health(request):
    """健康检查：不查库、不依赖任何外部资源。"""
    return JsonResponse(
        {
            'status': 'ok',
            'app': 'analysis',
            'django': django.get_version(),
            'python': sys.version.split()[0],
            'timezone': settings.TIME_ZONE,
            'frontend_built': load_manifest() is not None,
            'sbox_count': SBox.objects.count(),
        }
    )


# ---------------------------------------------------------------------------
# 接口层：CSRF
# ---------------------------------------------------------------------------


@ensure_csrf_cookie
@require_http_methods(['GET'])
def csrf(request):
    """发放 CSRF token。

    单页应用的表单里没有 csrfmiddlewaretoken 隐藏域，所以提供一个显式入口：
    前端启动时取一次，之后所有写请求带 `X-CSRFToken` 头。
    """
    return JsonResponse({'csrfToken': get_token(request)})


# ---------------------------------------------------------------------------
# 接口层：S 盒
# ---------------------------------------------------------------------------


def _serialize(sbox: SBox, *, full: bool = False) -> dict:
    """统一的序列化出口，避免列表和详情两个接口字段不一致。"""
    data = {
        'id': sbox.id,
        'name': sbox.name,
        # size 用「项数」（16 / 256）而不是位宽，前端表格直接用
        'size': 1 << sbox.size,
        'bits': sbox.size,
        'note': sbox.note,
        'is_builtin': sbox.is_builtin,
        'table_hex_len': len(sbox.table_hex),
        'created_at': sbox.created_at.isoformat(timespec='seconds'),
    }
    if full:
        data['table_hex'] = sbox.table_hex
    return data


def _normalize_sbox_hex(raw) -> tuple[str | None, str | None]:
    """校验并归一化 S 盒表数据。

    @returns (归一化后的 hex 串, 错误信息)。两者恰有一个为 None。
    """
    if raw is None or str(raw).strip() == '':
        return None, '表数据不能为空'

    text = _HEX_PREFIX.sub('', str(raw))
    text = _SEPARATORS.sub('', text).lower()

    if text == '':
        return None, '表数据不能为空'

    bad = re.search(r'[^0-9a-f]', text)
    if bad:
        return None, f'含非法字符“{bad.group(0)}”，只接受 0-9 与 a-f'

    if len(text) % 2:
        return None, f'十六进制位数为奇数（{len(text)} 位），无法按字节解读'

    count = len(text) // 2
    if count < 16 or (count & (count - 1)):
        return None, f'项数 {count} 不是 2 的幂（合法值如 16、256）'

    values = [int(text[i : i + 2], 16) for i in range(0, len(text), 2)]
    if sorted(values) != list(range(count)):
        return None, f'取值不是置换：{count} 项必须恰好覆盖 0…{count - 1} 且互不重复'

    return text, None


@require_http_methods(['GET', 'POST'])
def sbox_list(request):
    """GET：列表。POST：新建。

    GET 默认**不带表数据**（只给 `table_hex_len`）—— 列表页只要长度。
    加 `?full=1` 才附上完整 `table_hex`：前端 S 盒库启动时靠它一次拉全，
    否则要逐条打详情接口（N+1 次请求）。
    """
    if request.method == 'POST':
        return _create_sbox(request)

    full = str(request.GET.get('full', '')).lower() in ('1', 'true', 'yes')
    items = [_serialize(s, full=full) for s in SBox.objects.all()]
    return JsonResponse({'count': len(items), 'results': items})


def _create_sbox(request) -> JsonResponse:
    try:
        payload = json.loads(request.body or b'{}')
    except json.JSONDecodeError:
        return JsonResponse({'error': '请求体不是合法 JSON'}, status=400)

    if not isinstance(payload, dict):
        return JsonResponse({'error': '请求体应为 JSON 对象'}, status=400)

    name = str(payload.get('name') or '').strip()
    if not name:
        return JsonResponse({'error': '名称不能为空'}, status=400)
    if len(name) > 64:
        return JsonResponse({'error': '名称过长，上限 64 个字符'}, status=400)

    table_hex, err = _normalize_sbox_hex(payload.get('table_hex'))
    if err:
        return JsonResponse({'error': err}, status=400)

    if SBox.objects.filter(name=name).exists():
        return JsonResponse({'error': f'已存在同名的 S 盒“{name}”'}, status=409)

    count = len(table_hex) // 2
    sbox = SBox.objects.create(
        name=name,
        size=SBox.Size.BIT8 if count == 256 else SBox.Size.BIT4,
        table_hex=table_hex,
        note=str(payload.get('note') or '').strip()[:200],
        is_builtin=bool(payload.get('is_builtin')),
    )
    return JsonResponse(_serialize(sbox, full=True), status=201)


@require_http_methods(['GET', 'DELETE'])
def sbox_detail(request, pk: int):
    """GET：详情（含完整表数据）。DELETE：删除。"""
    try:
        sbox = SBox.objects.get(pk=pk)
    except SBox.DoesNotExist:
        return JsonResponse({'error': 'S 盒不存在'}, status=404)

    if request.method == 'DELETE':
        sbox.delete()
        return JsonResponse({'deleted': True, 'id': pk})

    return JsonResponse(_serialize(sbox, full=True))


# ---------------------------------------------------------------------------
# 接口层：BCA_Light 差分路径搜索后端
# ---------------------------------------------------------------------------
# BCA 在 WSL 里以**子进程**运行（理由见 bca_bridge 的模块说明）。这一层做三件事：
# 解析请求、按 mode 决定「只读缓存还是真跑」、把结果原样交给前端。
#
# 状态码约定：**请求体本身不合法**用 400；**BCA 的执行结果一律 200**，成败由
# 响应里的 `ok` 字段表达。后者是有意的 —— 搜索失败/超时/后端没装好都是演示现场
# 的常见情况，前端应当能直接读到完整的诊断信息（reason / error / hints），
# 而不是被 fetch 的异常路径吞掉 body。

# 只有这两种才叫「跑完了」；TIMEOUT / PENDING 之类都要重跑
_TERMINAL_RESULTS = ('SATISFIABLE', 'UNSATISFIABLE')


def _finished_rounds(records):
    """记录里已经出现终态结果的轮号集合。"""
    done = set()
    for row in records or []:
        if row.get('result') in _TERMINAL_RESULTS:
            try:
                done.add(int(row.get('round')))
            except (TypeError, ValueError):
                continue
    return done


def _full_coverage(task, records):
    """已有记录是否覆盖了请求的整段轮数。

    轮数范围直接从 BCA 的响应里取（`task.rounds`）—— 那边已经把 "1-8"、
    [1,8]、"8" 各种写法规范化过了，这里不再解析一遍，免得两套规则漂移。
    """
    rounds = (task or {}).get('rounds') or []
    if len(rounds) != 2:
        return False
    start, end = int(rounds[0]), int(rounds[1])
    return set(range(start, end + 1)) <= _finished_rounds(records)


@require_http_methods(['GET'])
def bca_status(request):
    """BCA 后端自检：能不能用、缺什么、有哪些算法与模型。

    探测走的是和真正搜索**完全相同**的链路（起一次子进程、调同一个入口脚本），
    所以「自检通过」等于「后面真跑也能起来」。结果有一小段缓存（默认 30 秒），
    加 `?refresh=1` 强制重探 —— 换机器、装完 kissat 之后用得上。
    """
    force = request.GET.get('refresh') not in (None, '', '0', 'false', 'False')
    return JsonResponse(bca_bridge.status(force=force))


@require_http_methods(['POST'])
def bca_run(request):
    """触发一次 BCA 差分路径搜索，或只读已有结果。

    请求体（JSON）::

        {
          "cipher": "SM4",         # 必填
          "model": "MAP",          # 必填，MAP / MDW / AS
          "rounds": "1-8",         # 必填
          "task": "web-sm4",       # 可选，输出目录名（默认 web）
          "attack": "differential",# 可选
          "mode": "auto",          # 可选，auto | cache | run
          "timeout": 120,          # 可选，**子进程**护栏（秒）；0 = 不限
          "solve_timeout": 300     # 可选，BCA 的**单次 SAT 求解**超时（秒）
        }

    `timeout` 与 `solve_timeout` 是两个东西，名字必须分开：前者是这一层起子进程
    的护栏（超了就把 BCA 杀掉，已落盘的记录还在），后者进 BCA 内部约束单次
    求解。混用一个名字迟早出事。

    `mode` 三种取值：

    * `cache` —— 只读已有产物，完全不跑搜索。毫秒级返回，**现场演示的秒出通道**。
    * `run`   —— 跑搜索。BCA 自带断点续跑（同任务已记录的实例直接跳过），
                 所以对已预热过的任务重跑也很便宜。
    * `auto`  —— 默认。先看已有记录是否覆盖了请求的整段轮数：覆盖了就直接返回，
                 没覆盖才真跑。这是最省心的用法。
    """
    try:
        payload = json.loads(request.body or b'{}')
    except json.JSONDecodeError:
        return JsonResponse({'ok': False, 'error': '请求体不是合法 JSON'}, status=400)

    if not isinstance(payload, dict):
        return JsonResponse({'ok': False, 'error': '请求体应为 JSON 对象'}, status=400)

    mode = str(payload.get('mode') or 'auto').strip().lower()
    if mode not in ('auto', 'cache', 'run'):
        return JsonResponse(
            {'ok': False, 'error': f'未知 mode：{mode}（可选 auto / cache / run）'},
            status=400,
        )

    # 转发给 BCA 入口的字段：去掉这一层自己的（mode），并把 solve_timeout
    # 改名成 BCA 约定的 timeout。
    body = {k: v for k, v in payload.items()
            if k not in ('mode', 'timeout', 'solve_timeout')}
    if payload.get('solve_timeout') is not None:
        body['timeout'] = payload['solve_timeout']

    if mode == 'cache':
        return _bca_response(bca_bridge.load_results(body),
                             {'mode': 'cache', 'cached': True})

    if mode == 'auto':
        cached = bca_bridge.load_results(body)
        if cached.get('ok') and _full_coverage(cached.get('task'), cached.get('records')):
            # 已有记录覆盖了整段轮数 → 直接返回。**这就是现场演示的秒出通道。**
            return _bca_response(cached, {'mode': 'cache', 'cached': True})
        # 覆盖不全（或压根没跑过）→ 往下走真跑。断点续跑会把已完成的轮次跳过。

    return _bca_response(bca_bridge.run(body, timeout=payload.get('timeout')),
                         {'mode': 'run', 'cached': False})


@require_http_methods(['GET'])
def bca_progress(request):
    """运行中的进度：读该任务已落盘的记录，回报"已完成到第几轮"。

    为什么要单独开一个接口：`/api/bca/run/` 是**同步长请求**（32 轮可能要跑
    几小时），期间页面上除了一个转圈什么反馈都没有。这个方法不跑搜索、不起
    子进程、不碰求解器 —— 只是读那个正在被追加的 results.csv，所以可以和
    运行中的搜索并存（runserver 是多线程的，两个请求各跑各的）。

    查询参数：`task`（默认 web）、`cipher`、`model`（后两个必填）。
    轮数范围不由服务端解析 —— 前端本来就知道自己请求的起止轮，
    服务端只回"哪些轮已经落盘了"，少一处会漂移的重复规则。
    """
    resp = bca_bridge.progress({
        'task': request.GET.get('task') or 'web',
        'cipher': request.GET.get('cipher'),
        'model': request.GET.get('model'),
    })
    if resp.get('ok'):
        rows = resp.pop('records', [])
        done = sorted(_finished_rounds(rows))
        resp.update(
            records=len(rows),
            finished=done,
            lastRound=done[-1] if done else None,
        )
    return _bca_response(resp)


def _bca_response(resp, extra=None):
    """把 BCA 响应包成 JsonResponse。

    只有「请求参数本身错」用 400（reason=bad_request，与坏 JSON / 未知 mode 同类）；
    其余一律 200，成败交给 `ok` 字段 —— 见本节的模块说明。
    """
    if extra:
        resp.update(extra)
    code = 400 if resp.get('reason') == 'bad_request' else 200
    return JsonResponse(resp, status=code)
