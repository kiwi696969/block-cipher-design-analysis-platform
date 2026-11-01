# AGENTS.md

给 AI 编码助手（以及新加入的人）的项目导航。**动手前请读完「铁律」一节** —— 里面每一条都是踩过的坑。

---

## 1. 这是什么

**分组密码差分 / 线性自动化分析平台。** 现在是一套完整的可运行平台：拖拽式轮函数结构编辑器 + 差分/线性特征自动搜索 + 搜索过程可视化 + 指标体系 + 中文解析 + 初学者教程。

- 一个典型用途：选 SM4 → 在画布上拖动 τ 变换 / 线性层搭出轮函数 → 设起止轮与搜索模型 → 运行 → 读出 32 轮的 `−log₂p = 647.00`、活跃 S 盒 107、变量数 4417、子句数 7520，以及收敛曲线和逐轮明细。
- 技术栈：**Django 6.1.1 + Vue 3.5 + Vite 8**，Python 3.13 / Node 22。
- 交付形态：单进程。Django 在 8011 端口既提供 API，也托管前端构建产物。前端**不是**独立部署的。
- **站点形态是多页应用（MPA），不是单页应用**：13 个页面各自有一个 HTML 根文件、一个 Vite 构建入口、
  一个入口脚本、一个 Django 路由和一个模板；站内跳转是**原生整页加载**，没有客户端路由。
  细节见 §3。
- **引擎是移植来的，不是重写的**：`frontend/src/core/` 下的 `gf2 / sbox / sboxlib / sm4ref / graph / analysis` 六个文件取自一套已用测试套件验证过的实现。它们的数值与 SM4 权威基准完全一致（见 §7），**改这些文件前先跑回归测试**。

### 历史上被废弃的方案（不要往回退）

| 方案 | 状态 | 为什么废掉 |
|---|---|---|
| 纯静态站、零依赖、双击 index.html | ❌ | 无后端，S 盒无法持久化 |
| Django 模板直出前台页面 | ❌ | 交互复杂（拖拽编辑器），模板很难维护 |
| 前端走 CDN 引 Vue | ❌ | 无构建步骤 = 无 SFC、无 HMR、无依赖管理 |
| **Vue Router 单页应用**（一个外壳 + 客户端路由） | ❌ | 十几个页面共用一份 HTML/入口，URL 与页面不是一对一；刷新/直达要靠 catch-all 回壳，404 只能返回 200。2026-09-18 明确改成多页 |

现在这套（Vite 多入口构建 + Django 逐页托管）是**有意选择**的结果，别提议改回上面任何一种。


---

## 2. 快速开始

```powershell
# 1) 起后端（这是主战场，日志都在这儿）
#    双击 start-django.bat，或：
.\.venv\Scripts\python.exe manage.py runserver 127.0.0.1:8011

# 2) 构建前端（改了 frontend/src/ 下的任何东西之后，必须做这步）
#    双击 build-frontend.bat，或：
cd frontend; npm run build

# 3) 打开 http://127.0.0.1:8011/
```

**前端热更新（可选）** —— 需要 HMR 时开第二个窗口，双击 `start-frontend-dev.bat`（5173 端口，已配好到 8011 的代理）。不开也不影响开发。

### 端口分配

| 端口 | 用途 | 备注 |
|---|---|---|
| **8011** | Django（API + 静态托管） | 唯一入口。**8000 被本机别的程序占用，别用** |
| 5173 | Vite 开发服务器 | 可选，仅调试期 |
| 8080 | 未使用 | |

### 其他命令

```powershell
.\.venv\Scripts\python.exe manage.py check            # 自检，改完配置/路由先跑这个
.\.venv\Scripts\python.exe manage.py makemigrations   # 改了 models.py 之后
.\.venv\Scripts\python.exe manage.py migrate
.\.venv\Scripts\python.exe -m pip freeze > requirements.txt
```

---

## 3. 目录结构与数据流

```
manage.py
cipher_platform/               # 工程包（配置）
  settings.py                  #   ← 项目特有的设置都集中在文件末尾几节，有注释
  urls.py                      #   只有两条：admin/ 和转交 analysis

analysis/                      # 唯一的业务应用
  models.py                    #   SBox 模型
  pages.py                     #   ★ 服务端页面注册表：URL → 模板 → Vite 入口 → 标题
  views.py                     #   页面层 / 运维层 / 接口层，三段分明
  bca_bridge.py                #   ★ BCA 桥接层：本地子进程调用（只跑在 WSL 里）
  urls.py                      #   ← 逐页注册（页面多页化的关键，见 §4.6）
  admin.py                     #   SimpleUI 后台
  apps.py                      #   ready() 里设置后台标题
  frontend.py                  #   读 Vite manifest（纯函数，无副作用）
  templatetags/vite_assets.py  #   {% vite_assets page_entry %} 注入带哈希的 js/css
  migrations/0002_seed_builtin_sboxes.py  # ★ 内置 S 盒种子（SM4/AES/PRESENT）

backend/
  bca_light/                   # ★ BCA 差分/线性路径搜索后端（见 §5「BCA 后端」）
    bca_entry.py               #   ★ 给 Django 用的 JSON 入口（stdin/stdout），BCA 源码零改动
    main.py                    #   BCA 原有的 CLI，照旧可用（同一套 bca/ 与 models/）
    config.json                #   solver.path 指向 kissat（可用 BCA_KISSAT 环境变量覆盖）
    bca/  models/  data/       #   BCA 本体（含 util/linweight.py、models/linear.py）
                               #   + espresso S 盒常量数据（差分 + 线性两套）
    scripts/                   #   ★ gen_linear_sbox_data.py（由 LAT 造线性数据）
                               #     ★ verify_linear.py（线性独立复核：WHT / 子句 / 端到端）
    results/                   #   搜索结果（gitignore）：
                               #     <task>/<算法>/<模型>/{results.csv, bounds.json, details/}
                               #     —— CSV 是权威记录，断点续跑就是靠它；**演示前要预热**
                               #     ⚠️ 改了 S 盒数据必须清掉对应任务目录，否则复用旧解

templates/analysis/            # base.html + 13 个页面各自一个根模板（没有 index.html）

frontend/                      # ← Vite 工程（独立的，不在 Django 静态目录里）
  <page>.html                  #   ★ 13 个 HTML 根文件 = Vite 的 13 个构建入口
  public/favicon.svg           #   站点图标（Vite 原样拷进 static/dist/）
  vite.config.js               #   多入口 / base / 代理 / manifest 都在这儿
  .npmrc                       #   registry 固定 npmmirror
  src/
    pages.js                   #   ★ 前端页面注册表 + href() / go() / matchPath()
    App.vue                    #   工作台外壳：左竖栏导航 + 上下文条 + 状态栏（见 4.31）
    entries/
      boot.js                  #   公共挂载逻辑（mountPage）
      <key>.js                 #   ★ 每页一个入口脚本，只挂一个根视图
    api/client.js              #   fetch 封装 + CSRF 处理
    stores/
      theme.js                 #   深浅主题（写 <html data-theme>，localStorage 持久化）
      platform.js              #   ★ 全站状态中枢：参数 / 运行 / 结果 / 日志 / 导入导出
    core/                      #   ★ 纯计算层，不许碰 DOM（可用 node 直接跑）
      gf2.js                   #     GF(2) 位运算
      sbox.js                  #     DDT / LAT / 非线性度 / 差分均匀度 / 线性度
      sboxlib.js               #     S 盒库：内置 + 服务端镜像 + 本地导入（见 4.27）
      sm4ref.js                #     SM4 官方参考实现 + 密钥扩展 + 状态轨迹
      graph.js                 #     节点类型 / 模板 / 图结构
      analysis.js              #     特征搜索引擎（Feistel 与 SPN 两条路径）
      empirical.js             #     抽样命中率验证（真实加密，不是估算）
      params.js                #     ★ 参数装配的唯一入口（见 4.11）
      model.js                 #     变量数 / 子句数建模
      explain.js               #     中文解析生成
      bca-reference.js         #     ★ SM4 逐轮「前端上界 ⇄ BCA 精确下界」历史对照表（页面已不用，见 4.40）
      bca-solve.js             #     ★ 后端求解适配层：能力判定 / 响应解析 / 未解轮次 pending（见 4.40）
      hex.js  presets.js       #     hex 工具 / SM4·AES·PRESENT 参考 S 盒
    components/                #   MetricCard / LineChart / LogPanel / ExplainPanel /
                               #   HeatmapGrid（canvas 热力图）/ FoldPanel（折叠区，见 4.31）
    views/                     #   11 个根视图 + NotFoundView（AnalysisView 供差分/线性两页共用）
    styles/main.css            #   双主题 CSS 变量
  tests/                       #   ★ 纯 node 可跑的回归套件（无浏览器依赖）
    verify-core.mjs            #     引擎基准值 + S 盒库↔服务端同步 + ARX 精确模型/非等宽 S 盒守卫（149 项）
    verify-params.mjs          #     参数装配层（56 项）
    verify-integration.mjs     #     端到端集成，镜像真实调用路径（97 项）
    verify-pages.mjs           #     ★ 多页结构一致性 + 不得退回 SPA（255 项）
    verify-seed.mjs            #     ★ 内置 S 盒种子与前端内置表一致（27 项）
    verify-accuracy.mjs        #     ★ 独立复核「跑得快 ≠ 算错」：独立重算 + 真实加密抽样 + BCA 对照（54 项，见 4.39）
    verify-shuangyu.mjs        #     ★ 独立复核「双鱼」设计：不复用平台引擎（24 项，见 4.34）
    verify-fangzhen.mjs        #     ★ 独立复核「方阵」SPN：GF(2⁸) 三方对拍 + 能力边界（50 项，见 4.35）
    e2e-browser.cjs            #     真实浏览器 E2E（需后端在 8011 跑着，102 项）
    accept-four-defects.cjs    #     ★ 真实浏览器验收：「能画 ≠ 能算」四缺陷（23 项，见 4.33）
    design-shuangyu.cjs        #     ★ 真实浏览器「实操设计」：拖出双鱼图并留档（见 4.34）
    design-fangzhen.cjs        #     ★ 真实浏览器「实操设计」：拖出方阵 SPN + 末轮跳过对照（见 4.35）

docs/                          # ★ 2026-10-17 蒸馏归档：AGENTS.md 只留「结论卡 + 指针」，明细正文在这里
  铁律案例史.md                 #   §4.31~§4.39「实测 / 缺陷史」的逐字原文（编号保持原样，§4.xx 引用仍有效）
  已完成-变更流水.md            #   §9「已完成」的逐条过程与**当时**的测试计数（历史中间态，已过时）

static/dist/                   # 构建产物（gitignore），Django 当普通静态文件托管
db.sqlite3                     # SQLite（gitignore）
```

### 页面与路由

**本站是多页站点：一个 URL 一个页面。** 全部 12 个可访问页面（一律带尾斜杠）+ 服务端兜底的 404：

| 路径 | 页面 | 说明 |
|---|---|---|
| `/` | 工作台 | 当前上下文 / 上次结果 / 待办路径 / 最近日志（折叠）/ 口径说明（折叠） |
| `/ciphers/` | 算法选择 | **只有 SM4 / 类 AES / 空白画布（自定义）** 三个选项，见 §4.25 |
| `/structure/` | 结构编辑器 | 拖拽搭轮函数 + 中文解析 |
| `/differential/` | 差分分析 | 参数 / 运行 / 可视化 / 指标 / 日志 |
| `/linear/` | 线性分析 | 同上，线性模式 |
| `/bca/` | 后端搜索 | **服务器端** SAT 搜索（BCA_Light + kissat），能推到全轮；只能在 WSL 里跑，见 §4.26 |
| `/results/` | 结果 | 指标总览 + 建模规模分解 + 三模型对比 |
| `/logs/` | 运行日志 | |
| `/sbox/`、`/sbox/:id/` | S 盒库 / 详情 | 原有的 S 盒管理；两者是**各自独立的页面文件** |
| `/tutorial/` | 教程 | 初学者分步教程 + 可一键执行的示例 |
| `/check/` | 接口自检 | 不进导航，但同样是独立页面 |
| 其余地址 | 404 | **HTTP 404 + 自己的根文件**，不是回壳 200 |

无斜杠的老地址（`/ciphers`）由 CommonMiddleware 的 `APPEND_SLASH` 301 过来。

**加一个页面 = 改四处**（`verify-pages.mjs` 会逐条检查，缺一处就红）：

1. `frontend/src/pages.js` —— 页面注册表（导航、`href()`、`matchPath()`）
2. `frontend/<page>.html` —— HTML 根文件（同时是 Vite 的构建入口）
3. `frontend/src/entries/<key>.js` —— 该页面的挂载脚本（调 `mountPage(key, View)`）
4. `analysis/pages.py` —— 服务端：URL / 模板 / Vite 入口 / 标题

再补 ⑤ `templates/analysis/<tpl>`（继承 `base.html`），以及 ⑥ `vite.config.js` 的 `PAGES` 数组。

### 请求怎么走

```
浏览器 GET /differential/
  ↓  Django 路由：analysis/pages.py 的注册表里，differential/ 对到 differential.html
templates/analysis/differential.html（继承 base.html）
  ↓  {% vite_assets page_entry %} 读 manifest，注入**这一页自己的** js 与整棵依赖树的 css
  ↓  <div id="app" data-page="differential">
frontend/src/entries/differential.js → mountPage('differential', AnalysisView)
  ↓  点「运行分析」→ stores/platform.js 装配参数 → core/analysis.js 搜索
纯前端计算（不发请求）→ 结果写入 store + sessionStorage
  ↓  点左侧竖栏「结果与指标」→ <a href="/results/"> 整页跳转（不是客户端路由）
```

**改动生效路径**（很容易搞错，画清楚）：

```
frontend/src/**.vue|js ──改──→ 必须 npm run build ──→ static/dist/ ──→ Django（无需重启）
frontend/<page>.html   ──改──→ 同上（它是构建入口，不是模板）
analysis/**.py         ──改──→ StatReloader 自动重启 ──→ 立即生效
templates/**.html      ──改──→ 刷新浏览器即可
models.py              ──改──→ 必须 makemigrations + migrate
db.sqlite3 里的数据     ──改──→ 立即生效，**不需要**重启也不需要 rebuild
```

---

## 4. 铁律

按「踩坑频率 × 危害」排序。

### 4.1 改了前端源码必须重新构建

Django 读的是 `static/dist/`，**不是** `frontend/src/`。StatReloader 只盯 `.py` 文件，改 `.vue` / `.js` **不会触发任何重载** —— 你会看到"改了没反应"，然后开始怀疑人生。

### 4.2 `STATIC_URL` 必须带前导斜杠

```python
STATIC_URL = '/static/'   # ✅
STATIC_URL = 'static/'    # ❌ 全部 404
```

SPA 时代（history 路由，`/sbox/1` 这种多层路径）相对 URL 会被解析成 `/sbox/static/...`，**所有资源 404、页面白屏**。多页形态下每页路径层级不同，相对 URL 只会更不可靠 —— 带前导斜杠这条没有商量余地。

### 4.3 `SBox.size` 有两套含义（数据库 vs 接口）

```python
# 数据库里：size 存的是「位宽」
size = models.PositiveSmallIntegerField(choices=Size.choices)  # 4 或 8

# 接口输出：size 是「项数」，位宽另外叫 bits
{'size': 1 << sbox.size, 'bits': sbox.size}   # size=256, bits=8
```

**前端表格直接用 `size`（项数）**。改序列化时别把这两个弄反 —— 之前在 `_serialize()` 里已经转过一手，见 `analysis/views.py`。

### 4.4 DDT / LAT / 非线性度不落库

这些指标**每次实时计算**。不要为了"性能"把它们缓存进数据库 —— 一旦算法更新，库里的值和算出来的不一致，这是最难排查的一类 bug。同理，`SBox` 表里只存 `table_hex` 这个原始事实。

### 4.5 `.bat` 必须 CRLF + 纯 ASCII

`Write` 工具产出 LF 换行，而 Windows 的 `cmd.exe` 要求 CRLF —— LF-only 的批处理在多行 `if (...)` 块上会解析错乱，症状是**双击后窗口一闪而过**。另外不要在 `.bat` 里写中文（代码页漂移会乱码），也别加没必要的 `chcp`。

写完一律校验：

```python
raw = open(f, 'rb').read()
crlf = raw.count(b'\r\n')
assert crlf == raw.count(b'\n'), '存在裸 LF'
assert all(b < 128 for b in raw), '含非 ASCII'
```

### 4.6 页面路由逐条注册，接口路由放在兜底之前

`analysis/urls.py` 里，页面层由 `pages.py` 的注册表逐条生成，末尾才是那条只接**以斜杠结尾**的未知地址的 `re_path`（返回真 404）。

- 新增接口必须写在兜底 `re_path` **之前**，前缀也不能落在排除名单（`api/ health/ admin/ static/ media/`）里 —— 否则接口会返回 HTML 兜底页而不是 JSON，`/api/nope/` 这类地址尤其容易踩。
- 兜底 `re_path` 要求尾斜杠，是**故意让路**给 `CommonMiddleware` 的 `APPEND_SLASH`：它只在"没有任何 pattern 匹配"时才动手，而兜底能匹配一切 —— 不主动让路，`/ciphers` 就会被兜底接走变成 404，而不是 301 到 `/ciphers/`。
- 页面视图用 `def view(request, **kwargs)` 接住 URL 捕获组（详情页的 pk）。**忘了 `**kwargs` 会直接 TypeError**（`/sbox/1/` 曾经 500）。页面本身不关心参数，但必须能收下。

### 4.7 验证渲染后的 DOM，正则要留属性位

Vue 挂载后会给挂载点加 `data-v-app` 属性，`<div id="app">` 会变成 `<div id="app" data-v-app>`。

```python
re.search(r'<div id="app">', html)      # ❌ 永远匹配不到，会误判为"没挂载"
re.search(r'<div id="app"[^>]*>', html) # ✅
```

### 4.8 装包走国内镜像

直连 PyPI 在本机实测**卡 3 分钟无进展**（下载 6.5MB 的包）；清华镜像 **7 秒**完成。npm 侧已由 `frontend/.npmrc` 固定 npmmirror。

```powershell
.\.venv\Scripts\python.exe -m pip install <pkg> -i https://pypi.tuna.tsinghua.edu.cn/simple --progress-bar off
```

### 4.9 临时起的服务，验证完必须停掉

否则用户自己启动时会撞上 `WinError 10048`（端口已占用），看起来又是"启动失败"。**开发态的服务器由用户自己跑**，这样他能看到实时日志和报错堆栈。

### 4.10 不要把 `simpleui` 排在 `django.contrib.admin` 之后

顺序反了它不接管后台模板，而且是**静默失效**（不报错，只是没效果）。

### 4.11 参数只在 `core/params.js` 装配一次

界面、教程示例、集成测试**都从 `buildSearchOptions()` 取参数**，谁都不许自己拼一份。

这条是有血债的：`stores/platform.js` 曾经自己拼参数，把界面来的**字符串** `initDiffs` 直接透传给引擎，而引擎期望的是**四字向量的数组**（`[[0x2,0,0,0]]`）。结果引擎退化成按字符遍历，在 `inputState.join()` 处抛 `TypeError: inputState.join is not a function` —— 用户一填起始差分，整个分析页就崩。

教训：**类型转换（字符串 → 数组）必须发生在参数装配层**，不能推给引擎。`tests/verify-params.mjs` 与 `tests/verify-integration.mjs` 都锁住了这个行为，改参数字段后必须跑。

### 4.12 `core/` 里只能用相对路径 import

`stores/` 和 `views/` 可以用 `@/...` 别名（Vite 解析），但 **`core/` 下的模块必须用相对路径**。

原因是 `core/` 要能被 `node tests/*.mjs` 直接导入跑基准值 —— Node 不认识 `@` 别名，一旦用了，整个回归套件立刻全红。这不只是能不能跑的问题：参数装配逻辑之所以被从 store 里**拆出来**放进 `core/params.js`，就是为了让它可被 Node 测试覆盖。

### 4.13 SVG 的 presentation attribute 不支持 `var()`

`<path stroke="var(--accent)">` 会渲染成**黑色**（属性值不是 CSS 声明，不参与变量替换）。深色模式下就是黑线画在深底上，等于看不见。

正确做法：给元素加 class，在 `<style>` 里写 `stroke: var(--accent)`。`components/LineChart.vue` 就是这么处理的。

### 4.14 结果要能扛住刷新，也要能扛住整页跳转（`sessionStorage`）

本站是**多页站点**：从分析页点导航去 `/results/` 是一次**整页加载**，脚本全部重新执行、内存里的东西一个不剩。所以"结果只存内存"在这里不是"刷新才丢"，而是**一点导航就丢**。

现在 `stores/platform.js` 会把 `result` / `logs` / `empirical`（以及 `graph.toJSON()`）写进 `sessionStorage`，并带上 **结构签名**做校验：结构变了就整份丢弃（宁可不显示，也不显示属于别的结构的结果）。`graph.toJSON()` 也必须落盘 —— 否则用户在结构编辑器里改过的图，一跳去分析页就被重建回模板默认值。改结构 / 参数的表示形式时，记得同步 `structureSignature()`。

**验证这件事必须走真实导航路径**：`page.goto()` 是硬刷新，`page.locator('nav a').click()` 才是真实的站内跳转 —— 两者要分别测（E2E 第 5、7 节各测一种）。

### 4.15 浏览器 E2E 用托管工作区的 playwright-core，别装进项目

`playwright-core` 装在 `C:\Users\huawei\.workbuddy\binaries\node\workspace`（在项目外），运行时靠 `NODE_PATH` 指过去。这样项目本身保持零前端测试依赖，而 E2E 又能复用本机已装的 Chrome（`channel` 不指定，直接给 `executablePath`）。

```bash
# ⚠️ NODE_PATH 必须是 **Windows 风格** 路径（C:/… 或 C:\…）。
#    MSYS 的 /c/Users/… 形式 Node 认不出来，会静默失效、报 Cannot find module 'playwright-core'。
export NODE_PATH="C:/Users/huawei/.workbuddy/binaries/node/workspace/node_modules"
"C:/Users/huawei/.workbuddy/binaries/node/versions/22.22.2-3/node.exe" frontend/tests/e2e-browser.cjs
```

**不要用 `npx playwright install`**（那是 ~500MB 的 Chromium）。也不要用 agent-browser 技能，同理。

**E2E 必须跑在"当前代码"的服务上。** 后端若是我起过的 `--noreload` 进程（见 4.9），改过 `urls.py` / `views.py` 后它**不会**自动重载 ——
E2E 会以"新接口返回 404 HTML"的形式报出来（第 11.1 节那条断言就是干这个的）。跑 E2E 前先确认服务是新的，或直接重启。

### 4.16 视图模板里绝对不能写 `window`

Vue 模板表达式的作用域里**没有 `window`**（只有 `Math / Date / JSON` 等少数白名单全局）。写进去会被编译成 `_ctx.window` → `undefined`，点一下按钮就抛
`TypeError: t.href is not a function` 之类的错。

```vue
<!-- ❌ 一点就炸 -->
<button @click="window.location.assign(href('sbox'))">返回</button>
<!-- ✅ -->
<button @click="go('sbox')">返回</button>
```

站内跳转一律用 `src/pages.js` 的 `go(key, params)`；模板里用到的 `href()` / `go()` **必须记得 import**（`NotFoundView` 曾因为只写模板没写 import 而整页渲染失败）。
这类错误静态检查看不出来、只有点击时才发作，所以 `verify-pages.mjs` 第 4b 节专门静态盯着这两件事。

### 4.17 内置 S 盒两份数据必须同步

同一个 S 盒有两份数据，**改一边必须改另一边**：

| 位置 | 用途 |
|---|---|
| `frontend/src/core/sbox.js` 的 `BUILTIN_SBOXES` | 计算层用的内置表 |
| `analysis/migrations/0002_seed_builtin_sboxes.py` | 库里预置的种子数据 |

`tests/verify-seed.mjs` 逐字节比对两者，并用**库里的数据**算 DU / NL 作为锚点（SM4/AES = 4/112，PRESENT = 4/4）。
手工抄 256 字节的十六进制必然出错 —— 真要改，写个脚本从 JS 侧读出来生成迁移，别手打。

### 4.18 不要假设主键从 1 开始

库里预置 SM4 / AES / PRESENT 三条内置记录，但 **id 不是 1、2、3**（自增序号会被历史上建过又删过的记录推后），换台机器又不一样。

所以代码和测试都**不许硬编码 id**：需要真实记录时先 `GET /api/sboxes/` 取一个回来的 id。E2E 里写死 `/sbox/1/` 曾经在本地 404（这就是"本地能过、换台机器就红"的典型）。

### 4.19 页面必须声明 `rel="icon"`

不声明的话浏览器会自己去要 `/favicon.ico`，而项目里原本没有这个文件 —— **每次访问都在控制台留一条 404**。
现在 `base.html` 声明了 SVG 图标（源在 `frontend/public/favicon.svg`，Vite 拷进 `static/dist/`），另有 `views.favicon` 给 `/favicon.ico` 兜底重定向。

E2E 的控制台断言**故意把 favicon 404 算作失败**——别再写正则把它过滤掉，那是把真 bug 一起放过的写法。

### 4.20 测试里不许硬编码 id、也不许"过滤掉所有 404 再宣布干净"

两条同源的纪律：

- **预期内的 404 要显式记账并断言它确实发生**，而不是从错误列表里筛掉。E2E 第 11 节故意访问一个未知地址来验证真 404，那一次浏览器必然记一条 `Failed to load resource: ... 404`；代码里用一个 `inExpected404` 窗口把它单独收走，并断言"确实收到了"。这样剩下的任何一条控制台错误都是真问题。
- **别把断言写成"只要不出现某个字符串就算过"**。`verify-core.mjs` 之所以锁死 `647.00` 这种具体数值，就是为了防止"看起来跑通了"。

### 4.21 `Edit` 工具不要对同一个文件并行发多个调用

一次消息里对**同一个文件**发多个 `Edit`，会丢掉其中一部分改动 —— 返回的是 success，但盘上没变。2026-09-18 在 `SboxLabView.vue` / `SboxDetailView.vue` 上各丢过一次，而且不报错，很容易以为改好了。

改文件一律**串行**，改完用 Grep 复核关键行。

### 4.22 加一个页面要改四处，缺一处就是死链

见 §3「加一个页面 = 改四处」。`verify-pages.mjs` 会检查：注册表、HTML 根文件、入口脚本、服务端注册表、模板，五处必须一一对应；
同时它还盯着「不得重新引入 `vue-router`」「不得把十几个页面合回一个入口」——**不要退回单页应用**。

### 4.23 `format_html()` 没有占位符时会直接抛异常

```python
format_html('<div>纯静态的一段 HTML</div>')   # ❌ TypeError: args or kwargs must be provided.
format_html('<div>{}</div>', value)          # ✅
mark_safe('<div>纯静态的一段 HTML</div>')    # ✅ 纯静态内容用这个
```

`format_html` 的作用是**转义参数**；没有参数就无事可做，Django 直接报错而不是原样返回。

真实案例：`vite_assets.py` 的「前端未构建」分支用 `format_html` 包了一段**没有任何 `{}`** 的提示 HTML。
后果非常阴 —— 平时 `static/dist/` 在，这条分支永远不走，所有测试全绿；
一旦前端未构建、或 `npm run build` 正在清空 `static/dist/` 的窗口期内，**每一页都变成 500**，
而静态检查（Node 套件、页面结构断言）全都发现不了。

现在有 `analysis/tests.py::UnbuiltFrontendTests` 用 `mock.patch` 把这个分支强制走出来守着它。

### 4.24 改完前端要**真的重建**，并且盯住 `manifest.json`

Django 读的是 `static/dist/`，而 `vite build` 会**先清空整个 `static/dist/`**（含 `.vite/manifest.json`）。

- 判断构建真的成功了，看 **`static/dist/.vite/manifest.json` 存在**（或日志里的 `✓ built in`），
  不要只看 `assets/*.js` 在不在 —— 那是上一次的残留，长得一模一样，极易误判。
- 构建期间不要去跑 Django 测试（会打到"未构建"分支）。
- 实测 `vite build` 本身只需 **约 3 秒**。如果几分钟没动静，是 `npm` / 终端 shim 卡住了，
  不是构建慢 —— 直接用 `node node_modules/vite/bin/vite.js build` 绕开 `npm`。
- **Bash 工具前台跑构建可能被 SIGTERM 掐断**（实测两次）。落盘日志再读：
  `node node_modules/vite/bin/vite.js build > /tmp/build.log 2>&1`。
- ⚠️ **最阴的一种失败（2026-10-15 实测）：构建卡在 `✓ 89 modules transformed.` 后被杀，
  `static/dist/` 里 `assets/*.js` + `*.html` 全在（`ls` 看着完全正常），
  但 `.vite/manifest.json` 已被清掉 —— 于是每页 `HTTP 200` 却 <b>一个 `<script>` 都不注入</b>
  （`load_manifest()` → `None` → 模板静默跳过）= **整站白页**。**
  自检必须**看 HTML 内容**而不是看目录/状态码：
  `curl -s http://127.0.0.1:8011/differential/ | grep -c 'static/dist/assets.*\.js'` —— **必须 ≥ 1**。
  卡死后**必须重跑构建直到 manifest 回来**（成功只要 3~5 秒；>60s 即卡死）。

### 4.25 算法选项只有一份清单（`USER_TEMPLATE_IDS`），别各自遍历 `TEMPLATES`

界面上面向用户的算法起点**只有三个**：`sm4`、`aes_like`（类 AES）、`blank`。
清单维护在 `frontend/src/core/graph.js` 的 `USER_TEMPLATE_IDS` 里，**两个界面共用**：
算法选择页（`CipherSelectView.vue`）与结构编辑器的「恢复模板」下拉
（`StructureEditorView.vue`）。

`TEMPLATES` 里还有 `present_like` / `feistel_like` / `sm4_keyext` 三个定义，
它们**不作为选项出现**，但**不要删**：

- `present_like` 是三套回归测试的夹具（SPN + 4bit S 盒路径的覆盖），删了测试就红；
- 另两个是早期教学结构，留着备用。

**踩过的坑**：这两个界面原先各自 `Object.keys(TEMPLATES)` / `Object.entries(TEMPLATES)`
遍历一次。删选项时只改了算法选择页，结构编辑器的下拉里还留着已下架的模板 ——
两处各说各话。`verify-pages.mjs` 第 6 节现在盯着：清单内容、两个界面是否真的用它过滤、
**以及教程示例有没有引用界面上选不到的模板**（否则用户照教程做会找不到入口）。

---

### 4.26 `/bca/` 只能在 WSL 里跑，且它是一次**同步长请求**

`/bca/`（后端搜索）调 BCA_Light，而 BCA 的 `bca/solver.py` 用 `ctypes` 调 libc 的
`PR_SET_PDEATHSIG` 防孤儿进程（**Linux 专属**），kissat 也是 ELF 二进制。
所以 **Django 必须跑在 WSL 里**：

```
双击 start-platform-wsl.bat
  → cmd 调 wsl.exe → WSL 里 bash scripts/wsl-server.sh → python3 manage.py runserver 0.0.0.0:8011
  → Django（Linux）──本地子进程──> python3 bca_entry.py ──stdin/stdout JSON──> BCA
```

三条容易踩的：

1. **代码只有一份。** WSL 里经 `/mnt/c` 读 Windows 上这个项目目录，不复制、不同步。
   靠的是 `wsl.exe` **继承 Windows 当前目录**并映射成同名的 `/mnt/c` 路径 ——
   所以 `start-platform-wsl.bat` 里**不需要任何路径转换**，也因此能做到纯 ASCII
   （项目目录名是中文，转换逻辑一进来就得破坏铁律 5）。
2. **Windows 侧起 Django 时 `/bca/` 会显示「不可用」**，这是预期行为不是坏了
   （`bca_bridge._platform_problem()` 直接判平台）。平台其余部分照常工作。
3. **一次搜索是同步 HTTP 请求，可能跑几十分钟到几小时。** 所以要
   `mode=cache`（只读产物，毫秒级）做演示秒出通道，并配合**子进程超时**兜底。
   `--noreload` 是默认开的：自动重载会在文件变动时重启服务，把正在跑的搜索打断。

**别在 `cmd … > 文件` 里核对这个脚本的输出**：cmd.exe 与 wsl.exe 各持一个文件位置，
后写的会覆盖先写的，横幅看起来会"丢"。**管道和真实控制台都是正常的**，要核对就用管道。

### 4.27 S 盒有两处存储，画布下拉读的是**前端镜像**

S 盒在这套系统里有**两个互不相通的落点** —— 这就是「我在 S 盒库页导入的盒子，画布里选不到」的根因：

| 落点 | 谁写 | 谁读 |
|---|---|---|
| Django 数据库（`analysis.SBox`） | `/sbox/` 页、Django 后台 | `/sbox/` 页、`/sbox/:id/`、`/api/sboxes/` |
| 前端 `sboxLib`（`core/sboxlib.js`） | 结构编辑器的本地导入（`u_*`，落 localStorage） | **画布的 S 盒下拉**、算法选择页的 chip |

打通方向是**单向：服务端 → 前端**。双向会立刻带来"两边不一致时听谁的"这个没法回答的问题，
而 S 盒库页本来就是这份数据的唯一写入口 —— 单向拉取既够用又不会产生幽灵数据：

```
boot.js 挂载前 await syncSboxesFromServer()   // stores/platform.js
  → GET /api/sboxes/?full=1                    // 只有 full=1 才附 table_hex，避免 N+1 次请求
  → sboxLib.syncServer(entries)                // 整表替换；id 前缀 srv_<主键>；不落 localStorage
  → sboxRev.value++                            // 通知已挂载的视图重读 sboxLib.list()
```

四条必须守住的：

1. **必须挡在 `app.mount()` 之前。** 下拉是在 `computed` 里同步读 `sboxLib.list()` 的，挂载后再拉就来不及。
   `boot.js` 里给 CSRF 与同步各套了 3000 / 2000 ms 上限 —— 超时按"这步没成功"处理，降级成"只有内置 S 盒"，页面照常渲染而不是白屏。
2. **`sboxLib.list()` 不是响应式的。** 镜像晚到（超了上面那 2s）得靠 `sboxRev` 触发重算；
   `StructureEditorView` 的 `propFields` 与 `CipherSelectView` 的 `otherSboxes` 都显式读了它。
3. **`syncServer()` 是整表替换，不是增量合并。** 服务端删掉的这里必须跟着消失，否则会留"幽灵 S 盒"；
   与内置表**内容相同**的会被跳过 —— 不去重的话下拉里会出现两个「SM4」（库里也有种子，见 4.17）。
4. **改了盒子不等于界面会跟着变。** 图是**就地改**的（同一个节点对象），Vue 认为"没变"就不往下传失效 ——
   表现为「画布上换了 S 盒，右侧属性面板的下拉框弹回旧值」。修法是 `bump()` / 显式读 `rev`
   （`StructureEditorView.vue` 里 `propFields` 那段注释就是讲这个坑）。

`verify-core.mjs` 有一节专门测 `syncServer()`（去重 / 整表替换 / `srv_*` 取值 / 与本地导入并存）；
E2E 第 10 节端到端验整条通路。

### 4.28 BCA 运行进度：只读 CSV，**绝不起第二个子进程**

`/api/bca/run/` 是同步长请求，32 轮可能几小时，期间页面过去只有一个转圈。进度接口
`/api/bca/progress/` 补的就是这一段，三条设计约束：

1. **它读的是文件，不是求解器。** 轮询频率约 2 秒一次，而起一次 BCA 子进程要 1~3 秒、
   还会把 gurobipy 拉起来 —— 代价和收益完全不成比例。`bca_bridge.progress()` 直接
   读 `results/{task}/{cipher}/{model}/results.csv`（BCA 增量落盘的那份，见 4.26），
   路径拼法与 `bca/task.py` 的 `model_dir` 一一对应。
2. **不与 `run()` 共享 `_RUN_LOCK`。** 它不碰求解器，只是读一个正在被追加的文件，
   所以必须能和运行中的搜索并存 —— 共享锁会让"运行中"永远拿不到进度。
   `analysis/tests.py::BcaProgressTests::test_progress_never_spawns_a_subprocess`
   直接盯死 `_invoke`（起子进程的唯一出口），以后有人"顺手"改成调子进程，这条立刻红。
3. **半行 / 缺文件都不算错。** CSV 正被追加写，最后一行可能只写了一半 —— csv 解析不出来
   就跳过（少一格好过整个请求报错）；首次开跑时文件还不存在 → `ok:true / records:0 /
   finished:[]`，**不是 404**，因为前端在开跑前就开始轮询了。

只把**终态行**（`SATISFIABLE` / `UNSATISFIABLE`）算作"已完成轮"，`RUNNING` 占位行不计。
`cipher` / `model` 里出现 `/` `\` `..` 一律 400 —— 那三个字符都能跳出 `results/` 去读目录外的文件。

> **加路由的坑（本轮实测踩到）**：进度路由必须写在兜底 `re_path` **之前**（4.6）。
> 更隐蔽的是 —— 兜底路由排除了 `api/` 前缀，所以漏注册的路由不会返回 404 页，
> 而是 Django 自己的 `text/html` 404。E2E 里那条"必须是 JSON 而不是 HTML"的断言
> 就是为了让这种"看起来像路由不存在、实则是漏注册"的情况一眼可见。

### 4.29 S 盒详情页的热力图用 `<canvas>`，**不能**用 `<table>`

8 bit S 盒的 DDT 是 256×256 = **65,536 个格子**。用 `<td>` 渲染等于往 DOM 里塞六万多个
节点，页面直接卡死。`HeatmapGrid.vue` 用一张 n×n 的位图 + CSS 放大
（`image-rendering: pixelated` 保证放大后仍是方块）。

两条必须记住的：

1. **canvas 拿不到 CSS 变量。** `getImageData` / `putImageData` 操作的是原始像素，
   颜色只能写死（`#hex` / `rgb()`），`var(--x)` 在这里无效 —— 和 4.13 是同一类坑
   （SVG presentation attribute 也不认 `var()`）。所以配色选了一套对深浅主题都清晰的
   固定色阶：**蓝 → 青 → 黄 → 红**。不用"单色相 + 透明度"，是因为 DDT 的取值常常只有
   0/2/4 三档，只靠透明度区分时 2 和 4 在屏幕上几乎一样，等于白画。
2. **尺度要跳过第 0 行与第 0 列。** `DDT[0][0] = 2^n`、`LAT[0][0] = 2^(n-1)` 是平凡项，
   算进最大值会把真正要看的格子全淡到看不见 —— 这也正是 `differentialUniformity()` /
   `linearity()` 从下标 1 开始扫的原因。

热力图的输入是**实时算的**（见 4.4），页面按 `size` 动态取 16×16 或 256×256，
**不要写死 256**；坐标 hex 位数同理（4 bit 盒 1 位、8 bit 盒 2 位）。
E2E 第 11.1 节两种盒子都验。

### 4.30 部署配置读环境变量，但**默认值必须等于原来的开发值**

`SECRET_KEY` / `DEBUG` / `ALLOWED_HOSTS` / `CSRF_TRUSTED_ORIGINS` 现在都从环境变量读
（`cipher_platform/settings.py` 里的 `_env_str/_env_bool/_env_list`）。硬性要求：

- **不设环境变量时，行为与改造前一模一样**（`DEBUG=True`、`ALLOWED_HOSTS=['*']`、
  原来的开发用 `SECRET_KEY`）。否则"改个配置"就会让所有老命令静默变味。
- `ALLOWED_HOSTS` 的默认值跟着 `DEBUG` 走：生产（`DEBUG=False`）下不再放 `*`，
  必须显式给 `DJANGO_ALLOWED_HOSTS`。
- **`DEBUG=False` 时通过 whitenoise 托管静态文件**（中间件插在 `SecurityMiddleware`
  之后，`WHITENOISE_USE_FINDERS=True`，所以**不需要 `collectstatic`**）。whitenoise 用
  `try/except ImportError` 包着 —— 没装也不该让站点起不来，只是生产模式会缺静态。
- 真实的密钥走 `scripts/wsl-env.sh`（**已在 `.gitignore` 里**，模板见 `wsl-env.sh.example`），
  `scripts/wsl-server.sh` 启动时 source 它，并在自检段打印"密钥来自哪 / DEBUG / 静态托管"。

### 4.31 界面基调是「工业仪器」；说明性内容一律折叠

改界面前先读本节。目标是**像仪器，不像网站**。

- **令牌**全在 `frontend/src/styles/main.css` 两套主题块，组件里不许写硬编码颜色：
  `--radius:3px`(sm 2px)、`--shadow-sm:none`（另两档几乎不可见，层次靠 1px 边框 + 底色）、
  `--bg:#eceff3` 中性灰**不带蓝调**、`body 13px`/表格 12px/标签 10.5px、
  **无渐变 / 无发光 / 无 hover 上浮**（悬停只改边框色与底色）。
- **外壳三段式**（`App.vue`）：左侧分组竖栏（工作流/分析/数据/参考）+ 顶部上下文条
  （算法/模板/结构/轮数/模式）+ 底部状态栏。`--nav-h` 现在指**上下文条**高度（32px，原 58px 顶栏），
  各视图的 `top: calc(var(--nav-h) + Npx)` 仍读它，不必逐页改。
- **说明性内容一律走 `components/FoldPanel.vue`**（原生 `<details>`，默认收起，零 JS + Ctrl+F 可命中）：
  中文解析 / 安全性解读 / 逐轮说明 / 组件构成 / 算法背景 全部折叠；
  **中文解析只在出结果后才渲染**（`v-if="m && …"`）。

**选择器契约（E2E 依赖，改版必须原样保留）**：

| 选择器 | 约束 |
|---|---|
| `nav.nav a` | 容器仍 `<nav class="nav">`，每项 `<a>`，可见文本 = `pages.js` 的 `title` |
| `.metric` / `.m-label` / `.m-value` | `MetricCard.vue` 类名不许改 |
| `.tpl` | 必须可点的 `<button>`；`FoldPanel` 是**兄弟**不是子节点，否则点中心命中折叠标题栏 |
| `.sbox-chip` | chip 行**不许**收进折叠区 |
| `.strip .cell` / `.table tbody tr` | 条带与逐轮表常驻可见 |
| `details.fold` | 由 `FoldPanel.vue` 产出 |
| 正文含「中文解析」 | 折叠时正文不进 `innerText` ⇒ 折叠标题必须含这四字 |

**导航分组兜底**：`NAV_GROUPS` 只声明"哪些 key 归哪组"，顺序/路径/标题全从 `pages.js` 取 ——
漏写会自动落进「其他」组，不会凭空消失。**`NAV` 仍是 10 项**（`verify-pages.mjs` 有断言）。

---

### 4.32 8011 的"静默遮蔽"：WSL 的转发在 Windows `netstat` 里叫 `wslrelay.exe`

「后端跑不了」**最可能是端口遮蔽，不是崩溃**，而且 100% 静默：`scripts/wsl-server.sh` 在 WSL 内绑
`0.0.0.0:8011` 靠 WSL2 转发；若 Windows 侧还留着 `runserver 127.0.0.1:8011`，**Windows 赢下这个地址**
（更具体绑定优先），浏览器打到的是它 —— 它只能回 `available=false / reason=needs_linux`，于是 `/bca/`
永远说"要 Linux"，**用户以为 WSL 那份坏了，其实它好好的**。

**判谁占着 8011 必须看进程名，不能只看有没有 LISTENING**（`netstat -ano | findstr ":8011 "`）：

| owner | 含义 | 怎么办 |
|---|---|---|
| `wslrelay.exe` / `wslhost.exe` | WSL 自己的转发，后端已在跑 | 直接开浏览器；**不要再起第二个**（WSL 内 bind 失败） |
| `python.exe` 等 | 真的 Windows 遮蔽 | 杀掉该 PID 再起 WSL |

⚠️ 曾记过「WSL 服务在 Windows `netstat` 里看不到 LISTENING」—— **已被实测推翻**：看得见，只是进程名是
`wslrelay.exe`；据此写的守卫会把 WSL 自己误判成入侵者。`start-platform-wsl.bat` 现按进程身份分流
（relay→INFO+`exit /b 0`；其它→ERROR+`exit /b 1`），用了 `!OWNERPID!` ⇒ 必须是
`setlocal enabledelayedexpansion`，**别改回普通 `setlocal`**。复用手法：把守卫原样抽出、只改
`PORT=8012` 落到临时 `.cmd` 跑，不动正在服务的 8011。
⚠️ `pause` 打印的「请按任意键继续」是**本地化**文本 ⇒ 那两段输出不是纯 ASCII，抓取按 **GBK 兜底解码**。

---

### 4.33 「能画 ≠ 能算」：图必须真的被当回事（四个已修缺陷）

**能画不等于引擎会按它算。** 曾有四个断点，症状全是「不报错，只是数值与画布矛盾」，最难查。
**改这四块前先读本节**：

| # | 旧症状 | 现在 |
|---|---|---|
| ① | `meta.structure` **界面无入口**，只由模板 builder 写入 ⇒ 手搭 Feistel 永远带 `spn` 标记 | 元信息面板有「结构类型」下拉（SPN / Feistel / 广义 Feistel），选什么按什么算 |
| ② | 标 `feistel` 就路由到 `sm4RoundProfile()`（SM4 专用、**不收 graph**）。铁证：2 节点空图与真 SM4 模板 8 轮逐项同值 | 新增 `feistelGraphProfile(graph, opts)`，真沿图做「分割→分支→交叉→交换」 |
| ③ | 掩码传播只读 `state.get(e.from)`，**端口不参与** ⇒ SPLIT 的 `\|a`/`\|b` 只写不读，「右半进 F 再与左半异或」退化成「整字或在一起」 | 新增 `outMaskAt(state, nodeId, portId)`：先取 `state['node\|port']`，没有才回落 `state[node]` |
| ④ | 图上 S 盒与位宽到不了引擎（`params.js` 写死 `sboxRef:'sm4'`/`blockBits:32`）；`meta.blockSize` 又能改成 64 与引擎矛盾 | `buildSearchOptions` 从图派生 `blockBits`/`engine`/`sboxRef`（取第一个 SBOX）；`blockSize` 变**只读派生** |

配套的「同一条路走两遍会不一致」：

- **`engine:'sm4'` 只许落在内置 SM4 模板**（只有 `sm4` / `sm4_keyext` 带）。**别再写「线性模式或 feistel
  就送 SM4 引擎」**——那正是缺陷②的老写法。
- **单次运行与全轮扫描必须共用同一条分流**（`runProfile()`），否则收敛曲线与单次结果对不上且无提示。
- **`SPLIT` 要挡住 `>>> 32`**（JS 移位量按 32 取模，不挡则 `sb>=32` 变回整字、分支白设）。
- **元信息与属性面板是同一 card 的二选一**（`v-if="!selected"`）⇒ 必须有取消选中路径：画布空白绑
  `@click.self="deselect"`（`.wires` 是 `pointer-events:none`，所以真落在 `#canvas-inner`）。
  **别删 deselect**，否则缺陷①的界面入口不可达。
- `runEmpirical` 在 `engine !== 'sm4'` 时**诚实拒绝**（依赖 SM4 真实中间态）。

守卫：`verify-pages.mjs` 尾部（源码正则，逐条覆盖）、`verify-integration.mjs`【10】（数值层）、
`accept-four-defects.cjs`（真浏览器）。

---

### 4.34 「真拖真点」才暴露的三个缺陷（引擎两个 + 界面一个）

§4.33 那四个是**读源码**找的；从空白画布拖出「双鱼」Feistel（`design-shuangyu.cjs`）跑通后，
又在**拖、点、改属性**中抓出三个。共同点：**全不报错，数字看着还挺合理**。

| # | 旧症状 | 现在 |
|---|---|---|
| ① | 合并写死成**按位或**（`inMask \|= …`）。差分域 `A=L⊕F(R)` 与 `A=L\|F(R)` 从**第 3 轮**起分道扬镳 —— 或运算把「被异或抵消的差位」留在状态里，后续轮凭空多出活跃盒。实测双鱼 8 轮被抬成 **84.00/14**（真值 **66.00/11**） | `MERGE` 按节点自己的 `props.op` 合并（默认 `xor`）；`add`/`and` 无精确映射 → 保守按并集（数值**必须变**，正好当守卫）；前向加密同步改 |
| ② | 逐轮表列名「**输出状态**」但两路语义相反：SPN 塞轮末、Feistel 塞轮**首** ⇒ 同一列两种含义，末行与总览对不上 | Feistel 也塞轮末（`[Rin, A]`），轮首另存 `stateIn`。不变式：`perRound.at(-1).state === best.outputState` |
| ③ | 输入框用原生 `@change`，**失焦才发**，而失焦晚于下一节点的 `mousedown` ⇒「改完 A 直接点 B」把 A 的值写进 B 的 `props` | 描述符钉住归属节点（`nodeId`），`setProp(key,value,nodeId)` 按 id 定位**不回退**成"当前选中"；数值/文本改 `@input`（`<select>` 除外） |

- ①② 都是「**同一件事两处实现，走着走着就不一致**」⇒ 改 `propagateGraphOnce` 必须同时看
  `forwardEncrypt` 的 `MERGE`；改 `state` 语义必须同时看 `ResultsView.vue` 的 `hasState`（列名即契约）。
- ③ 只能靠**源码层正则**守（`verify-pages.mjs`）—— 把值写错对象不改变任何数值，数值层测不出。
- **引擎自证不算数**：这三个都是 `verify-shuangyu.mjs`（24 项）抓出来的 —— 它不复用平台引擎，
  自己重建 AES S 盒 / 穷举 DDT / 另写一份传播实现，再判平台日志里的 `A` 是按 XOR 还是 OR 算的。

守卫：`verify-pages.mjs` ③+/⑤ 段、`verify-integration.mjs`【7】（含末行 state 不变式）、
`accept-four-defects.cjs`、`verify-shuangyu.mjs`。

---

### 4.35 「方阵」SPN 实测：语义里没有的东西，界面也变不出来

样例：AES 风格 **128 位 / 4×4 字节 / 6 轮**，`SubBytes→ShiftRows→MixColumns→AddConstant`，末轮省 MixColumns。
留档 `outputs/方阵SPN设计记录/`，搭建 `design-fangzhen.cjs`，独立复核 `verify-fangzhen.mjs`（50 项）。

**三条平台语义（实测，不是猜的）：**

| 想做的事 | 平台实况 |
|---|---|
| 128 位分组 | `INPUT.bits` 是 `max:32`，填 `128` **当场夹回 32**（`onPropInput` 按 `field.max`）；「分块数」只进 `graphBlockSize()` 供显示，引擎只看 `graphBlockBits()`（一律 `min(32,bits)`）⇒ 界面 128 与日志「词宽 32bit」同屏 |
| 行/列操作 | 组件库无矩阵/行/列节点；`PERM` 只有**一个统一**字节移位量 ⇒ 表达不了「第 i 行移 i 字节」 |
| 列混淆 | `mixColumnsWord` 是**真 GF(2⁸)** 实现（2026-10-14 修）；但受词宽限制：**32bit = 一列**，不是 4×4 矩阵；尾列零填充成整列再截回，映射仍 GF(2)-线性（8bit 退化 `xtime`） |

**缺陷① `mixColumns` 曾「名不副实 + 两套实现」（已修）：** 值级写的是 `(b<<1)|(b>>>7)` —— 那是
**8 位循环左移**不是 xtime（`0x80`→`0x01`，真值 `0x1b`；256 输入里 128 个不同）；掩码级把字节掩码
**原样 OR 到下一字节**。同一个 `Δin` 有**三个**答案（平台分析 `0x00000101` / 平台加密 `0x03000001` /
真 AES `0x03010102`），分支数 3（AES 是 5）。最阴的副作用：掩码级对「四字节全活跃且相等」是**恒等映射**
（`0xdadadada→0xdadadada`）⇒「末轮省 MixColumns」**数字上完全不可观测**。
修法：只留**一份** `mixColumnsWord()`，掩码级取它的 **GF(2)-线性延拓**（`mixColumnsMask()`，逐比特基向量
XOR）⇒ 两者在 32 个基向量上必然一致。导出 `gf256Mul`/`gf256Xtime` 供独立复核对拍。
**修它的真正成本是连带更新**：类 AES 10 轮 `204.00/34` → **`222.00/37`**、线性 `180.00` → **`216.00/36`**
（`222=37×6.00`、`216=36×6.00`），同轮要改 `verify-core.mjs` / `TutorialView.vue` / `e2e-browser.cjs`。
`verify-fangzhen.mjs`【10】用**独立光束搜索**（自建 GF(2⁸)+穷举 DDT）从零复现 `1→5→9→…→37` ⇒ 不是凑绿。

**「末轮跳过某层」：条件逻辑仍然没有，但手工展开现在完全可观测。**

- 引擎主循环 `for (r=r0; r<=totalRounds; r++)` 每轮跑**同一张图**，节点拿不到轮次 ⇒「按轮次选层」
  做不到。这是**能力边界，不是缺陷**。
- 手工展开 6 轮成一条链（26 节点）+「结束轮=1」⇒ 一趟传播走完：差异放第 1 轮 ⇒ 权重 `30.00→12.00`、
  活跃 `5→2`；末轮省 MixColumns ⇒ 末轮 Δ 变（`0xb573e7c7` vs `0xb7023261`，修①前两者都是 `0xdadadada`）；
  且「展开 6 轮」与「统一轮函数迭代 6 轮」权重与末轮 Δ **完全一致**。
- 但**末轮的层不改变权重** —— 代价只统计「各轮进 S 盒的活跃字节数」（两份都是 `126.00`）。
  教学必须说清，否则会以为「少画一层 = 结果该变小」。

**同批修掉（+1 隐藏）：** ② 通用图**从不填 `outputState`** ⇒ 结果页「输出差分/掩码」恒为「(未记录)」，
现补 `ch.inputState`/`ch.outputState`。③ 界面「起始差分」在通用图被**忽略**，现 `analyze()` 与
`feistelGraphProfile()` 都吃 `initDiffs`（四字向量取**第一个非零字**，其余记 warn，**不静默丢**）。
④ 死属性：`展开为独立轮` **已删除**（不留"改了不影响计算"的开关）；`独立轮密钥` **接上语义**
（`keySchedule(name, round)`）。⑤ `forwardEncrypt` 从前**只跑一趟**（`rounds` 收下就丢 ⇒ 雪崩与轮数无关），
现按 `rounds` 真迭代。

**通用教训：** ① **组件的名字不等于语义** —— 要么接上语义，要么标「近似/无效」，否则用户拿教学近似当 AES。
② **同一语义不许两处实现**（根子是「掩码级传播」与「值级加密」各写一遍）—— 抽一份、另一处取线性延拓。
③ **只读派生显示与引擎口径可以不一致** ⇒ 把真口径（日志「词宽 32bit」）摆进同一视野。
④ **独立复核要能测出平台自相矛盾**：拿平台自己的加密校验平台自己的分析，不依赖外部真值即可证伪；
缺陷修好后同一批断言**翻转成正确性断言**（不是删掉）。

守卫：`verify-fangzhen.mjs`（11 节 **50 项**：GF(2⁸) 逐值 + 掩码/值/真 AES 三方一致 + 分支数 5 +
独立复现 222.00 + 能力边界与源码守卫）、`design-fangzhen.cjs`（真浏览器留档）。

---

### 4.36 「两种分析算出来一样」的两个层次：一个是真相等，一个是我们没告诉他

**① 双鱼这张图，差分与线性本来就相等（不是 bug）。** 把
`outputs/双鱼Feistel设计记录/shuangyu-project.json` 直接喂引擎，两条链路各算一遍都是 **66.00 / 活跃 11**
（**但掩码链不同**，别把「总数相等」读成「结果没换」）。**相等是必然的**：AES 盒 `DU=4` ⇒ 单盒差分代价
`−log₂(4/256)=6.00`；`linearity()=16`（`corr=16/128=2⁻³`）⇒ 单盒线性代价 `−log₂(corr²)=6.00`。两边都 6.00，
传播核每轮对每个活跃盒**取最优**，字节活跃模式又只取决于「哪些字节非零」（一进一出）⇒ 逐轮活跃数相同
（`1,1,2,1,2,1,2,1`）⇒ 双双 66.00。对照：SM4 32 轮差分 **647.00** vs 线性 **642.00** 是**不同**的
（SM4 的 DDT 有 prob=2/256 的项，差分代价会取到 7.00）。

**② 更常见的那一半：跨页显示的是「上一个模式」的结果，而且不吭声。** `result` 整站共享
（sessionStorage 只有一份），`AnalysisView` 换页**不会自动重算** ⇒ 差分页跑完点导航去「线性分析」，
标题写「每一步查 LAT」却原样显示 **647.00** + 差分那张逐轮表，点运行才变 **642.00**。`ResultsView` 更糟：
徽标与解析读**当前会话模式**（`mode.value`）⇒ 给差分结果打「线性」标签，**界面在替结果说谎**。

**修法：**

- `AnalysisView` 加 `staleMode`（`result.mode !== 当前页 mode`）弹 `.stale-result` 警告，点明显示的是哪个模式。
- `ResultsView` 的徽标 / 解析 hint / 导出报告一律改读
  `resultMode = result.char.mode || result.mode || mode` —— **跟着结果走，不跟着页面走**。
- `ResultsView.runCompare()` 曾自抄分流 `feistel || mode === LINEAR`（正是 §4.33 修掉的写法）⇒ 线性模式下
  所有图被送进 SM4 味 Feistel 引擎。修法：`runProfile` 从 store **export**、结果页复用 —— **分流只有一份**。
- 分析页常驻一句「两种模式的 −log₂p **可能相等**，这不是算错」+ AES 盒例子 + 判据（比较输入/输出掩码即可分辨）。
- 守卫：`verify-pages.mjs` +6（`runProfile` 必须 export／结果页不许出现 `isFeistel`、
  `mode === MODE.LINEAR ||`、`feistelCharacteristicSearch(`／必须有 `staleMode`+`.stale-result`／
  口径取自 `resultMode`／必须写明「可能相等」）；`e2e-browser.cjs`【12】+5
  （647 → 跳线性页出警告 → 重算 642 → 警告消失）。

**通用教训：跨页共享的「物证」（result / 图 / 参数）必须记住自己是从哪个口径产生的**，显示层按物证
**自己的**口径渲染。只按「当前页状态」渲染共享物证，就会出现「标题说 A、数字是 B」—— 这类错误
**所有静态测试都会过**，只有真点一遍才看得见。

### 4.37 后端算得对，但有两个「口径」在冒充同一个数（SM4 用例一核对）

**一句话**：`/bca/` 的 `[0,0,0,6]` 是**全空间精确下界**，平台默认参数给的是**束搜索上界**；
两个数长得像同一个指标、含义相反。初版曾因此怀疑「后端不是 bca_light 的代码」—— 那个判断是错的。

**四条必须记住的**

1. **后端是真代码**：8011 的 owner 是 `wslrelay.exe`（不是 Windows 侧 `python.exe`），
   `readlink /proc/<pid>/cwd` = 本项目根，真调 kissat（非 mock）；输出与首次跑通记录逐项一致。
2. **`[0,0,0,6]` 可证，不是口径辩论**：`s = ΔX₁⊕ΔX₂⊕ΔX₃`。取 `Δ=(b,b,b,0)` ⇒ `s₁=s₂=s₃=0`
   ⇒ 三轮 S 盒恒不活跃 ⇒ 前 3 轮概率恒 **1**（20000 次随机明文、0 次不匹配）；第 4 轮 `s₄=b`，
   要它为 0 只能 `b=0` ⇒ **至少 1 个活跃盒**；SM4 的 DDT 元素皆偶 ⇒ 最大 DP `4/256` ⇒ 权重 ≥ **6**，
   且后端 P6 SAT 可达 ⇒ **4 轮下界 = 6**。
3. **平台的数只保证「上界」**：起点集合是**结构化**的（16 个单字单比特 + 32 个 `Δ=(a,a,a,0)`），
   拿不到别的入口 ⇒ 5 轮起偏高（`30/49/73/92` vs 后端 `12/12/30/38`）。
   ⚠️ **别写「扩起点无解」**（本节旧版这么写过、已被推翻）：束宽确实无用（beam 8/24/64/exact 全 `30.00`），
   但补一族 `Δ=(L(τout),δ,δ,δ)` 后 5 轮**立刻 `12.00`**；只是「打地鼠」—— 补族后 6/7/8 轮仍差
   （`36/55/79` vs `12/30/38`）。**定夺：不补起点、只标上界**（入口池混进「按答案调参」的补丁，
   比坦诚标上界更危险）。
   📌 蒸馏时校正：旧 ⑧ 把「补族后 6/7/8」误写成 `49/73/92`，那三个数是**未补族**的默认值；
   正确的补族后值是 `36/55/79`（旧 ⑥）。两组数字的原始上下文都留在 `docs/铁律案例史.md`。
4. **`bca/util/path.py` 的路径打印把比特序反了**（按 LSB-first 打印，而模型内部与 espresso 数据都是
   MSB-first）：状态字要按**整体 32 位反转**读回，否则一条正确特征会被打印成「不可能」的样子
   （`R4-P6` 打印 `in=0x9F out=0x54`，真 `DDT = 0`；反转读回 `0xF9→0x2A` 才 `DDT = 4`）。
   **求解 / 权重 / 判定完全不受影响**，只坑人工核对。**定夺：不改**（属「逐字节移植参考部件」；
   口径标注与精确下界展示已在界面落地）。

**唯一数据源** = `core/bca-reference.js: BCA_CMP`（教程页与结果页都读它，不许各自内联 —— 铁律）。
📌 **10-17 已收口**：页面不再展示前端束搜索值，只显示后端精确解、未解写「还未求解」——
两个数并排的前提消失了，见 **§4.40**。`BCA_CMP` 退为历史对照 / 测试基准。
**守护**：`verify-pages.mjs`（8 行数值 + 「上界 / 精确下界」措辞 + 徽标 + 内联对照 + 复核链接契约）
+ `_probe-results-cmp.cjs`（23 项真浏览器：一致档 / 分岔档 / 超范围档）
  📌 **10-17 起这个探针已过时**：它验的是「两列对照卡」，而那张卡已随前端求解一起删掉（§4.40）。
  现在对应的守护是 `verify-bca-solve.mjs` 的 C 段（断言页面**不再**出现束搜索值）。
**证据**：`outputs/BCA-平台SM4口径核对/`（含**演示话术卡**）、`outputs/BCA后端核对/`。
**过程明细**（①~⑧ 完整推导、落地清单、探针踩坑）→ `docs/铁律案例史.md`。

**通用教训**：数值对不上时，先问「**这两个数是不是在回答同一个问题**」——
把上界与精确下界并排展示而不标口径，比单纯算错更难查。

---

### 4.38 「拼图」实测：非平衡 Feistel + 宽查找表 —— 卡在「宽度」和「拼接」，不卡在查找表

样例：**96 位 / 4 轮**，每轮 `96 → L(32) + R(64)`（非等分）；`LUT` 取 R 的**高 16 位** → **32 位**固定映射；
`G` 取 R 的**低 48 位**过 3 个 **16×16 S 盒**；更新 `新L = G(R_low48) XOR 旧L`、`新R = LUT(R_high16) ‖ R_low48`。

| 要点 | 结论 | 卡在哪 |
|---|---|---|
| ① 非等分 32+64 | ⚠️ 单字内 A/B 宽度可不同，**32+64 不行** | `INPUT.bits` / `SPLIT.splitBits` 上限都是 **32** ⇒ 没有节点能承载 64bit 的 R |
| ② 16→32 查找表 | ✅ **已可正确使用**（本轮修复） | 修前会算错；宽输出线性侧**显式标「不支持」** |
| ③ 高 16 / 低 48 提取 + 拼接 | ❌ | 提取仅限 ≤32bit 字；`MERGE` 只有 `xor/add/and`（同位置合并），`LINEAR` 的 `rotl/rotr` **没有「左移补零」** |
| ④ 左右不等宽 + 功能不对称 | ⚠️ 分割与连线能表达宽度差 | 内核 `feistelGraphProfile` 只取**一个** `branchBits`（只支持对称 Feistel）；端口**不标位宽** |

⇒ **整图搭不出，卡 ① 与 ③，不卡 ②**。但 ② 这类「能搭出来却算错」是**真缺陷**，已修四处：

- **D1 `SBox.outSize` 的 JS 回绕**：`1 << outBits` 在 `≥31` 时坍缩（`1<<32 === 1`、`1<<31` 变负）⇒
  32bit 输出的表 `outSize = 1` ⇒ DDT/LAT 全零、`bestTransition` 报 `prob = 0`。修：
  `outBits >= 31 ? 2 ** outBits : (1 << outBits)`，并引入 `SBOX_TABLE_CAP = 1<<24` + `fullTableFeasible()`
  作为「能不能建全表」的唯一判据。
- **D2 非等宽盒「平铺 OR」**：`splitSBoxInputs` 的 `'parallel'` 按**输入位宽**为步长平铺 ⇒ 32bit 输出与
  相邻块**重叠 OR**（`0x00010001` 查表必错）。修：`inBits !== outBits` 时**整字一次查表**。
  **这是「能搭出来、也能加密，但掩码级算错」的典型。**
- **D3 掩码级与值级自相矛盾**（D2 的连带，D1 放大）：同一次查表，值级确定、掩码级 `prob=0`。
  修 D2 后 ≡ 独立穷举；并给 `TraceStep` 补**结构化布尔** `unsupported`（判语义别正则匹配中文文案）。
- **D4 大盒打崩 `analyze()`**：16×16 盒 DDT `65536² ≈ 4.3G cell`。修：`getDDT()/getLAT()` 超限
  **显式抛错**（可预期的拒绝，不是静默假表）；差分改**按需单行** `ddtRowOnDemand`（O(inSize)，**精确**）；
  线性侧返回**显式「不支持」**占位，**绝不返回 0 冒充**零相关。

**为什么修了边界却不动基准值**：修的全在 8bit 方盒之外的路径；`verify-pintu`【0】专门锁 `8bit outSize = 256`
⇒ SM4 / 类 AES / 双鱼的权威值**一个字没改**。
**两条平台事实**：`SBOX` 节点**没有「输出位宽」入口**（宽度由所引用的盒决定）；
`graphBlockSize` 的 `blocks` 派生（32×3 = 96）**只是界面显示**，引擎只看 `graphBlockBits()`（≤32）。

守护 `verify-pintu.mjs`（**46 项**：独立穷举差分行 + 按公式重算 LUT + 源码守卫钉死「不许回退」）。
⚠️ 本例**无浏览器留档 / 无 session.json**（整图搭不出来），复核是纯 Node 的独立穷举对拍。
证据 `outputs/BCA-拼图能力测试/`；过程明细 → `docs/铁律案例史.md`。

---

### 4.39 「跑得快，结果对不对」复核：默认参数对，调大「分支上限」会错（10-16 实测）

永久套件 `verify-accuracy.mjs`（**54 项**，`npm run test:accuracy`）。**结论三层，别混着说**：

1. **快 = 按公式算，不是数明文对**：沿一条选定差分路径把各活跃 S 盒的 DDT 表项概率**相乘**（Markov 假设）。
   32 轮 `−log₂p = 647` 若要暴力计数需 `2^647` 对样本 —— 不可能；引擎 **440ms** 出结果，耗时对轮数
   **近似线性**（R8 96ms → R16 210ms → R32 440ms，无指数爆炸），起点只有 ~48 条。
2. **默认参数下每条特征都真实可达**：另写一份 256×256 暴力 DDT + 另写 L 变换，逐轮重算 ⇒ 权重与 Δout
   与平台**逐位相等**（R = 4/5/8/16/32）；再用**真实 SM4 加密**抽样：3 轮确定性 `3000/3000`、
   4 轮实测 `2^-5.972`（理论 `2^-6`）、5 轮 BCA 路径实测 `2^-12.086`（理论 `2^-12`）。
   ⇒ **R1~R4 与 BCA 全空间精确解相等**（`0/0/0/6`），这几档就是精确最优。
3. **5 轮起是权重上界**，不是全局最优。差距在**默认起点集合覆盖不足**，不在搜索算法 ——
   束宽 8/24/64 与分支上限 1~64 全试过，R5 恒 `30.00`；把 BCA 那条 2 盒路径入口
   `Δin = (0x4d31317c, 1, 1, 1)` 喂进**同一个引擎** → 立刻 `12.00`。

**🔴 揪出的真缺陷：`enumTauBranches` 丢活跃字节（「分支上限」越大反而越错）**

旧写法 `combos = nxt; if (combos.length > 256) break` 会把**还没展开的活跃字节整块丢掉**，`τout` 那些字节
恒为 0；而对非零输入差分 `DDT[Δ≠0][0] ≡ 0`（S 盒是双射）⇒ 该分支**真实概率为 0**。
症状：**调大「分支上限」反而报出物理上不可达、且更小（看着更优）的权重**。

| branchLimit | 修前 | 独立重算 | 修后 |
|---|---|---|---|
| 1 ~ 6 | 30.00 | 30.00 | 30.00 |
| 7 / 8 / 16 | **24.00** | **∞（概率 0）** | 30.00 |
| 32 / 64 | **18.00** | **∞（概率 0）** | 30.00 |

阈值 `7³ = 343 > 256` ⇒ **`branchLimit ≥ 7` 触发**，界面范围正是 **0~64**（默认 `0` → 实际用 4，
**所以权威基准值一直是对的，这也是它长期没被发现的原因**）。
修：① 不再 break，改为「**逐字节只保留概率最高的 `limit` 条前缀**」—— 对 top-`limit` 完整组合**精确**
（同后缀 ⇒ 前缀不劣则组合不劣），规模恒 `O(limit)`；② 加**防御断言**「活跃字节输出为 0 的组合直接丢弃」
（宁可不输出，也不报假特征）。修后 1~64 全档恒 `30.00`，且 32 轮由 `647.00` **真改善为 `646.00`**。

**连带断言翻转**：`verify-core` 曾锁「`branchLimit=8` 两模型开始分叉（PWM `505.00` / PMM `511.00`）」——
那两个数远低于真实可达的 `646.00`，是丢字节造成的假「更优」。改为「bl=8 两模型均 `646.00`」
+「bl=64 **不得 < 646.00**」（单边：12s 预算会截断这一档）。
**教训：测试锁到「异常现象」时，先问它是特性还是缺陷。**

**顺带修口径方向**：页面原写「`−log₂p` 是**概率的**上界」—— **方向反了**。正确：**权重上界（等价地概率下界）**；
真实最优只可能更小 ⇒ 上报数字把攻击难度说得**比实际高 = 偏乐观**，**不能当安全性保证**。
已改 `ResultsView` / `AnalysisView` / `HomeView` / `core/bca-reference.js` 并加守卫。

证据 `outputs/BCA-速度与正确性复核/`（含**修复前原始输出对照**）；过程明细 → `docs/铁律案例史.md`。

---

### 4.40 页面数值只有一个来源：后端 BCA 全空间精确解（10-17 改造）

**一句话**：**前端不再求解**。结果页 / 教程页 / 首页看到的每个权重都来自 `/api/bca/run/`；
没跑到的轮次显式写「**还未求解**」，绝不拿前端近似值顶上去。

**动机**：§4.37 + §4.39 留下的「同屏两个数」——1~4 轮两边相等、5 轮起前端 `30` vs 后端 `12`。
既然这两个数回答的本来就不是同一个问题，最稳的做法是**只留一个**（用户定夺：删前端求解、走后端 API）。

**链路**：`stores/platform.js: runAnalysis` → `core/bca-solve.js: solveWithBca` → 注入的
`api.bcaRun` / `api.bcaProgress`。适配层**不 import 任何 HTTP 客户端**（`run`/`progress` 由 store 注入）
⇒ 能被 node 单测直接 `import` 加载，不会踩路径别名。

**三道拦截（任一不过就 `throw`，绝不静默退回前端算）**

1. `bcaChannel({engine, model, attack})`：只有 `sm4`/`aes` + 差分/线性 + `weight`（→ `MAP`）有后端通道；
   `present`、`aes_like`、用户自搭图、`map`/`dual` 模型一律拒绝。
2. `structureSignature()` 结构指纹：图被改过（τ / 线性化 S 盒 / 换结构）就拒绝 ——
   否则会出现「界面显示改过的图、拿回标准算法的数」。
3. 起始轮必须为 1：后端 `R{n}-P{w}` 是**累计绝对值**，从中间起跑的数没有意义。
4. **「起始差分」填了内容也要拒绝**：那是**前端起点族**参数，后端做的是**整个差分空间**的搜索。
   放行就等于「界面写着 `0,0,0,1`、数字却是全空间最小值」—— 两个不同的问题共用一个数（§4.37 同型）。

**四个只有实测才会发现的口径（都已在适配层定死）**

| 坑 | 真相 | 证据 |
|---|---|---|
| 线性（`attack=linear`）模型 | 必须 **`LIN`**，不是 `MAP` —— `attack` 只把数据换成 LAT，`MAP` 仍按差分的界推进 | `BCA_MODEL_BY_ATTACK`，`verify-bca-solve` A3b/A3c |
| 线性权重读哪 | **不能读 `records.prob`**（那是 AS 阶段 SAT）；真值在 `summary.rounds[].linear_weight_exact` | SM4 线性 R4：`prob=1` / `exact=6.0`，B27~B30 |
| 线性走哪种 mode | **必须 `run`**：`summary` 只在真跑时产出，`cache`/`auto 命中` 返回 `summary: null`（只读 CSV，而 CSV 没有回填值）⇒ 拿 `auto` 会静默给出 `1` | 温跑 3.8s 出 `6.0`；缺 summary 时 `buildFromBca` 全标 pending + `linearMissingSummary`，B31/B32 |
| 路径明细的状态字 | `path.py` 是**低位在前**打印 ⇒ 必须**逐 32 位字位反转**（不是字序反转） | 4 轮抽样：原样 `0/40000`、位反 `593/40000`=1.48%（期望 1.56%），B23~B26 + D1 |
| 后端子进程护栏 | 32 轮必撞 120s，返回 `{ok:false, reason:'timeout', partial:{records}}` —— **超时≠失败**，`partial` 要照常渲染 | `usableResponse()`，C10/C11 |

**未求解的语义**：`buildFromBca` 对没有 SAT 记录的轮次给 `pending:true` + `weight:null`
（**不是 0** —— 0 是「免费轮」，会被读成概率 1）。页面写「第 N~M 轮还未求解 —— 后端仍在往这一轮推进」。
后端不提供的口径（`mapWeight`/`diffusionWeight`/`dataComplexity`/`dualScore` 等）一律 `null`，
**宁可不显示也不前端补算**；变量数 / 子句数取后端实测 `var_count`/`clause_count`（线性取 LIN 重建后的那行）。

**删掉的东西**：`normalizePerRound`、`SEARCH_MODEL` 引用、结果页「三种搜索模型对比」卡、
「前端上界 ⇄ 后端精确」对照卡。`core/bca-reference.js: BCA_CMP` 保留，但**只作历史对照与测试基准**，
不再驱动页面。

**同页不许有两个来源**（结果页两处已改）：
① 「本次使用的参数」用 `usedParams` 过滤掉 `searchDepth/beamWidth/branchLimit/maxCandidates/
timeBudgetMs/lambda/snr/guessRounds/auxVars` —— 后端一个都不读，并排摆着就是「假装用了」；
② 「建模规模分解」的明细只在**非后端**结果下渲染（前端模型 4,417 变量 vs 后端 CNF 1,676，
两套数并排必被追问），后端结果改为一句指向指标卡的后端实测值。

**实测（10-17，任务 `web`，SM4/MAP/差分）**：`mode=cache` **365ms** 返回；
1~8 轮全部解出：`0 / 0 / 0 / 6 / 12 / 12 / 30 / 38`（预热 `mode=run` 用了 572s）。
请求 32 轮时会在 120s 护栏处被中止，页面只报 1~8、其余写「还未求解」——
**这正是要的行为**，不是失败（`backend.timedOut` 会在「结果来源」里标成「本次实跑（护栏中止）」）。
线性（`web` + `LIN`）1~4 轮实测 `0/0/0/6.0`，19s 跑完，`linear_weight_exact` 与 `records.prob`
在 R4 分别是 `6.0` / `1` —— 读错字段就会把线性说小 5 bit。

⚠️ **引擎值（`6/92/274/647` 等）仍由 `test:core` 锁住** —— 那是**引擎能力**的回归基准，
**不是页面数值**。别把两者混着引用；页面只认后端。

**演示前置**：用 `mode=run` 把 `web` 任务跑到目标轮（断点续跑，可断可续），之后 `mode=auto` 命中即秒出。
**守护**：`verify-bca-solve.mjs`（79 项：能力判定 / 响应解析 / 源码守卫 / 忙时跟随 / 超时 partial）；
`verify-pages.mjs` 与 `verify-accuracy.mjs` 的措辞守卫已改到新口径（精确值 / kissat / 还未求解）。

---

## 5. 前后端契约

### 接口一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | 见 §3「页面与路由」 | 每个页面**各有自己的**路由与根文件（`@ensure_csrf_cookie`，首屏即下发 token） |
| GET | 其余未知地址 | 真 404（HTTP 404 + `404.html` 根文件） |
| GET | `/favicon.ico` | 重定向到 `static/dist/favicon.svg`（兜底，页面已声明 `<link rel="icon">`） |
| GET | `/health/` | 环境信息，不查库。含 `frontend_built` / `sbox_count` |
| GET | `/api/csrf/` | `{csrfToken}`，同时 `Set-Cookie: csrftoken` |
| GET | `/api/sboxes/` | 列表，`table_hex` 被截断（只给 `table_hex_len`） |
| POST | `/api/sboxes/` | 新建。成功 201 |
| GET | `/api/sboxes/<pk>/` | 详情，**含完整 `table_hex`** |
| DELETE | `/api/sboxes/<pk>/` | 删除 |
| GET | `/api/bca/status/` | BCA 后端自检：可用性 / kissat 路径 / 算法与模型清单。`?refresh=1` 强制重探 |
| POST | `/api/bca/run/` | 触发一次 BCA 差分路径搜索，或只读已有结果（见下节） |
| GET | `/api/bca/progress/` | **运行中的进度**：读正在被追加的 `results.csv`，回报已完成轮号。`?cipher=&model=` 必填，`?task=` 默认 `web`。**不起子进程**、与 `run` 不共享锁（见 4.28） |
| — | `/admin/` | SimpleUI 后台 |

全部返回 JSON（除页面与 admin）。**错误码约定**：`400` 参数非法 / `404` 不存在 / `409` 重名。
`/api/bca/**` 是刻意的例外：只有**请求体本身**不合法才 400，**BCA 的执行结果一律 200**，成败由 `ok` 字段表达（见下节）。

### 服务端校验规则

`_normalize_sbox_hex()` 会做完整校验，前端也有一份对应的（`core/hex.js`），**两边都必须拦**：

1. 去掉分隔符（空白、逗号、分号、冒号、下划线、连字符）与 `0x` 前缀
2. 只允许 `0-9a-f`，且长度为偶数
3. 项数必须是 2 的幂（≥16）
4. **必须是置换**：恰好覆盖 `0…n-1` 且互不重复 —— 分组密码的 S 盒必须双射，否则无法解密

前端额外给两条 warning（不阻断）：恒等置换、`S(0) = 0`。

### BCA 后端（精确差分路径搜索）

前端的 `core/` 引擎做的是**估算**；BCA_Light 做的是**精确搜索** —— 把差分路径编码成
CNF 交给 kissat 求解，能给出可验证的概率权重下界。两者互补，不是替代关系。

```
浏览器 ──HTTP──> Django（**跑在 WSL 里**）──本地子进程──> python3 bca_entry.py
                                                            │ stdin/stdout JSON
                                                            ▼
                                                    BCA（kissat + gurobipy）
```

**为什么 Django 必须在 WSL 里跑**：BCA 的 `bca/solver.py` 用 `ctypes` 调 libc 的
`PR_SET_PDEATHSIG`（Linux 专属），kissat 也是 ELF 二进制，Windows 原生跑不了。
而**让 Django 一起搬进 WSL、用本地子进程调 BCA**（而不是从 Windows 跨 `wsl.exe`），
是为了消掉跨系统边界 —— 那条边界上本项目实测撞过 5 类故障（僵尸 VM、UTF-16LE 编码、
`/mnt/c` 路径转换、SIGTERM 掐断、沙箱拦程序）。Windows 侧的 Django 会看到
`status().available = false / reason = needs_linux`，**是明确报错，不是静默失败**。

**为什么是子进程而不是进程内 `import bca`**：一次搜索可能跑几十分钟到几小时，
进程内调用没法设超时、没法 kill，它卡住站点就跟着卡死；而且 BCA 用的是**顶层包名**
（`from models import get_model`），塞进 Django 进程会污染命名空间；`Task.result_dir`
又是相对路径，子进程 + `cwd` 正好一并解决。

三个文件，职责分明：

| 文件 | 位置 | 职责 |
|---|---|---|
| `bca_entry.py` | `backend/bca_light/` | BCA 侧的 JSON 入口：stdin 收请求 → 调 `run_search` → stdout 吐结果 + 落盘产物。**BCA 源码零改动**（`bca/`、`models/` 仍可与上游逐字节对齐），`main.py` 照旧能用 |
| `bca_bridge.py` | `analysis/` | Django 侧：拼命令行、喂 stdin、解析 stdout、把失败翻译成人话（`reason` / `hints`） |
| `bca_status` / `bca_run` | `analysis/views.py` | 接口层；路由写在 `urls.py` 的**兜底之前**（铁律 4.6） |

**`mode` 三种取值**

- `cache` —— 只读已有产物，完全不跑搜索。毫秒级返回，**现场演示的秒出通道**
- `run` —— 跑搜索。BCA 自带断点续跑（同任务已记录的实例直接跳过），预热过的任务重跑也便宜
- `auto`（默认）—— 已有记录覆盖了请求的整段轮数就直接返回，否则真跑

**两个 `timeout` 不是一回事**：HTTP 的 `timeout` 是**子进程**护栏（超了杀掉 BCA，
已落盘记录不丢）；`solve_timeout` 才进 BCA 内部约束**单次 SAT 求解**。混用一个名字迟早出事。

**状态码**：请求体不合法用 400；**BCA 的执行结果一律 200**。后者是有意的 ——
超时 / 失败 / 后端没装好都是演示现场的常见情况，前端要能直接读到 `reason`、`error`、
`hints`，而不是被 fetch 的异常路径吞掉 body。

**演示前务必预热**：32 轮 SM4 要跑几小时，现场等不起。先跑一次让结果落进
`backend/bca_light/results/<task>/`，现场走 `auto` / `cache` 就是秒出。

**gurobi 的角色（最容易搞错的一点）**：MAP / MDW 的界计算走 MILP
（`models/map.py` 的 `compute_weight_bound`），所以**每次搜索都会调 gurobi**。
MILP 模型规模 = `轮数 × S盒数 × 7`，而 **Gurobi 的 pip 自带许可（`TYPE=PIP`）带 2000 变量上限**：

| 场景 | MILP 变量数 | 库存 `TYPE=PIP` 许可 |
|---|---|---|
| SM4 32 轮 | 32×4×7 = 896 | ✅ 够用 |
| AES 10 轮 | 10×16×7 = 1120 | ✅ |
| DBlock-256 20 轮 | 20×16×7 = 2240 | ❌ `Model too large for size-limited license` |
| Rijndael256 14 轮 | 14×32×7 = 3136 | ❌ |

⚠️ **但本机实际已不受这个上限约束**（10-11 实测，**如实记录，不粉饰也不背书**）：
`.libs/gurobi.lic` 已被**用户自行**改写为 `TYPE=NODE` + 假参（190 字节），实测
**500 / 1500 / 2000 / 2001 / 2240 / 3136 / 4417 变量全部通过**，横幅也不再打印许可来历行。
**上限是按许可的 `TYPE` 字符串判定的（只有 `PIP` 才加 2000），换 `libgurobi130.so` 与上限无关。**
所以：**别把 2000 当规划依据**（它现在不生效），但也**别依赖现状** —— 原 `TYPE=PIP` 那份已被覆盖、
**不可还原**（只能重装 gurobipy 取回）；这份 lic 一旦被改坏或删掉，MILP 直接不可用。

立场（**不因反复追问而松动**）：**不代改 lic / 不代部署到其它机器 / 不帮它"更像真的"**。
只如实报告事实 + 三项风险：① **无兜底**；② **学术诚信 / 答辩问询**（现场演示 + 毕设用途，许可来历无法交代）；
③ **数值可信度**（MILP 跑在来历不明的许可上）。**合法解 = 免费学术许可**（Named-User：无规模上限 /
本地文件 / 离线可用，适合断网现场）→ 拿 UUID → `grbgetkey` → `GRB_LICENSE_FILE=~/gurobi.lic`。

注意**两个"规模"要分清**：SAT 那边动辄十几万变量（不受限），受限的只有 MILP 这一侧。
`workers.milp = null` 只是让进程池用满 CPU，**不是"不调 gurobi"** —— 这点一度被误判过。

**可用的算法与模型**（别硬编码，调 `/api/bca/status/` 取）：

| 算法 | 总轮数 | S 盒数 | 算法 | 总轮数 | S 盒数 |
|---|---|---|---|---|---|
| SM4 | 32 | 4 | DBlock-128 | 20 | 8 |
| AES | 10 | 16 | DBlock-192 | 20 | 12 |
| Rijndael256 | 14 | 32 | DBlock-256 | 20 | 16 |

模型四个：`MAP`（w7 体系，单界数组）/ `MDW`（Matsui 双界 + ImpossibleBound）/ `AS`（活跃 S 盒递增）/ `LIN`（线性 Matsui，见下）。

### 线性（Matsui）攻击：`attack=linear` + `model=LIN`

**换攻击 = 换数据文件，不换搜索代码。** CNF 生成器只消费每个 S 盒的「禁止模式」
子句，而子句只回答「哪些 (a,b) 被允许」—— 与差分/线性无关。所以：

| | 差分 | 线性 |
|---|---|---|
| 数据文件 | `{DATA_NAME}_S-Box_Consts.{pkl,txt}`（espresso 从 DDT 提取） | `{DATA_NAME}_S-Box_Linear_Consts.{pkl,txt}`（**直接由 LAT 导出**） |
| 权重表 | DDT 自带 | `{DATA_NAME}_S-Box_Linear_Weights.json`（展平 \|LAT\|，下标 = a·256+b） |
| 生成方式 | 离线 espresso | `scripts/gen_linear_sbox_data.py`（WSL 无 espresso；按定义造禁止集，SM4/AES 各 4608 条） |

`load_sbox_constraints` 已按 `cipher.attack` 自动选文件；`Task`/`main.py`/`bca_entry.py`
的 `attack` 早就接受 `"linear"`。**线性侧此前缺的只是数据 + 一个会报精确权重的模型。**

**两级输出（`model=LIN`）**

1. `active_sbox_bound` —— 活跃 S 盒数（AS 主循环；差分与线性的活跃盒传播走同一套
   线性层，最小活跃数相同）。
2. `linear_weight_bound` = `6 × 活跃盒数` —— **严格下界**。口径来自
   `max|LAT| = 16 ⇒ corr = 2⁻³ ⇒ corr² = 2⁻⁶ ⇒ 每活跃盒 6 bit`。平台对外统一的
   线性权重就是这个值 —— 前端 `feistelCharacteristicSearch` 的线性 32 轮
   `642.00 = 6 × 107`，正是这条口径（差分/线性的**活跃盒传播走同一套线性层**，
   最小活跃数同为 107）。
3. `linear_weight_exact` —— 某条**具体特征**的真实权重 Σ(−log₂corr²)
   （单盒 = 14 − 2·log₂|LAT|，SM4 有 8 档）。AS 只数个数、SAT 又只返回**任意**
   一条最小活跃数解，所以这条**未必**是权重最小的那条（4 轮实测可能落在 |LAT|=6
   的盒上 → 8.83 > 6.0）。
4. `linear_optimal` / `linear_weight_exact_final` —— 见下「限制搜索」。

**限制搜索（把精确权重收紧到最优，`models/linear.py`）**：把活跃转移收窄到
`|LAT| ≥ 线性度`（即只许权重 6 的盒，`bca/util/linweight.py: restricted_extra_entries`
追加禁止子句），**在独立任务目录 `{task}-linref`**（`Ctx` 按任务名分目录，与基础趟
互不污染）重跑 AS。若最小活跃数不变 ⇒ 这条特征每个活跃盒都达最小权重 ⇒
`linear_weight_exact == linear_weight_bound` ⇒ **已证最优**（SM4 前四轮 = 6.0，与前端
`feistelCharacteristicSearch` 的线性口径完全一致）。

⚠️ **成本闸 `REFINE_CLAUSE_CAP = 2_000_000`**：追加子句数 ≈ 被禁转移数 × SBOX_COUNT × 轮数。
SM4（4 盒/轮）1~4 轮 ≈ 95 万 → 会做（~2 s）；AES（16 盒/轮）1~4 轮 ≈ 382 万 → **自动跳过**
（只给下界；跳过的原因在结果 `linear_refine_skip_reason` 里）。`refine` 参数
（`main.py --lin-refine auto|on|off` / 请求字段 `"refine"`）可强制开关。

⚠️⚠️ **改 S 盒数据后必须清 `results/<任务名>/`**（最容易踩的坑）。AS 主循环按
`results.csv` 复用已记录解（日志里的 `(recorded, skip)`）：**数据换了但任务名没换 →
会拿旧解重放**，报出的特征与限制搜索全对不上。本次修位序约定时就中过：不清缓存时
SM4 末轮精确权重报 `6.8301`（旧解落在 `|LAT|=8` 的盒上，而新限制集已禁掉它），
清掉 `results/verify-linear-SM4*` 后正确为 `6.0`。这条对**任何**改了
`data/espresso/*` 或 `gen_*_sbox_data.py` 的改动都成立。

⚠️ AES 未做限制搜索时，`linear_weight_exact` 只是**一条最小活跃数特征的权重**
（SAT 返回任意一条最小活跃解，**跨次运行会变**：实测两次 `227.29` / `215.21`）。
它是「实跑值」、不是全局最优；要引用就引用严格下界 `6 × 活跃数`。SM4 做了限制搜索，
`exact == bound` ⇒ `linear_optimal = True`，那才是可复现的最优值。

**独立复核**：`scripts/verify_linear.py`（换算法再走一遍，抓「自洽但错」）——
LAT 用 **WHT** 求（生成脚本用定义式双循环）；线性子句（4608 条，多数全指定）用
**逐点正向判定**（生成脚本用反向立方体标记）；差分子句（8599 条，全是带 don't-care
的立方体）用**反向立方体标记**（逐点扫描 2.2e9 次要 200 s+，标记法 0.1 s，两者已
对拍等价）；另加**掩码约定交叉锚**——两套数据的可用掩集分别 == 各自理想关系
（LAT / DDT，两轴同一个 `rev8`）⇒ 差分/线性落在同一掩码空间。`--search` 再跑端到端
断言（SM4 前四轮 活跃 `[0,0,0,1]`、下界 `[0,0,0,6]`、精确 `6.0`；AES 只验通用不变量
`下界 == 6×活跃` + `精确 ≥ 下界`）。纯 Python 部分在 Windows 也能跑。证据链
`outputs/BCA线性后端核对/`。

### CSRF

前端的 `<form>` 里没有 `csrfmiddlewaretoken` 隐藏域，走这条路：

```
启动时 GET /api/csrf/ → 拿到 token（服务端顺带 Set-Cookie）
   ↓
之后每个非 GET 请求带 X-CSRFToken 头（api/client.js 里自动处理）
```

用 Vite 开发服务器时浏览器来源是 5173、后端在 8011，属跨源，所以 `settings.py` 里有 `CSRF_TRUSTED_ORIGINS`。**新增开发端口时记得加进去**，否则 POST 会被 CSRF 中间件静默拒绝。

---

## 6. 代码约定

### 分层

| 层 | 位置 | 规矩 |
|---|---|---|
| 页面 | `analysis/pages.py` + 逐页视图 | 每个 URL 返回**它自己**的根模板，不做数据渲染（数据一律走 `/api/**`） |
| 接口 | `/api/**` | 只返回 JSON，不返回 HTML |
| 运维 | `/health/` | 不查库、不依赖外部资源 |
| **状态** | `frontend/src/stores/` | 全局单例（Vue `reactive`/`ref` 模块级导出），只管状态与编排，**不写数学** |
| **计算** | `frontend/src/core/` | **纯函数，不许碰 DOM，不许用 `@/` 别名**（见 4.12） |
| 展示 | `frontend/src/components/` | 哑组件，数值由调用方算好传进来 |
| 页面注册 | `frontend/src/pages.js` / `analysis/pages.py` / `vite.config.js` 的 `PAGES` | 三份清单必须一一对应（见 4.22） |

计算层之所以要隔离，是为了能用 `node` 直接跑基准值验证 —— 不依赖浏览器，出问题好定位。**新的算法代码一律放这里**，不要在 `.vue` 组件里写数学。

`components/MetricCard.vue` 刻意做成"哑"组件：同一个指标在分析页和结果页必须显示同一个数，所以格式化与计算**不放在组件里**。它的类名是 `.m-label` / `.m-value` / `.m-sub`（不是 `.metric-*`，写 E2E 选择器时注意）。

### 命名

- Python：模块 / 函数 / 变量 `snake_case`，类 `PascalCase`；视图函数名直接对应资源（`sbox_list` / `sbox_detail`）
- JS / Vue：文件 `PascalCase.vue`（视图）、`camelCase.js`（工具）；导出 `camelCase`
- 路由 `name` / 页面 key 用 kebab-case（`sbox-detail`），与 `src/entries/<key>.js`、`analysis/pages.py` 完全一致

### 注释

**写「为什么」，不写「是什么」。** 现有代码里有大量解释性注释（为什么 `STATIC_URL` 要带斜杠、为什么指标不落库），这些注释的价值比代码本身高 —— 请保持这个习惯，并更新过时的注释。

### 前端

- 组件用 `<script setup>` + Composition API
- 路由懒加载（`() => import(...)`），每个路由带 `meta.title`，`afterEach` 里同步 `document.title`
- 路径别名 `@` → `frontend/src`
- 样式：全局变量在 `styles/main.css`，组件内部用 `<style scoped>`

---

## 7. 怎么验证

### 第一层：纯 Node 回归套件（先跑这个）

```bash
export PATH="/usr/bin:/bin:/c/Windows/System32:/c/Users/huawei/.workbuddy/binaries/node/versions/22.22.2-3"
cd frontend
npm run test              # 依次跑下面九个，全绿才继续（共 832 项）
npm run test:core         # 149 项：引擎基准值 + S 盒库↔服务端同步 + ARX 精确模型/非等宽 S 盒守卫
npm run test:params       #  56 项：参数装配层
npm run test:integration  #  97 项：端到端集成，镜像真实调用路径
npm run test:pages        # 259 项：多页结构一致性 + 不得退回 SPA + 口径标注链路
npm run test:seed         #  27 项：内置 S 盒种子与前端内置表逐字节一致
npm run test:accuracy     #  55 项：★ 速度 vs 正确性 —— 独立重算 + 真实加密抽样 + BCA 对照
npm run test:bca          #  79 项：★ 后端通道 —— 能力判定 / 响应解析 / 位序 / 超时 partial / busy 跟随 / 源码守卫
npm run test:shuangyu     #  24 项：独立复核「双鱼」设计（需先跑过 test:design 生成留档）
npm run test:fangzhen     #  50 项：独立复核「方阵」SPN（需先跑过 test:design:fangzhen）
npm run test:pintu        #  46 项：独立复核「拼图」（纯 Node 独立穷举，无需 design 产物）
```

⚠️ **`test:bca` 的【D】段要读后端产物**（`results/web/SM4/MAP/details/path/R4-P6.txt`）做真加密对拍；
没有产物时**明确跳过并打印原因**，不假装通过。预热过 `web` 任务后这一段才有判别力。

零依赖、不用浏览器。**改了 `core/` 或 `stores/platform.js` 之后必须跑**，这是唯一能挡住"数值悄悄算错"的关卡。
`test:pages` 和 `test:seed` 改页面结构、页面注册表、内置 S 盒时必跑。
`test:shuangyu` 是**第二条独立路径**：它不复用平台引擎，自己从 GF(2⁸) 重建 S 盒、穷举 DDT、
按图另写一份传播实现再真加密抽样 —— 引擎自证不算数，得有个外部裁判。
`test:fangzhen` 是**第三条**，手法更狠：**拿平台自己的加密去校验平台自己的分析**
（`mixColumns` 两套实现互相矛盾就是这么抓出来的，§4.35），再加能力边界与 128 位/行列的源码守卫。
⚠️ 它同时锁**权威基准**：类 AES 10 轮 `222.00 / 37`、线性 `216.00` 由它独立复现（`1→5→9→…→37`）。
`test:pintu` 是**第四条**，专门复核「**能搭出来却算错**」那一类 —— 非等宽查找表（16→32）与超大盒
（16×16，DDT 全表 4.3G cell）：**独立穷举**差分行、**独立按公式重算** LUT，与引擎掩码级/值级对拍；
另含源码守卫，钉死 `outSize` 不许回退成 `1 << outBits`（§4.38）。
`test:accuracy` 是**第五条**，回答「跑得快 ⇒ 结果对不对」：**独立重算**（另写 256×256 暴力 DDT + 另写 L）
逐轮对拍权重与 Δout、**真实 SM4 加密抽样**验命中率、与 **BCA 全空间精确解**对方向与相等档，
外加「放大剪枝不许变好／不许变坏」的扫描 —— 就是它抓出了 `enumTauBranches` 丢字节缺陷（§4.39）。

### 第二层：服务端 Django 测试

```bash
.\.venv\Scripts\python.exe manage.py check    # 必须 0 issues
.\.venv\Scripts\python.exe manage.py test analysis   # 81 项（tests.py 33 + 引擎/记录 48）
```

`analysis/tests.py` 盯的是「只有真的跑过 Django 视图栈才能发现」的一类问题：每个 URL 返回的是不是**它自己**那个页面、
注入的是不是**它自己**那个入口 chunk、404 是不是真 404、接口 404 是不是 JSON、内置种子是否入库、
以及 BCA 进度接口的**参数校验 / 轮号解析 / 半行容忍 / 不起子进程**（`BcaProgressTests`）。
注：涉及资源注入的断言需要前端已构建，未构建时会 skip 并提示，**不会假装通过**。

`analysis/test_bca_engine_record.py` 是 `bca/record.py` + `bca/engine.py` 的单测（纯 `unittest`，不碰数据库，
也可 `python -m unittest` 跑）。两个模块的错都是**静默**的，所以断言全部落在磁盘产物上，而不是返回值：
CSV 行内容与**行序**（占位序=枚举序）、非终态行不算断点恢复命中、MAP 的 `msv=None` 与 pq 的 `0` 不许混键、
`bounds.json` **只记真正解出的格**（被 SAT 杀掉的 TERMINATED 格不许有界）、批内 TIMEOUT 必须抛错而不是
当 UNSAT 推进、`full_parallel` 在格数超 `jobs` 时写 0 并打告警。改这两个模块后必须跑它。
（已做变异检查：注入「lookup 不过滤非终态 / 终态不幂等 / bounds 键丢 p-q / 被杀格也写界 / TIMEOUT 不报错 /
`full_parallel` 恒 1 / 命中恢复仍重建 CNF」等 11 种缺陷，全部被测试抓红。）

### 引擎基准值（`test:core` 锁住的）

> 📌 **这些是「引擎能力」的回归基准，不是页面数值。** 页面只显示后端 BCA 精确解（§4.40）；
> 引擎值仍然要正确、仍然由 `test:core` 锁住，但**不要把 `647` / `92` 当成产品输出引用**。

| 项 | 权威值 |
|---|---|
| SM4 官方测试向量（加解密） | 见 `tests/verify-core.mjs` |
| SM4 差距分轮增长（beam=8，**扩起点后**） | 4→`6.00`/1、8→`92.00`/15、16→`274.00`/45、32→`647.00`/107 |
| SM4 **后端精确下界**（BCA 任务 `exact-r1-8`，2026-10-15 实跑 584.6s） | 1~8 轮 `prob_weight_bound = [0,0,0,6,12,12,30,38]` |
| 区间平移不变性 | 起点变、差值不变（1~16 与 17~32 都是 274.00） |
| 三种搜索模型 | PWM / PMM / DWM 给出同量级特征（默认下 PWM=PMM） |
| 线性分析 32 轮 | `−log₂p = 642.00`，活跃 S 盒 107 |
| S 盒指标（SM4） | 差分均匀度 = 4、非线性度 = 112、**线性度 = 16** |

⚠️ **默认起点集合已扩成「单字单比特 16 个 + 三轮免费族 Δ=(a,a,a,0) 32 个」（2026-10-15）。**
旧值（只跑单字单比特起点）= 4→`44.00`、8→`135.00`、16→`326.00`、32→`687.00`，是**更松的上界**，勿回退。
扩起点后 **R1~R3 = 0、R4 = 6**，与后端 BCA（在**整个输入差分空间**做精确 SAT 搜索，
1~8 轮 `prob_weight_bound = [0,0,0,6,12,12,30,38]`、AS 模型 `[0,0,0,1]`）**只有 1~4 轮一致**：
5 轮起平台偏高（`30/49/73/92` vs `12/12/30/38`）—— 见 §4.37 / §4.38，
差距根源是**起点集合没覆盖**，不是搜索算法（喂对起点同一引擎立刻算出正确值）。
「免费轮」是真实结构性质：Δ=(a,a,a,0) 让轮函数输入 ΔX₁⊕ΔX₂⊕ΔX₃ 恒为 0，
**第 1~3 轮无活跃 S 盒、概率 1；第 4 轮起必然 ≥1 个活跃 S 盒**
（要 4 轮 T 输入全零，方程组只有零解 —— 代数可证）。
⚠️ **第 5 轮起前端仍与 BCA 不同口径**（前端 5 轮 `30.00` vs 后端 `12.00`）：那是**启发式束搜索
vs 全空间 SAT** 的本质差距，扩起点解决不了（实测 beam 8/24/64/exact 结果全是 30.00）；
`647.00` 是**束搜索上界**，不是全局最小。别把任何一版数字当「全局最小」对外表述。

⚠️ **线性度是 16，不是 32**。参考实现 `verify_sm4.mjs` 里有条注释写 32，那是**过时注释** —— 实测 `linearity()` 返回 16，技能文档是对的。

**后端线性（`attack=linear`）的独立复核**：`backend/bca_light/scripts/verify_linear.py`
（纯 Python 部分 Windows 也能跑；`--search` 需 gurobi/kissat，在 WSL 跑）——

```bash
python3 scripts/verify_linear.py            # LAT(WHT) ↔ 权重表 ↔ 子句文件 三方对拍
python3 scripts/verify_linear.py --search   # 追加 SM4/AES 端到端断言
```

它换算法重算一遍（LAT 用 WHT、线性子句用逐点正向判定、差分子句用反向立方体标记），
与生成脚本 `gen_linear_sbox_data.py` **不同源不同法**，专抓「自洽但错」。共 7 项断言
（权重表 ↔ WHT、线性度 16、单盒权重 6.0、子句诱导集 ↔ 理想关系、条数公式、线性/差分
两套数据的**掩码约定交叉锚**），SM4/AES 各 7 项全过。SM4 锚点：活跃 `[0,0,0,1]`、
下界 `[0,0,0,6]`、精确 `6.0`。

⚠️ **跑 `--search` 前先清 `results/verify-linear-*`**（见 §5）：AS 会复用 `results.csv`
里的旧解，数据换了会假失败（实测 `6.8301` 而非 `6.0`）。
⚠️ AES 因成本闸跳过限制搜索，其「精确权重」是**一条**最小活跃数特征的权重、
**跨次运行会变**（实测 `227.29` / `215.21`），只引用严格下界 `6 × 活跃数`。

⚠️ **`sm4StateTrace()` 返回的是 `X0..X35`**（状态字序列），不是密文。曾经误取 `trace[3]` 当密文，白查了半天"引擎 bug"。

### 第三层：对着**跑起来的服务**探一遍（可选，但发版前做）

Django 测试用的是 test client，不经过真实 HTTP 栈。要确认「服务真的起来了、静态文件真的能取到」，用 Python 标准库直连（不引入 requests）：

```python
import http.client
for p in ['/', '/ciphers/', '/differential/', '/linear/', '/structure/', '/results/',
          '/logs/', '/sbox/', '/sbox/1/', '/check/', '/tutorial/',
          '/health/', '/api/sboxes/', '/api/csrf/', '/favicon.ico', '/admin/login/']:
    c = http.client.HTTPConnection('127.0.0.1', 8011, timeout=10)
    c.request('GET', p); r = c.getresponse(); b = r.read()
    print(p, r.status, r.getheader('Content-Type'), len(b))
    c.close()
```

**另外必须确认 `/api/nope/` 返回 404** —— 证明兜底路由没吞掉 API 命名空间。

### 浏览器：静态资源 200 ≠ 页面能跑

这是最重要的一条经验。文件能取到、MIME 正确，页面依然可能白屏。**必须用真实浏览器渲染。**

本机已装 Chrome，**用无头模式即可，不要装 agent-browser**（那要下 ~500MB Chromium，而这里秒级出结果）：

```bash
CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
TMP="C:/Users/huawei/AppData/Local/Temp"

# 拿渲染后的 DOM
"$CHROME" --headless=new --disable-gpu --no-first-run --no-default-browser-check \
  --user-data-dir="$TMP/cipher-verify-profile" --virtual-time-budget=15000 \
  --dump-dom "http://127.0.0.1:8011/" > "$TMP/dom.html"

# 拿截图（判断渲染效果，最直观）
"$CHROME" --headless=new --disable-gpu --no-first-run --no-default-browser-check \
  --user-data-dir="$TMP/cipher-verify-profile" --virtual-time-budget=15000 \
  --window-size=1440,1000 --screenshot="$TMP/shot.png" "http://127.0.0.1:8011/"
```

判断 DOM 时记得 4.7 的 `[^>]*`。**用截图做最终判据**，别只看 DOM 字符串。

### 浏览器：需要点击才能验证的路径（`e2e-browser.cjs`）

无头 Chrome 的 `--dump-dom` 只能看到静态渲染结果，**测不了"点运行分析 → 出结果"这种交互**。这类验证用 `frontend/tests/e2e-browser.cjs`（playwright-core，驱动本机 Chrome，见 4.15）：

```bash
export NODE_PATH="C:/Users/huawei/.workbuddy/binaries/node/workspace/node_modules"
cd "C:/Users/huawei/WorkBuddy/密码算法分析系统"
node frontend/tests/e2e-browser.cjs
```

它覆盖 13 组、102 项（**需后端在 8011 跑着**，且 `web` 任务要预热过 1~8 轮），
其中几个是**只有真实交互才能发现**的断言：

- 点「运行分析」→ 页面真的渲染出后端 8 轮精确值 `38.00`，8 张指标卡里的数字都不是 `undefined`/`NaN`
- 结果页「求解来源」写的是 `全空间精确解` + `kissat` + 任务名 `web`（不是"上界"）
- **填了起始差分 → 明确拒绝**（后端是全空间搜索，不接受起点；4.11 那个 `TypeError` 的崩溃回归仍被覆盖）
- 结果页经**站内导航**到达后仍读到同一份结果，且**硬刷新后不丢**（4.14）；「三种搜索模型对比」卡标着**已停用**且不留哑按钮
- 结构编辑器勾「仅 τ」→ 分析页**明确拒绝**（图被改过，不许拿标准 SM4 的数）
- 深色模式下**背景色确实变深、文字颜色确实变亮**（防"白底白字"）
- 「库里预置了 3 个内置 S 盒」+「详情页真的把这条记录渲染出来了」（而不是"加载失败"占位）
- **在「S 盒库」导入的 S 盒要能在结构编辑器里选到**（4.27 那条通路）：导入 → 列表标「画布可选」→ 算法选择页出 chip → 画布下拉出现该项 → 选中后下拉不弹回旧值 → 删除后同步消失；**类 AES 模板跑分析被明确拒绝**（无后端实现）
- **S 盒详情页的安全指标与热力图**（第 11.1 节）：SM4 的 DU/NL/线性度 分别为 4/112/16、两张 256×256 的 canvas 真的着了色（不是空白也不是单色）、导出切 C→Python 内容确实变；PRESENT 4bit 盒走 16×16 分支
- **`/api/bca/progress/` 没被兜底页吞掉**：返回 JSON 而非 HTML（路由漏注册会变成 Django 的 `text/html` 404，只有这一条能抓到）
- 「站内跳转是整页加载」—— 往 `window` 上放一个探针，点导航后探针**消失**即证明发生了整页加载、没有客户端路由（这是"不是单页应用"的决定性证据）
- 线性页：先看「陈旧结果」警告，重算后**结果对象的 mode / char.mode 都是 linear**、4 轮 `6.00`、警告消失（§4.40 线性口径）
- **全程零控制台错误**（故意制造的那一次 404 单独记账并断言它确实发生，见 4.20）

⚠️ 长跑命令在 Agent 的 Bash 前台会被 SIGTERM 掐断，**用 `run_in_background: true`**。
⚠️ **导航前等落盘**：命中缓存时结果 200ms 就回来了，而 `scheduleSave` 是去抖写的。
若「跑完立刻点导航」，sessionStorage 可能还没写进去 —— 测出来的会是竞态，不是产品缺陷。

### 浏览器：「能画 ≠ 能算」的专项验收（`accept-four-defects.cjs`）

§4.33 那四个缺陷 + §4.34 那三个缺陷，源码层由 `verify-pages.mjs` 的守卫盯着，**界面上到底通不通**
则由 `frontend/tests/accept-four-defects.cjs` 在真实浏览器里逐条走一遍（22 项）
（§4.35 那批是引擎层的，由 `verify-fangzhen.mjs` 50 项 + `design-fangzhen.cjs` 留档盯着）：

```bash
export NODE_PATH="C:/Users/huawei/.workbuddy/binaries/node/workspace/node_modules"
cd frontend && npm run test:accept        # 需后端在 8011 跑着
```

它验的是源码检查看不见的东西：结构类型下拉**改得动**、分组长度只读且**跟着 INPUT 走**、
点画布空白处**能回到元信息面板**、跨页跳转后**自己搭的图还在**、日志里走的**真的是 Feistel 图迭代**，
以及**同一张图换成 SPN 结构后结果确实不同**。实测（同一张「双鱼」图、8 轮）：

| 结构类型 | 活跃 S 盒 | 变量数 | 命中率 | 时间复杂度 |
|---|---|---|---|---|
| Feistel（分支迭代） | 8 个 | 937 | 25.00% | 2.10×10⁶ |
| SPN（单趟传播） | 0 个 | 905 | 100.00% | 32 |

⚠️ 第 4 节第 1 步会 `localStorage.clear()` + `sessionStorage.clear()` —— 它必须从干净状态起，
否则上一会话存下的图会让「默认是 spn / 分组长度 32」这类断言失真。

### 浏览器：「实操设计」留档（`design-*.cjs`）

```bash
export NODE_PATH="C:/Users/huawei/.workbuddy/binaries/node/workspace/node_modules"
cd frontend
npm run test:design            # 双鱼 Feistel  → outputs/双鱼Feistel设计记录/
npm run test:design:fangzhen   # 方阵 SPN（含「末轮跳过」手工连线对照）→ outputs/方阵SPN设计记录/
```

这两个**不是断言套件**，而是「真拖、真连、真改属性、真跑、每步截图」的演示与留档脚本：
它们从空白画布开始，逐个从调色板拖组件、按端口连线、逐节点设属性，最后跑差分+线性并落
`session.json`。两条硬约定：

- 节点一律**按标题定位**（`.n-title:text-is("…")`），每次改属性前先断言「属性面板选中的就是目标节点」，
  错位就抛错 —— 索引一旦错位会**静默改错节点**；
- `session.json` 是后续独立复核（`test:shuangyu` / `test:fangzhen`）的**输入**，先跑 design 再跑 verify。

---

## 8. 环境

### 解释器与运行时

| 项 | 路径 / 版本 |
|---|---|
| 虚拟环境 | `.venv/`（项目根） |
| Python | `C:\Users\huawei\WorkBuddy\密码算法分析系统\.venv\Scripts\python.exe`（3.13.14） |
| Node | `C:\Users\huawei\.workbuddy\binaries\node\versions\22.22.2-3\node.exe`（22.22.2） |
| 后台 | SimpleUI，`http://127.0.0.1:8011/admin/` |

**Agent 一律用绝对路径调用解释器，不要"先激活再调用"** —— 每次命令都是新 shell，激活状态不跨调用保留。

### Bash 工具的坑

1. **PATH 被覆盖**：默认的 PATH 缺 Windows 系统目录，`ls` / `find` 会报 `command not found`。开头先 `export PATH="/usr/bin:/bin:/c/Windows/System32"`。
2. **跑 npm 要手动补 node 目录**：`.bin/vite` 这个 shim 内部会调 `node`，PATH 里没有它就会失败。
   ```bash
   export PATH="/usr/bin:/bin:/c/Windows/System32:/c/Users/huawei/.workbuddy/binaries/node/versions/22.22.2-3"
   ```
   （用户自己终端里的 PATH 是正常的，只有 Agent 的 Bash 环境需要这样处理。）
3. **Bash 工具会「退化」到只剩跑 python / node**：2026-09-18 实测 `ls` 直接 `command not found`，而且 shim 里的 `dirname` 也缺，连 `export PATH=...` 那招都救不回来；`tail` / `head` 同样不可用。
   → 这种情况下**别硬扛**，换工具：列目录用 Glob、读文件用 Read、搜内容用 Grep、删文件用 PowerShell 或 `python -c "os.remove(...)"`。
   不要因为 Bash 报「命令不存在」就以为项目或环境坏了 —— 它跑 `python` / `node` 永远是好的。

另外：**PowerShell 5.1 用 `cmd *>> log` 重定向会写成 UTF-16**，和 UTF-8 混写后日志直接读不出来。统一用 `| Out-File -Encoding utf8`。前台跑 pip 还可能被 SIGTERM 掐断，长下载用 `timeout N` 或后台执行。

### WSL（BCA 后端实际跑在这儿）

BCA_Light 只能在 Linux 里跑（见 §5「BCA 后端」），所以**后端服务实际跑在 WSL 里**。

| 项 | 值 |
|---|---|
| 发行版 | Ubuntu 24.04.5 LTS（WSL 2.7.13 / Win11 26200） |
| 默认用户 | `<用户名>`（uid 1000，sudo） |
| 项目路径 | `/mnt/c/Users/<用户名>/WorkBuddy/密码算法分析系统` —— **和 Windows 是同一份文件**，代码不复制 |
| Python | `/usr/bin/python3` → 3.12.3 |
| Django | 6.1.1 + django-simpleui 2026.1.13（装在 `~/.local`，`--break-system-packages`） |
| kissat | `~/.local/bin/kissat`（4.0.0）—— 解析优先级 `BCA_KISSAT` > `config.json` 的 `solver.path` > PATH > 项目自带副本；唯一实现 `bca/config.py: resolve_solver_path` |
| gurobipy | 13.0.3（`~/.local`；许可走 `.libs/gurobi.lic` —— **已被用户自行改为 `TYPE=NODE`，2000 变量上限实际不生效**，详见 §5「gurobi 的角色」） |
| python-sat | 1.9.dev15 |

```bash
wsl                                                  # 进发行版
cd "/mnt/c/Users/<用户名>/WorkBuddy/密码算法分析系统"
python3 manage.py runserver 0.0.0.0:8011             # 注意是 0.0.0.0，Windows 侧才连得上
```

**两条网络通道都实测可用**：`http://127.0.0.1:8011`（WSL2 端口转发）与
`http://<WSL IP>:8011`（直连；IP 每次重启会变，形如 172.31.x.x）。
`ALLOWED_HOSTS` 因此必须在 DEBUG 下放开，否则 IP 兜底那条会直接 400。

**驱动 WSL 的坑**（每一条都真踩过）：

1. `wsl --status` / `wsl -l -v` 的输出是 **UTF-16LE**，而发行版内部命令是 UTF-8 —— 解码方式不同。
2. 多行脚本里带 `$VAR` 时**必须写成文件再 `bash` 跑**（`bash -c` 会把变量吃掉），且先 `sed -i 's/\r$//'` 去掉 CRLF。
3. 实例僵死时（连 `wsl --terminate` 都超时），先杀残留的 `wsl.exe` / `wslhost` / `wslrelay`（**需提权**）再 `--shutdown`。
4. **不要开 `networkingMode=mirrored`** —— 本机实测报 `0x8007054f`，回退后 WSL 连 `eth0` 都没有，得删掉 `~/.wslconfig` 才能恢复。
5. Ubuntu 24.04 有 PEP 668 保护，`pip install` 必须加 `--break-system-packages`；它会自动退化成 user 安装（落在 `~/.local`），不污染系统 Python。
6. **发行版会随「最后一个会话」退出而关停**（WSL 2.7.13；`/etc/wsl.conf` 里 `systemd=true`，无 `~/.wslconfig`）。
   10-14 实测：`setsid nohup` 的后台进程、以及 `systemd-run` 的临时单元，**都留不住它** ——
   会话一退，约 20 秒内整台发行版被关掉（后台进程一起没；`/tmp` 由 systemd 在下次启动时清空）。
   → 所以 `start-platform-wsl.bat` **必须保持窗口开着**：那不是随手加的说明，而是**唯一**能让 8011 持续可用的机制。
   本机另留了一个等价入口：`~/run-platform.sh`
   （`wsl.exe -d Ubuntu-24.04 -u <用户名> -- bash ~/run-platform.sh`，内容是 `cd <项目> && exec bash scripts/wsl-server.sh`）。
7. **8011 的 Windows 遮蔽会反复出现**：任何一次在 Windows 上跑 `manage.py runserver 127.0.0.1:8011`
   （典型是误点 `start-django.bat`）都会与 WSL 那份**同时监听同一地址**。
   可靠判据是 `netstat -ano | findstr ":8011"` 看 owner 的**进程名**：
   `wslrelay.exe` / `wslhost.exe` = WSL 那份（要的就是它）；`python.exe` = 遮蔽，`taskkill /F /PID <pid>` 清掉。
   ⚠️ 两者并存时**不会报错**，请求究竟落到哪一份要实测（`/api/bca/status/` 的 `platform` 字段）。

### 依赖

`requirements.txt`：Django 6.1.1 / django-simpleui 2026.1.13 / asgiref / sqlparse / tzdata

`frontend/package.json`（runtime）：vue 3.5 —— **没有 vue-router**（多页站点不需要，也别加回来）
`frontend/package.json`（dev）：vite 8.3 / @vitejs/plugin-vue 6.0

**项目本身零测试依赖** —— 五个回归套件只用 Node 标准库。浏览器 E2E 用的 `playwright-core` 装在**项目外**的托管工作区（见 4.15），不写进 `package.json`。
服务端测试用 Django 自带的 `TestCase`（`manage.py test analysis`），同样零额外依赖。

### 长命令必看

Agent 的 Bash 前台跑长命令（pip 下载、32 轮分析、E2E）**会被 SIGTERM 掐断**。一律 `run_in_background: true`，然后用日志文件读结果。

```bash
node xxx.js > _x.log 2>&1; echo "exit=$?" >> _x.log   # 后台 + 落盘
```

另外读日志时注意：**同一路径的历史日志可能还在被读到**，别把上一轮的结果当成这一轮的（本项目已因此误判过一次）。先 `rm -f` 再写。

---

## 9. 当前状态与下一步

### 已完成

> **本节只列能力清单**（一行一项）+ 指向铁律 / 契约章节的指针。
> ⚠️ **别在这里找测试计数** —— 计数唯一来源是 §7。本节旧版曾复述 `512` / `513` / `546` 等**中间态**，
> 那几个数早已过时，是「同一语义两处实现」的典型。
> 各项当时的过程、验收细节与那一轮的计数 → `docs/已完成-变更流水.md`。

**基础** — venv + Django + SQLite + SimpleUI 后台；S 盒模型 / 迁移 / CRUD / admin；
Vue 接管链路（构建 → manifest → 模板注入 → 页面 → API）。

**引擎** — `core/` 六模块整体移植、基准值全对齐（647.00 / 107 / 线性度 16 / 平移不变性）；
差分与线性两条搜索路径；抽样命中率验证走**真实加密**（不是估算）；
ARX 的 ADD 精确模型 + `QUARTER_ROUND` + multiword 端口（见 §7）。

**站点** — MPA 13 页（各有 HTML 根 / 入口脚本 / 路由 / 模板，整页跳转、真 404，`vue-router` 已移除 —— §3、铁律 4.22）；
双主题 + 左侧分组竖栏 + 上下文条 + 状态栏，工程工具形态、说明性内容全部折叠（§4.31）；
拖拽结构编辑器 + 中文解析 + 分步教程（示例数值全部实测）；
差分 / 线性分析页（参数 / 运行 / 收敛曲线 / 逐轮明细 / 活跃盒条带 / 8 张指标卡 / 日志）；
结果持久化（`sessionStorage` + 结构签名，整页跳转不丢 —— §4.14）；
S 盒库：内置种子（SM4 / AES / PRESENT）+ 详情页 4 张指标卡 + canvas DDT/LAT 热力图 + C/Python/JSON 导出（§4.29）。

**后端** — WSL2 + BCA_Light **单副本**（经 `/mnt/c` 指向本项目，代码不复制）；
`bca_entry.py` + `bca_bridge.py` + `/api/bca/{status,run}/`（§5）；
`/bca/` 页 + `start-platform-wsl.bat`，算法 / 模型清单从 `/api/bca/status/` **动态取、不硬编码**（§4.26）；
运行进度 `/api/bca/progress/` 只读 `results.csv`、不起第二子进程（§4.28）；
线性（Matsui）`attack=linear` + `model=LIN`，**换数据不换引擎**（§5）；
部署硬化：`SECRET_KEY`/`DEBUG`/`ALLOWED_HOSTS`/`CSRF_TRUSTED_ORIGINS` 读环境变量、默认值 = 原开发值（§4.30）。
✅ 已知吻合点：AES 1–3 轮 `ProbWeightBound = [6, 30, 54]`（1/5/9 个活跃盒 × 6）。

**口径（§4.40）** — 页面数值**只有一个来源**：后端 BCA 全空间精确解。
前端引擎不再参与页面求值（只作 `test:core` 的回归基准）；未解轮次显式写「还未求解」；
无后端实现的模板（PRESENT / 类 AES / 自搭图）、改过的图、指定起点、起始轮 ≠ 1 一律**明确拒绝**，不给近似值。

**实测与守卫** — E2E + 专项验收 + Django 测试（**计数见 §7**）；
四套独立复核 `verify-shuangyu` / `verify-fangzhen` / `verify-pintu` / `verify-accuracy`（§4.34 / 4.35 / 4.38 / 4.39）；
真浏览器「实操设计」`design-*.cjs`（双鱼 8 轮 `66.00` / 活跃盒 11；方阵「末轮跳过 vs 全层」对照）；
四轮「能画 ≠ 能算」缺陷清剿：§4.33（4 个）/ §4.34（3 个）/ §4.35（3 个 + `mixColumns` 改真 GF(2⁸)）/ §4.38（4 个）。

### 未完成（按依赖顺序）

1. **演示前的预热流程** —— 32 轮 SM4 要跑几小时，现场等不起。后端支持断点续跑
   （同名任务跳过已记录实例），所以要在演示前把要展示的任务跑完，现场走 `auto` / `cache` 秒出。
   ✅ **10-17 已预热**：`web` 任务 SM4/MAP/差分 **1~8 轮**（`[0,0,0,6,12,12,30,38]`，572s）
   + SM4/LIN/线性 **1~4 轮**（`0/0/0/6.0`，19s 冷跑 / 3.8s 温跑）。**9 轮以上仍是「还未求解」**。
   ⚠️ 线性每次都要真跑（`mode=run`，见 §4.40）——它拿不到 `cache` 通道的 summary。
2. **AES / PRESENT 的完整引擎** —— `graph.js` 里有模板，`analysis.js` 有 SPN 路径，
   但还没有像 SM4 那样的端到端基准值套件。类 AES 的列混淆**已经是真 GF(2⁸)**（§4.35），
   缺的是「ShiftRows 那种按行移位」的组件（当前 PERM 只有一个统一移位量）。
3. **广义 Feistel（GFN）引擎** —— `graph.js` 的 meta 里认得 `gfn`、`explain.js` 也有它的解说词，
   但**没有引擎**。所以界面**故意不提供**这个选项（`STRUCTURES` 只有 spn / feistel）；
   导入的图带着 `gfn` 时界面与日志都会明说「按 SPN 计算」。要做的是真的实现多分支迭代，
   然后把 `gfn` 加回 `STRUCTURES`。
4. **自定义算法送不了 BCA** —— `/api/bca/status/` 的算法清单是在后端写死的 6 个，前端画布搭的图进不去。
5. **INPUT 位宽上限 32 bit** —— 受 JS 位运算限制，>32bit 只能靠 `blocks` 近似（**不是**单字 64bit）。
   真要 64bit 单字得换 BigInt 或拆成两个 32bit 字。**注意 `blocks` 纯属界面派生显示**：
   引擎只看 `blockBits`（≤32），所以「128 位分组」目前只是个标签（§4.35）。
6. **`ShiftRows` 那种「按行移位」没有组件**（§4.35）—— `PERM` 只有一个统一字节移位量，
   表达不了「第 i 行移 i 个字节」。要真做 AES 风格 4×4 矩阵，得先有矩阵表示 + 行列节点。
7. **ARX（加-旋转-异或）差分/线性分析：算法层 + 架构层双重缺口已落地**（2026-10-15 改造，
   承接 2026-10-16 的 `outputs/BCA-ARX能力测试/` 实测）。⚠️ 缺口最危险之处不在「不支持」，而在
   **能搭出来、能加密、却"自信地算错"** —— 改造前引擎给 `prob=1 / weight=0 / activeSboxes=0`，
   而真实单轮差分概率 ≈2⁻²（α=1 时 144 种输出差、最可能者 25%）。
   - ✅ **算法层：模加精确模型**（`core/addmodel.js`）—— 差分 `xdp⁺(α,β→γ)` 用**两份副本的进位**
     `(c,c')` 做逐位 DP（4 态；约束 `sᵢ⊕s'ᵢ=γᵢ`）；线性 `corr(αx,αy→γ)` 用**单副本进位** `c`（2 态）。
     复杂度 `O(bits)`，与「位宽」几乎无关：**可达状态数 = 4×2^(进位差分位数)**，稀疏差分（如 α=1）
     即使 32bit 也精确全枚举。API：`addDiffProb/addDiffTopK/addLinCorr/addLinTopK`。
     `analysis.js` 的 `MERGE op=add` 现在走这条模型（`propagateAdd`），ADD 是「一进多出」返回候选集。
   - ✅ **架构层：复合节点 + 多字端口** —— ① 新增 `QUARTER_ROUND` 节点（四入四出，内部就地展开
     2×ADD + 4×ROT，一次定义单节点表达，不再平铺）；② `INPUT`/`OUTPUT` 新增 `multiword` 独立开关
     （**默认关闭 ⇒ 既有结构零影响**），开启后输出/输入 `W0…W(n-1)` 共 n 个端口，值走引擎已有的
     **端口侧信道** `state[`${id}|${port}`]`，不新增值模型。
   - ⚠️ **诚实边界（未做/不完美，勿当已完成）**：① `QUARTER_ROUND` 内部**逐步贪心**，不是整函数的
     联合最优；② 密集差分（进位差分位数多）会退化为 **beam 启发式**，此时返回体**如实标注
     `exact=false`**（稀疏差分仍精确，值用 `STATE_CAP=1<<12` 自适应判定）；③ 线性侧剪枝后若无非零
     候选，**宁可给 0 也不伪造非零**；④ 位宽仍 **32bit/字**（`blocks` 只是界面派生，§4.35）；
     ⑤ **后端 BCA 的 CNF 生成器仍无加法进位约束**（ARX 送不进 SAT 搜索，未做）。
   - **证据链**：`outputs/BCA-ARX支持落地/`（含 40 万组蒙特卡洛真值对拍 `probe-*.mjs` + 运行日志）。
     端到端决定性证据：旋涡值级 200 组×1~12 轮 4 字全对；差分第 1 轮引擎 `2^-8.00` vs 蒙特卡洛
     实测 `2^-8.03`（差 0.03bit），输出 4 字 OR 完全一致。
   - **守卫**：`verify-core.mjs` 第 15/16 节 —— 旧 ARX 边界守卫**已翻转为正确性断言**
     （ADD 不再报 warn、AND 仍 warn、ADD 模型与内联穷举零不符、α=1→p=1/2、ADD 传播 prob<1、
     `QUARTER_ROUND` 存在、multiword 端口、复合节点值与内联参考 QR 零不符、未开 multiword 时
     INPUT 仍单端口）。core 121 → **131**。（`arx_swirl` 模板作回归夹具，**不进** `USER_TEMPLATE_IDS`。）
8. **「拼图」暴露的三处能力缺口**（§4.38）—— 都是「语义里根本没有」，不是缺陷，要真做就得加组件：
   - **64bit 单字**：`INPUT.bits`/`SPLIT.splitBits` 上限 32 ⇒ 非平衡分支（L 32 / R 64）表达不了。
     真做要 BigInt 或「两字拼一个逻辑分支」（后者会牵动 `feistelGraphProfile` 的状态模型）。
   - **「移位后拼接」节点**：`MERGE` 只同位置合并、`LINEAR` 无「左移补零」⇒ `A‖B` 这类组合运算无节点。
   - **非平衡 Feistel 迭代内核**：`feistelGraphProfile` 只有一个 `branchBits`（两侧同宽）。
     与前两条是**同一件事的三个面**：都卡在「一个状态槽只能装一个 ≤32bit 的字」。

### 部署前必办

- **设好四个环境变量**（读取逻辑已实现，见 §4.30）：`SECRET_KEY`（**生产必须换掉** —— 不设时用的
  是开发那把明文字面量）、`DEBUG=False`、`DJANGO_ALLOWED_HOSTS`（生产下默认不再放 `*`，
  按实际域名 / 内网 IP 补全）、`CSRF_TRUSTED_ORIGINS`。真实密钥走 `scripts/wsl-env.sh`
  （**已 gitignore**，模板 `wsl-env.sh.example`）。
- `DEBUG=False` 后静态文件由 **whitenoise** 托管（`WHITENOISE_USE_FINDERS=True`）——
  **不需要 `collectstatic`**（§4.30）。
- BCA 侧：确认 kissat 能解析到（`BCA_KISSAT` / `config.json` 的 `solver.path` / PATH / 项目自带副本），看 `GET /api/bca/status/` 的 `solver.ok`；
  `results/` 若要有演示数据，**提前预热**（见 §5「BCA 后端」）。
- ⚠️ 打包分发时**要排除**：`.workbuddy/`（含许可讨论）、`outputs/`、`.venv/`、
  `frontend/node_modules/`、`libgurobi130.so`、`db.sqlite3`、`bca_light/results/`；
  **绝不能少 `static/dist/.vite/manifest.json`**（缺了整站白页，§4.24 / §3）。源码包约 1.4 MB。

---

## 10. 更深的上下文

- **项目长期记忆**：`.workbuddy/memory/MEMORY.md` 与按日期的日志 —— 含历史决策与踩坑细节
- **领域知识**：`~/.workbuddy/skills/cipher-crypto-analysis-platform/SKILL.md` —— 含 SM4 全部基准值、官方测试向量、架构分层约定。**做密码算法相关开发前建议先读它**
- **参考实现（形态 A）**：`C:\Users\huawei\WorkBuddy\2026-09-17-22-07-50` —— 一套独立的、带 `tests/` 的静态站实现。`core/` 里那六个引擎文件就是从它的 `js/core/` **原样按哈希移植**过来的。**怀疑引擎数值不对时，去比对它**；它的 `tests/verify_sm4.mjs` 有官方向量与详细注释（但注意 §7 提到的线性度过时注释）。

---

## 11. 改这个文件

`AGENTS.md` 是活文档。**每次踩到新坑、或发现某条约定已过时，请顺手更新它。** 一条"为什么"的注释，比十行代码更能帮到后面的人。
