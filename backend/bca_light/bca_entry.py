#!/usr/bin/env python3
"""BCA_Light 的 JSON 入口 —— 给上层程序（Django 平台）用的薄封装。

为什么需要它
------------
`main.py` 是**给人看的 CLI**：参数从 argv 来，结果用 `print` 铺在终端上。
上层程序要的恰好相反：**结构化的请求/响应**，而且输出不能被 BCA 自己的日志
污染。这个文件只做三件事：

1. 从 stdin 读一行 JSON 请求 → 构造 `Task`；
2. 调模型的 `run_search(ctx)`；
3. 把「返回值 + 落盘产物（results.csv / bounds.json / 差分路径）」组装成
   一行 JSON 写到 stdout。

**BCA 源码一行都不改** —— 这是新增的外壳，`bca/` 与 `models/` 保持原样，
哈希仍可与上游逐字节对齐。`main.py` 也照旧能用，两者互不影响。

协议
----
请求（stdin，单个 JSON 对象）::

    {
      "cipher": "SM4",           # 必填，见 bca.cipher.CIPHER_REGISTRY
      "model": "MAP",            # 必填，MAP / MDW / AS / LIN
      "rounds": "1-8",           # 必填，"1-8" 或 [1,8]；单个数 "8" 视为 1-8
      "task": "web",             # 任务名 = results/ 下的目录名，默认 "web"
      "attack": "differential",  # 可选，默认 differential；linear 走 LAT 数据（配 model=LIN）
      "timeout": 300,            # 可选，单次 SAT 求解超时（秒），不设则不限
      "sat_jobs": 4,             # 可选，同概率权重下多格并发上限
      "action": "run",           # 可选，"run"（默认，跑搜索）| "probe"（只自检）
      "search": true,            # 可选，false = 只读已有产物、不跑搜索
      "refine": "auto"           # 可选，仅 LIN：精确权重限制搜索 auto/true/false
    }

`action="probe"` 不跑搜索，只回注册表与环境（算法/模型清单、各算法总轮数、
solver 可执行文件是否就位），响应形如 `{"ok": true, "capabilities": {...}}`。
它走的是**和搜索完全相同的链路** —— 所以"probe 通过"意味着后面真跑也能起来。

响应（stdout，单个 JSON 对象）::

    {
      "ok": true,
      "entry": "bca_entry/1",
      "task": {"name": ..., "cipher": ..., "model": ..., "rounds": [1, 8]},
      "summary": {...},          # run_search 的返回值（键随模型而异）
      "records": [...],          # 读自 results.csv —— 断点续跑后的**全量**记录
      "bounds": {...},           # bounds.json
      "paths": [...],            # 差分路径明文（按轮数降序，截断）
      "result_root": "/abs/...", # 结果目录绝对路径
      "elapsed": 12.34,
      "stdout_tail": "..."       # BCA 自己 print 的东西（末尾若干字符）
    }

`ok` 只表示**请求被正常执行**；密码学结论（SAT / UNSAT / 超时）在 `records`
里。参数不合法或执行抛异常时 `ok=false`，并带上 `error` / `traceback`。

为什么必须把 stdout 抢过来
--------------------------
BCA 会往终端打进度（`Round 3: Prob=15 ...`），而 **kissat 是外部进程**，它的
输出走的是继承来的 **fd 1**。只要有一条漏到 stdout，上层 `json.loads` 就当场
失败。所以这里把 fd 1 本身 dup 走、全程写进临时文件，最后才把真正的 fd 1 还
回来写 JSON —— 只靠 `contextlib.redirect_stdout` 是拦不住外部进程的。
"""

import csv
import json
import os
import sys
import tempfile
import time
import traceback

HERE = os.path.dirname(os.path.abspath(__file__))

# 让 `import bca` 与 `from models import get_model` 生效。BCA 用的是**顶层包名**
# （`from models import get_model`），所以必须由这里把目录塞进 sys.path，
# 而不是指望调用方去配 PYTHONPATH。
if HERE not in sys.path:
    sys.path.insert(0, HERE)

ENTRY_VERSION = "bca_entry/1"

DEFAULT_TASK = "web"
DEFAULT_ATTACK = "differential"

# 产物回传上限：path 明文可能有几十 KB，整包回传会把 HTTP 响应撑爆。
MAX_PATH_FILES = 12
MAX_PATH_CHARS = 6000
MAX_STDOUT_TAIL = 4000

# results.csv 里需要转成数值的列（其余保持字符串，前端拿到的类型才稳定）
_INT_COLS = ("round", "prob", "var_count", "clause_count")
_FLOAT_COLS = ("solve_time", "cnf_time")


# ---------------------------------------------------------------------------
# 请求解析
# ---------------------------------------------------------------------------


class BadRequest(Exception):
    """请求本身不合法（缺字段 / 类型错）—— 与"BCA 执行失败"区分开。"""


def _require_str(req, key):
    value = req.get(key)
    if value is None or str(value).strip() == "":
        raise BadRequest(f'缺少必填字段 "{key}"')
    return str(value).strip()


def parse_rounds(raw):
    """轮数范围 → (start, end)。

    接受 `"1-8"`、`[1, 8]`；单个 `"8"` 按"跑到第 8 轮"解读，即 1-8。
    单个数为什么不解读成 8-8？因为界面上的语义是"搜索到第 N 轮"，
    而 BCA 的搜索天然从第 1 轮往上推进（低轮是后续轮的前置）。
    """
    if isinstance(raw, (list, tuple)):
        if len(raw) != 2:
            raise BadRequest(f"rounds 数组应为 [start, end]，收到 {raw!r}")
        start, end = int(raw[0]), int(raw[1])
    elif raw is None or str(raw).strip() == "":
        raise BadRequest('缺少必填字段 "rounds"（如 "1-8"）')
    else:
        text = str(raw).strip()
        if "-" in text:
            left, right = text.split("-", 1)
            start, end = int(left), int(right)
        else:
            start, end = 1, int(text)

    if start < 1 or end < start:
        raise BadRequest(f"轮数范围不合法: {start}-{end}（要求 1 ≤ start ≤ end）")
    return start, end


# ---------------------------------------------------------------------------
# 执行
# ---------------------------------------------------------------------------


def _make_task(req):
    """把请求解析成 Task（不加载重模块，也不跑搜索）。"""
    from bca.task import Task

    cipher_name = _require_str(req, "cipher")
    model_name = _require_str(req, "model")
    round_start, round_end = parse_rounds(req.get("rounds"))

    task = Task(
        name=str(req.get("task") or DEFAULT_TASK),
        algorithm=cipher_name,
        model=model_name,
        round_start=round_start,
        round_end=round_end,
        attack=str(req.get("attack") or DEFAULT_ATTACK),
    )
    if req.get("timeout") is not None:
        task.solver_timeout = int(req["timeout"])
    if req.get("sat_jobs") is not None:
        task.sat_jobs = int(req["sat_jobs"])
    return task


def _run_search(task, refine=None):
    """按 task 跑一次搜索，返回 run_search 的返回值。

    `refine` 仅对 LIN（线性模型）生效：控制「精确权重限制搜索」做不做
    （None = 模型默认 "auto"，按成本闸自动；True/False 强制）。其它模型忽略。

    导入放在函数里：`models` 包会拉起 gurobipy，只读缓存（search=false）时
    没必要付这个代价。
    """
    from bca.cipher import get_cipher
    from bca.config import load_config
    from bca.ctx import Ctx
    from bca.solver import KissatSolver
    from models import get_model

    cfg = load_config()
    cipher = get_cipher(task.algorithm, cfg, attack=task.attack)
    solver = KissatSolver(cfg.solver_path(), max_retries=cfg.solver_max_retries())
    ctx = Ctx(cfg, task, cipher, solver)

    model = get_model(task.model)()
    if refine is not None and task.model == "LIN":
        return model.run_search(ctx, refine=refine)
    return model.run_search(ctx)


# ---------------------------------------------------------------------------
# 产物收集
# ---------------------------------------------------------------------------


def _read_records(model_dir):
    """读 results.csv —— 它才是权威记录（含断点续跑之前跑出来的那些行）。"""
    path = os.path.join(model_dir, "results.csv")
    if not os.path.isfile(path):
        return []
    rows = []
    with open(path, "r", newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            for col in _INT_COLS:
                if row.get(col) not in (None, ""):
                    try:
                        row[col] = int(row[col])
                    except ValueError:
                        pass
            for col in _FLOAT_COLS:
                if row.get(col) not in (None, ""):
                    try:
                        row[col] = float(row[col])
                    except ValueError:
                        pass
            rows.append(row)
    rows.sort(key=lambda r: (r.get("round") or 0, r.get("prob") or 0))
    return rows


def _read_bounds(model_dir):
    path = os.path.join(model_dir, "bounds.json")
    if not os.path.isfile(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def _read_paths(model_dir):
    """读差分路径明文。

    按 (轮数, 概率) **降序**取前若干条 —— 高轮数的路径最有展示价值，
    低轮数的（P0 那条）基本是一串零。
    """
    path_dir = os.path.join(model_dir, "details", "path")
    if not os.path.isdir(path_dir):
        return []

    files = [f for f in os.listdir(path_dir) if f.endswith(".txt")]

    def sort_key(name):
        # R12-P30.txt → (12, 30)；格式意外时排到最后，不抛
        stem = name[:-4]
        try:
            left, right = stem.split("-P", 1)
            return (int(left.lstrip("R")), int(right.split("-")[0]))
        except (ValueError, IndexError):
            return (-1, -1)

    files.sort(key=sort_key, reverse=True)

    out = []
    for name in files[:MAX_PATH_FILES]:
        full = os.path.join(path_dir, name)
        try:
            with open(full, "r", encoding="utf-8") as f:
                content = f.read(MAX_PATH_CHARS)
            truncated = os.path.getsize(full) > MAX_PATH_CHARS
        except OSError:
            continue
        out.append({"file": name, "content": content, "truncated": truncated})
    return out


def collect(task, summary):
    """把 task 对应的落盘产物收集成响应 payload。"""
    model_dir = os.path.join(HERE, task.model_dir)
    return {
        "entry": ENTRY_VERSION,
        "ok": True,
        "task": {
            "name": task.name,
            "cipher": task.algorithm_key,
            "model": task.model,
            "attack": task.attack,
            "rounds": [task.round_start, task.round_end],
        },
        "summary": summary,
        "records": _read_records(model_dir),
        "bounds": _read_bounds(model_dir),
        "paths": _read_paths(model_dir),
        "result_root": model_dir,
    }


# ---------------------------------------------------------------------------
# 能力探测
# ---------------------------------------------------------------------------


def probe():
    """自检：BCA 注册表 + 运行环境。

    算法/模型清单**从注册表读**，不在这里另写一份 —— 上层（Django、前端）
    硬编码一份清单出去，BCA 一改就会漂移。
    """
    from bca.cipher import CIPHER_REGISTRY
    from bca.config import load_config, resolve_solver_path
    from models import MODEL_REGISTRY

    cfg = load_config()
    solver_path = cfg.solver_path()
    # 解析规则只在 bca.config.resolve_solver_path 一处实现：
    # 含分隔符按路径、裸名查 PATH、仍找不到兜底项目自带副本。
    # 不要在这里另写一份 —— 以前 probe 用 which、KissatSolver 用 exists，
    # 配置成裸名时会出现"自检报 ok、真求解却 FileNotFound"的矛盾。
    resolved = resolve_solver_path(solver_path)

    ciphers = [
        {
            "name": name,
            "full_rounds": getattr(cls, "FULL_ROUNDS", None),
            "sbox_count": getattr(cls, "SBOX_COUNT", None),
            "state_bits": getattr(cls, "STATE_BITS", None),
        }
        for name, cls in CIPHER_REGISTRY.items()
    ]
    return {
        "bca_dir": HERE,
        "solver": {
            "path": solver_path,
            "resolved": resolved,
            "ok": resolved is not None,
        },
        "espresso_dir": os.path.join(HERE, cfg.espresso_dir()),
        "keep_cnf": cfg.keep_cnf(),
        "keep_solution": cfg.keep_solution(),
        "ciphers": ciphers,
        "models": sorted(MODEL_REGISTRY),
    }


# ---------------------------------------------------------------------------
# stdout 保护
# ---------------------------------------------------------------------------


class StdoutGuard:
    """全程抢占 fd 1，把 BCA 的一切输出（含 kissat 子进程）收进临时文件。

    `os.dup2` 换的是**文件描述符**，而 Python 的 `sys.stdout` 就绑在 fd 1 上，
    所以 `print` 与外部进程一视同仁地跟着走 —— 这正是我们要的。
    """

    def __init__(self):
        self._tmp = tempfile.TemporaryFile(mode="w+b")
        self._saved_fd = None

    def __enter__(self):
        sys.stdout.flush()
        self._saved_fd = os.dup(1)
        os.dup2(self._tmp.fileno(), 1)
        return self

    def __exit__(self, *exc_info):
        try:
            sys.stdout.flush()
        except Exception:
            pass
        if self._saved_fd is not None:
            os.dup2(self._saved_fd, 1)
            os.close(self._saved_fd)
            self._saved_fd = None
        return False

    def tail(self, limit=MAX_STDOUT_TAIL):
        """末尾若干字符 —— BCA 的进度输出，出错时是最有用的线索。"""
        try:
            self._tmp.flush()
            self._tmp.seek(0, os.SEEK_END)
            size = self._tmp.tell()
            self._tmp.seek(max(0, size - limit))
            return self._tmp.read().decode("utf-8", "replace")
        except OSError:
            return ""

    def close(self):
        try:
            self._tmp.close()
        except OSError:
            pass


# ---------------------------------------------------------------------------
# 入口
# ---------------------------------------------------------------------------


def build_response(req):
    """执行请求并组装响应（不含 elapsed / stdout_tail，由 main 补）。

    `search=false` 时**只读已有产物、不跑搜索** —— 这是"现场秒出"的通道：
    预热过的任务走这里，直接返回断点续跑攒下的记录，不碰求解器。
    """
    task = _make_task(req)
    summary = None if req.get("search") is False else _run_search(
        task, refine=req.get("refine"))
    return collect(task, summary)


def main():
    started = time.perf_counter()

    # 把 cwd 钉在 BCA 根目录：`Task.result_dir` 与 `espresso_dir` 都是相对路径，
    # 跟着 cwd 走。上层就算用别的 cwd 起进程，结果也一定落在 BCA 目录里。
    os.chdir(HERE)

    raw = sys.stdin.read()
    try:
        req = json.loads(raw) if raw.strip() else {}
        if not isinstance(req, dict):
            raise BadRequest("请求体应为 JSON 对象")
    except (json.JSONDecodeError, BadRequest) as exc:
        _emit({"entry": ENTRY_VERSION, "ok": False, "error": f"请求解析失败: {exc}"}, started)
        return 2

    guard = StdoutGuard()
    with guard:
        try:
            action = str(req.get("action") or "run").strip().lower()
            if action in ("list", "probe", "capabilities"):
                # 自检：不跑搜索，只回注册表与环境（上层据此判断"后端能不能用"）
                resp = {"entry": ENTRY_VERSION, "ok": True, "capabilities": probe()}
            elif action == "run":
                resp = build_response(req)
            else:
                raise BadRequest(f'未知 action: "{action}"（可选 run / probe）')
        except BadRequest as exc:
            resp = {"entry": ENTRY_VERSION, "ok": False,
                    "reason": "bad_request", "error": str(exc)}
        except KeyError as exc:
            # 注册表查不到算法/模型名 —— 属于请求参数问题，不是执行失败
            resp = {"entry": ENTRY_VERSION, "ok": False, "reason": "bad_request",
                    "error": str(exc.args[0] if exc.args else exc)}
        except Exception as exc:  # noqa: BLE001 —— 任何异常都要变成 JSON 而不是崩掉
            resp = {
                "entry": ENTRY_VERSION,
                "ok": False,
                "error": f"{type(exc).__name__}: {exc}",
                "traceback": traceback.format_exc()[-MAX_STDOUT_TAIL:],
            }
        tail = guard.tail()
    guard.close()

    if tail.strip():
        resp["stdout_tail"] = tail
    _emit(resp, started)
    return 0 if resp.get("ok") else 1


def _emit(resp, started):
    resp["elapsed"] = round(time.perf_counter() - started, 4)
    sys.stdout.write(json.dumps(resp, ensure_ascii=False))
    sys.stdout.write("\n")
    sys.stdout.flush()


if __name__ == "__main__":
    sys.exit(main())
