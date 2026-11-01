"""服务端回归测试：多页站点的结构与接口契约。

这里盯的是**只有真实跑过 Django 视图栈才能发现**的一类问题 ——
静态检查（frontend/tests/verify-*.mjs）能证明「文件都在、名字都对」，
但证明不了「这个 URL 真的返回了这个页面、注入的是这个页面自己的入口脚本」。

跑法：`.venv\\Scripts\\python.exe manage.py test analysis`

注：涉及资源注入的断言需要前端已构建（`cd frontend && npm run build`）。
未构建时那几条会 skip 并给出提示，而不是假装通过 ——
其余结构类断言在任何情况下都会跑。
"""

import pathlib
import re
import sys
from unittest import mock

from django.conf import settings
from django.test import TestCase
from django.templatetags.static import static

from .frontend import load_manifest
from .models import SBox
from .pages import NOT_FOUND, PAGES, SITE_NAME, page_title


def script_srcs(html: str) -> list[str]:
    """页面里所有 `<script src="...">`（顺序保留）。

    不用 BeautifulSoup —— 少一个依赖，这里也只需要最朴素的匹配。
    """
    return re.findall(r'<script[^>]+src="([^"]+)"', html)


def stylesheet_hrefs(html: str) -> list[str]:
    """页面里所有 `<link rel="stylesheet" href="...">`。"""
    return re.findall(r'<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"', html)


def present_hex() -> str:
    """PRESENT S 盒的十六进制表（4bit，16 项，构成置换）。"""
    return '0c05060b09000a0d030e0f0804070102'


def page_url(page) -> str:
    """把注册表里的 Django path 语法换成可以直接请求的具体地址。

    详情页注册的是 `sbox/<int:pk>/` —— 那是**路由模式**，不是地址。
    页面本身不关心 id（由前端从地址栏解析），所以随便填一个数字即可。
    """
    url = '/' + page.url if page.url else '/'
    return re.sub(r'<int:[^>]+>', '1', url)



class PageStructureTests(TestCase):
    """一个 URL 一个页面：每个页面都有自己的根文件、自己的入口、自己的标题。"""

    def test_every_page_serves_its_own_root_file(self):
        """逐页请求，比对 status / data-page / <title> / 入口脚本。"""
        entries = {}

        for page in PAGES:
            url = page_url(page)
            with self.subTest(page=page.key):
                resp = self.client.get(url)
                self.assertEqual(resp.status_code, 200, f'{url} 不是 200')

                html = resp.content.decode('utf-8')

                # Vue 挂载后会给挂载点加属性（data-v-app 等），所以不能整串精确匹配
                self.assertIn(f'data-page="{page.key}"', html,
                              f'{url} 返回的不是 {page.key} 的根文件')
                self.assertIn(page_title(page), html, f'{url} 的 <title> 不对')

                # 只取最后一个 module 脚本：它才是本页的入口（前面的都是 preload）
                scripts = script_srcs(html)
                self.assertTrue(scripts, f'{url} 没有注入入口脚本')
                self.assertIn(
                    page.entry.replace('.html', ''),
                    scripts[-1],
                    f'{url} 注入的入口脚本不是本页自己的：{scripts[-1]}',
                )
                entries[page.key] = scripts[-1]

        # 13 个页面必须各自加载**不同的** chunk ——
        # 一旦有人把它们合回一个入口，就等于退回单页应用了
        self.assertEqual(len(set(entries.values())), len(entries),
                         f'有页面共用入口脚本：{entries}')

    def test_thirteen_pages_registered(self):
        self.assertEqual(len(PAGES), 12, '可访问页面应为 12 个')
        self.assertEqual(len(PAGES) + 1, 13, '含 404 共 13 个页面')
        keys = [p.key for p in PAGES]
        self.assertEqual(len(set(keys)), len(keys), '页面 key 有重复')
        for page in PAGES:
            self.assertTrue(page.url == '' or page.url.endswith('/'),
                            f'{page.key} 的 url 没带尾斜杠：{page.url}')

    def test_unknown_url_is_a_real_404(self):
        """兜底必须是真 404，而不是「回壳 + 200」。"""
        resp = self.client.get('/definitely-not-a-page/')
        self.assertEqual(resp.status_code, 404)
        html = resp.content.decode('utf-8')
        self.assertIn(f'data-page="{NOT_FOUND.key}"', html,
                      '404 也应该返回 404 自己的根文件')
        self.assertIn(page_title(NOT_FOUND), html)

    def test_catch_all_does_not_swallow_backend_prefixes(self):
        """/api/ health/ admin/ static/ 下的未知地址不能被兜底页吞掉。"""
        for url in ['/api/nope/', '/health/nope/']:
            with self.subTest(url=url):
                resp = self.client.get(url)
                html = resp.content.decode('utf-8', 'replace')
                self.assertNotIn('data-page=', html,
                                 f'{url} 返回了平台页面，兜底路由越界了')

    def test_missing_trailing_slash_redirects(self):
        """老的无斜杠链接由 APPEND_SLASH 301 过来。"""
        resp = self.client.get('/ciphers')
        self.assertEqual(resp.status_code, 301)
        self.assertEqual(resp.headers.get('Location'), '/ciphers/')

        resp = self.client.get('/sbox/1')
        self.assertEqual(resp.status_code, 301)

    def test_sbox_detail_route_accepts_any_id(self):
        """详情页一条路由接住所有 id，共用同一个根文件。"""
        resp = self.client.get('/sbox/1/')
        self.assertEqual(resp.status_code, 200)
        self.assertIn('data-page="sbox-detail"', resp.content.decode('utf-8'))

    def test_favicon_is_declared_and_served(self):
        """图标：页面声明 + URI 兜底，两边都要在（否则控制台会留 404）。"""
        html = self.client.get('/').content.decode('utf-8')
        self.assertIn('rel="icon"', html, 'base.html 没有声明 <link rel="icon">')

        resp = self.client.get('/favicon.ico')
        self.assertIn(resp.status_code, (301, 302))
        self.assertEqual(resp.headers.get('Location'), static('dist/favicon.svg'))


class AssetInjectionTests(TestCase):
    """Vite 产物的注入：每个页面要拿到**自己那一份** JS 与整棵依赖树的 CSS。"""

    def setUp(self):
        if load_manifest() is None:
            self.skipTest('前端未构建 —— 先跑 `cd frontend && npm run build`')

    def test_every_page_gets_js_and_css(self):
        for page in PAGES:
            url = page_url(page)
            with self.subTest(page=page.key):
                html = self.client.get(url).content.decode('utf-8')
                self.assertIn('<script type="module"', html, f'{url} 没有 JS')
                self.assertGreaterEqual(
                    html.count('rel="stylesheet"'), 1, f'{url} 没有注入 CSS')

    def test_analysis_pages_get_dependency_css(self):
        """差分 / 线性页的样式分散在多个 chunk 里。

        回归点：`entry_assets` 一度只收入口自身那份 CSS，而 Vite 会把整棵依赖树的
        CSS 都算在页面上 —— 结果这两个页面完全没有样式（而且不报错，只是难看）。
        """
        for key, url in [('differential', '/differential/'), ('linear', '/linear/')]:
            with self.subTest(page=key):
                html = self.client.get(url).content.decode('utf-8')
                count = len(stylesheet_hrefs(html))
                self.assertGreaterEqual(
                    count, 2,
                    f'{url} 只注入了 {count} 份 CSS，依赖树里的样式被漏掉了',
                )

    def test_injected_assets_all_exist_on_disk(self):
        """注入的路径必须真的存在 —— 否则浏览器 404，页面白屏。"""
        static_root = pathlib.Path(settings.STATICFILES_DIRS[0])

        for page in PAGES:
            url = page_url(page)
            html = self.client.get(url).content.decode('utf-8')
            for rel in script_srcs(html) + stylesheet_hrefs(html):
                with self.subTest(page=page.key, asset=rel):
                    self.assertTrue(rel.startswith(settings.STATIC_URL),
                                    f'{rel} 不在 STATIC_URL 下')
                    fs_path = static_root / rel[len(settings.STATIC_URL):]
                    self.assertTrue(fs_path.exists(), f'{rel} 在磁盘上不存在')


class UnbuiltFrontendTests(TestCase):
    """前端未构建 / 构建中途被清空时，页面要给友好提示，**不是 500**。

    回归点：`vite_assets` 在 assets 为 None 时用了不带的占位符的
    `format_html(...)` —— 而 format_html 在没有 args/kwargs 时会直接抛
    `TypeError: args or kwargs must be provided.`。
    症状很阴：平时构建产物在，这条分支永远不走；一旦 `static/dist/` 被
    `npm run build` 清空（构建期间）或从未构建，**每一页都变成 500**，
    而前端静态检查、Node 套件全都发现不了。
    """

    def test_unbuilt_frontend_renders_notice_instead_of_crashing(self):
        from unittest import mock

        with mock.patch('analysis.templatetags.vite_assets.entry_assets',
                        return_value=None):
            resp = self.client.get('/')

        self.assertEqual(resp.status_code, 200,
                         '未构建时应渲染提示页，而不是 500')
        html = resp.content.decode('utf-8')
        self.assertIn('前端产物不存在', html, '没有给出「未构建」的提示')
        self.assertIn('npm run build', html, '提示里没告诉用户怎么修')
        # 提示也要落在真正的页面骨架里，而不是一段孤零零的字符串
        self.assertIn('data-page="home"', html)


class BuiltinSBoxSeedTests(TestCase):
    """内置 S 盒种子：库开箱可用，详情页有真实记录可看。"""

    def test_three_builtin_sboxes_are_seeded(self):
        names = set(SBox.objects.filter(is_builtin=True).values_list('name', flat=True))
        self.assertEqual(
            names,
            {'SM4 S-Box', 'AES S-Box', 'PRESENT S-Box'},
            f'内置 S 盒种子不对：{sorted(names)}',
        )

    def test_seeded_tables_are_wellformed_permutations(self):
        """种子的 hex 必须自洽：长度 = 2×项数，且构成置换。"""
        for sbox in SBox.objects.all():
            with self.subTest(sbox=sbox.name):
                n = 1 << sbox.size
                self.assertEqual(len(sbox.table_hex), n * 2)
                values = sorted(
                    int(sbox.table_hex[i:i + 2], 16) for i in range(0, len(sbox.table_hex), 2)
                )
                self.assertEqual(values, list(range(n)), '取值不是置换')

    def test_api_exposes_builtin_flags_and_detail(self):
        """列表/详情接口字段一致，且**不假设主键从 1 开始**。"""
        listing = self.client.get('/api/sboxes/').json()
        self.assertEqual(listing['count'], 3)
        for item in listing['results']:
            self.assertTrue(item['is_builtin'])
            # 接口里 size 是「项数」，bits 是位宽（数据库里存的才是位宽）
            self.assertEqual(item['size'], 1 << item['bits'])
            self.assertEqual(item['table_hex_len'], item['size'] * 2)

        first = listing['results'][0]
        detail = self.client.get(f"/api/sboxes/{first['id']}/").json()
        self.assertEqual(detail['name'], first['name'])
        self.assertEqual(len(detail['table_hex']), first['size'] * 2)

    def test_list_full_query_includes_tables(self):
        """`?full=1` 才附完整表数据。

        前端 S 盒库启动时要拿到所有 S 盒的表 —— 靠这个参数一次拉全，
        否则得对着列表里的每条记录再打一次详情接口（N+1）。
        默认形态保持不变：列表页只要 `table_hex_len`，不该被这份数据撑大。
        """
        plain = self.client.get('/api/sboxes/').json()['results'][0]
        self.assertNotIn('table_hex', plain, '默认列表不该带表数据')

        full = self.client.get('/api/sboxes/?full=1').json()['results'][0]
        self.assertIn('table_hex', full)
        self.assertEqual(len(full['table_hex']), full['size'] * 2)
        # 除表数据外，两种形态的字段必须逐字相同 —— 否则前端要写两套解析
        self.assertEqual(
            {k: v for k, v in full.items() if k != 'table_hex'},
            plain,
            '?full=1 只应多出 table_hex，其余字段不能变',
        )


class ApiContractTests(TestCase):
    """/api/** 只返回 JSON，且对错误分类明确。"""

    def test_endpoints_return_json(self):
        for url in ['/health/', '/api/csrf/', '/api/sboxes/']:
            with self.subTest(url=url):
                resp = self.client.get(url)
                self.assertEqual(resp.status_code, 200)
                self.assertTrue(resp['Content-Type'].startswith('application/json'))

    def test_missing_sbox_is_a_json_404(self):
        resp = self.client.get('/api/sboxes/999999/')
        self.assertEqual(resp.status_code, 404)
        self.assertTrue(resp['Content-Type'].startswith('application/json'),
                        '接口 404 必须是 JSON，不能被 HTML 兜底页接管')

    def test_create_validates_and_reports_conflicts(self):
        payload = {'name': '回归用 S 盒', 'table_hex': present_hex()}

        resp = self.client.post('/api/sboxes/', payload, content_type='application/json')
        self.assertEqual(resp.status_code, 201)

        # 重名 → 409
        resp = self.client.post('/api/sboxes/', payload, content_type='application/json')
        self.assertEqual(resp.status_code, 409)

        # 表数据不是置换 → 400
        resp = self.client.post(
            '/api/sboxes/',
            {'name': '非法表', 'table_hex': '00' * 16},
            content_type='application/json',
        )
        self.assertEqual(resp.status_code, 400)

    def test_delete_then_detail_is_404(self):
        created = self.client.post(
            '/api/sboxes/',
            {'name': '待删除 S 盒', 'table_hex': present_hex()},
            content_type='application/json',
        ).json()
        pk = created['id']

        self.assertEqual(self.client.delete(f'/api/sboxes/{pk}/').status_code, 200)
        self.assertEqual(self.client.get(f'/api/sboxes/{pk}/').status_code, 404)


class BcaProgressTests(TestCase):
    """运行中的进度接口：只读一份正在被追加的 results.csv。

    这个接口的全部价值在于「不跑搜索也能看到进度」，所以用例的重点不是
    "能不能读出数"，而是**它到底有没有起子进程**、以及路径拼法与 BCA 那边
    是否仍然对齐（`results/{task}/{cipher}/{model}/results.csv`）。

    本机是 Windows，`_platform_problem()` 会直接判 `needs_linux` —— 那样
    就永远测不到后面的解析逻辑了。所以这里把平台检查与配置一起打桩，
    只验「参数校验 → 拼路径 → 读 CSV → 算轮号」这条纯逻辑链路。
    """

    HEADER = ('task,algorithm,model,attack,round,prob,msv,lsv,result,'
              'solve_time,var_count,clause_count,cnf_time,solver,'
              'full_parallel,timestamp')

    def setUp(self):
        import tempfile
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

        self.cfg_patch = mock.patch(
            'analysis.bca_bridge.config',
            return_value={'dir': self.tmp.name, 'entry': 'bca_entry.py',
                          'python': 'python3', 'timeout': 120.0, 'probe_ttl': 30.0},
        )
        self.cfg_patch.start()
        self.addCleanup(self.cfg_patch.stop)

        # 让平台检查放行（本机是 Windows，否则每条用例都会短在 needs_linux）
        self.plat_patch = mock.patch(
            'analysis.bca_bridge._platform_problem', return_value=None)
        self.plat_patch.start()
        self.addCleanup(self.plat_patch.stop)

    def _write_csv(self, cipher, model, rows, task='web'):
        import os
        path = os.path.join(
            self.tmp.name, 'results', task, cipher, model, 'results.csv')
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'w', encoding='utf-8', newline='') as f:
            f.write(self.HEADER + '\n')
            for r in rows:
                f.write(r + '\n')
        return path

    def _get(self, **params):
        return self.client.get('/api/bca/progress/', params)

    def test_missing_cipher_or_model_is_bad_request(self):
        """cipher / model 是必填 —— 缺了要 400，而不是默默去读一个错路径。"""
        self.assertEqual(self._get(model='map').status_code, 400)
        self.assertEqual(self._get(cipher='sm4').status_code, 400)

    def test_path_traversal_chars_are_rejected(self):
        """`/` `\\` `..` 都能跳出 results/ 去读目录外的文件，必须拒绝。"""
        for bad in ('../etc', 'a/b', 'a\\b'):
            with self.subTest(cipher=bad):
                resp = self._get(cipher=bad, model='map')
                self.assertEqual(resp.status_code, 400)
                self.assertEqual(resp.json()['reason'], 'bad_request')

    def test_unknown_task_reports_empty_progress_not_error(self):
        """还没有落盘记录（首次跑）时：ok=true、0 条、没有已完成轮。

        这里刻意**不**返回 404 —— 前端会在开跑前就开始轮询，
        "暂时没文件"是正常状态，不是错误。
        """
        data = self._get(cipher='sm4', model='map').json()
        self.assertTrue(data['ok'])
        self.assertEqual(data['records'], 0)
        self.assertEqual(data['finished'], [])
        self.assertIsNone(data['lastRound'])

    def test_finished_rounds_are_sorted_and_terminal_only(self):
        """只有终态行（SAT/UNSAT）才算「已完成」，且轮号有序。"""
        self._write_csv('sm4', 'map', [
            # 非终态占位行（正在求解）：不该计入已完成
            'web,sm4,map,diff,3,0.5,,,RUNNING,1.2,100,200,0.1,kissat,1,2026-01-01T00:00:00',
            'web,sm4,map,diff,1,0.25,,,SATISFIABLE,0.8,900,1800,0.1,kissat,1,2026-01-01T00:00:01',
            'web,sm4,map,diff,2,0.4,,,UNSATISFIABLE,0.9,900,1800,0.1,kissat,1,2026-01-01T00:00:02',
        ])
        data = self._get(cipher='sm4', model='map').json()
        self.assertTrue(data['ok'])
        self.assertEqual(data['records'], 3, '三条记录都该被读到')
        self.assertEqual(data['finished'], [1, 2], 'RUNNING 不算完成，且必须有序')
        self.assertEqual(data['lastRound'], 2)

    def test_half_written_last_line_does_not_break_the_request(self):
        """CSV 正被追加写，最后一行可能只写了一半 —— 跳过它，不要报错。"""
        import os
        path = self._write_csv('sm4', 'pmm', [
            'web,sm4,pmm,diff,1,0.25,,,SATISFIABLE,0.8,900,1800,0.1,kissat,1,2026-01-01T00:00:01',
        ])
        with open(path, 'a', encoding='utf-8') as f:
            f.write('web,sm4,pmm,diff,2,0.4,,,SAT')  # 写到一半

        data = self._get(cipher='sm4', model='pmm').json()
        self.assertTrue(data['ok'], '半行不该让整个请求失败')
        self.assertEqual(data['finished'], [1])

    def test_progress_never_spawns_a_subprocess(self):
        """这是本接口的立身之本：读进度不能把求解器再拉起来一次。

        `_invoke` 是**唯一**起 BCA 子进程的出口，直接盯死它 ——
        以后有人「顺手」改成调子进程拿数据，这条会立刻红。
        """
        self._write_csv('sm4', 'map', [
            'web,sm4,map,diff,1,0.25,,,SATISFIABLE,0.8,900,1800,0.1,kissat,1,2026-01-01T00:00:01',
        ])
        with mock.patch('analysis.bca_bridge._invoke') as invoke:
            resp = self._get(cipher='sm4', model='map')
        self.assertEqual(resp.status_code, 200)
        invoke.assert_not_called()


class HealthTests(TestCase):
    def test_health_reports_environment(self):
        data = self.client.get('/health/').json()
        self.assertEqual(data['status'], 'ok')
        self.assertEqual(data['app'], 'analysis')
        self.assertEqual(data['sbox_count'], SBox.objects.count())
        self.assertIsInstance(data['frontend_built'], bool)


class SiteNameTests(TestCase):
    def test_title_composition(self):
        for page in PAGES:
            with self.subTest(page=page.key):
                title = page_title(page)
                if page.key == 'home':
                    self.assertEqual(title, SITE_NAME)
                else:
                    self.assertTrue(title.endswith(SITE_NAME))
                    self.assertIn(page.title, title)


class SolverPathResolutionTests(TestCase):
    """kissat 路径解析：BCA_KISSAT > config.json > PATH > 项目自带副本。

    盯的是「同一语义两处实现」回潮：历史上 probe() 用 `shutil.which()` 判定、
    KissatSolver 用 `os.path.exists()` 判定，于是把 solver.path 写成裸命令名时
    `/api/bca/status/` 报 ok、真正求解却 FileNotFoundError。现在两边都只调
    `bca.config.resolve_solver_path()`，最后一条用例就是防止有人再写回两份。
    """

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.bca_dir = pathlib.Path(settings.BCA_DIR)
        cls._added_path = str(cls.bca_dir) not in sys.path
        if cls._added_path:
            sys.path.insert(0, str(cls.bca_dir))

    @classmethod
    def tearDownClass(cls):
        if cls._added_path:
            try:
                sys.path.remove(str(cls.bca_dir))
            except ValueError:
                pass
        super().tearDownClass()

    def test_env_overrides_config_json(self):
        from bca.config import load_config
        with mock.patch.dict('os.environ', {'BCA_KISSAT': '/opt/custom/kissat'}):
            self.assertEqual(load_config().solver_path(), '/opt/custom/kissat')

    def test_blank_env_falls_back_to_config_json(self):
        from bca.config import load_config
        with mock.patch.dict('os.environ', {'BCA_KISSAT': '   '}):
            self.assertNotEqual(load_config().solver_path().strip(), '')

    def test_bare_name_prefers_path_lookup(self):
        from bca.config import resolve_solver_path
        with mock.patch('shutil.which', return_value='/usr/local/bin/kissat'):
            self.assertEqual(resolve_solver_path('kissat'), '/usr/local/bin/kissat')

    def test_bare_name_falls_back_to_bundled_copy(self):
        from bca.config import resolve_solver_path
        bundled = (self.bca_dir.parent.parent
                   / 'kissat-4.0.0-linux-amd64' / 'kissat-4.0.0-linux-amd64')
        with mock.patch('shutil.which', return_value=None):
            self.assertEqual(resolve_solver_path('kissat'), str(bundled))

    def test_missing_absolute_path_is_reported_not_replaced(self):
        """写错的路径必须暴露出来，不能静默改用别的二进制。"""
        from bca.config import resolve_solver_path
        self.assertIsNone(resolve_solver_path('/definitely/not/here/kissat'))

    def test_resolution_lives_in_one_place(self):
        solver_src = (self.bca_dir / 'bca' / 'solver.py').read_text(encoding='utf-8')
        entry_src = (self.bca_dir / 'bca_entry.py').read_text(encoding='utf-8')
        self.assertNotIn('os.path.exists(self.solver_path)', solver_src)
        self.assertNotIn('shutil.which(solver_path)', entry_src)
        self.assertIn('resolve_solver_path', solver_src)
        self.assertIn('resolve_solver_path', entry_src)
