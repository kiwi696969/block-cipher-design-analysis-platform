"""BCA_Light 桥接层 —— Django 通过本地子进程调用差分路径搜索。

分工
----
* **协议与实现**在 `backend/bca_light/bca_entry.py`（BCA 源码零改动）：
  stdin 收一行 JSON 请求，stdout 吐一行 JSON 响应。
* **这一层**只负责拼命令行、喂 stdin、解析 stdout、把失败翻译成人话。

为什么是子进程，而不是进程内 `import bca`
----------------------------------------
1. **拿不到超时**。BCA 一次搜索可能跑几十分钟到几小时，进程内调用没法中断，
   它卡在第 7 轮，整个 Django 站点就跟着卡死。
2. **连坐**。BCA 抛未捕获异常或吃满内存，站点一起倒。
3. **命名空间污染**。BCA 用的是顶层包名（`from models import get_model`），
   `Task.result_dir` 又是相对路径（跟着 cwd 走）。子进程 + `cwd` 一次解决两个。

为什么是这个边界
----------------
Django 与 BCA **都在 WSL 里**，所以这里只是本地进程调用，不跨 `wsl.exe`。
那条跨系统边界上本项目实测撞过 5 类故障（僵尸 VM、UTF-16LE 编码、/mnt/c 路径
转换、SIGTERM 掐断、沙箱拦程序）—— 把 Django 搬进 WSL 就是为了让它们消失，
而不是"降低概率"。反过来，Windows 侧跑 Django 时本模块会直接报不可用。

超时与中断
----------
`subprocess` 超时后杀的是 BCA 主进程；它的 kissat 子进程靠 `bca/solver.py`
自己的 `PR_SET_PDEATHSIG` 兜底（那段 Linux 专属代码就是为这个场景写的）。
所以**这里不额外做进程组管理** —— 两套机制叠加只会更难排查。
超时后我们还会再起一次"只读"调用，把已经落盘的记录捞回来：长任务超时也能
看到进度，而不是一片空白。
"""

import csv
import json
import os
import platform
import subprocess
import threading
import time

from django.conf import settings

# 能力自检的进程内缓存：{"at": 时间戳, "data": 结果}
_PROBE_CACHE = {"at": 0.0, "data": None}

# BCA 的注释明确写了"同一任务不并行"。与其让它自己踩自己，不如在这里挡住：
# 拿不到锁就立刻回 busy，不排队（排队只会让请求堆在一起，且总耗时更长）。
_RUN_LOCK = threading.Lock()

# probe 是轻量调用（只读注册表），给它一个宽松但有限的上限
_PROBE_TIMEOUT = 60.0

# 超时后"捞回已落盘记录"的调用上限 —— 只读文件，不需要跑多久
_RECOVER_TIMEOUT = 30.0

# 无法执行的退出码约定：入口返回 2 表示请求本身不合法
_EXIT_BAD_REQUEST = 2


# ---------------------------------------------------------------------------
# 配置
# ---------------------------------------------------------------------------


def config():
    """从 Django settings 读 BCA 配置，缺失时退回本模块的默认值。

    用 getattr 而不是直接下标：这套设置是后加的，老 settings.py 里没有，
    缺了也不该让整个站点起不来。
    """
    return {
        "dir": str(getattr(settings, "BCA_DIR", "")),
        "entry": str(getattr(settings, "BCA_ENTRY", "bca_entry.py")),
        "python": str(getattr(settings, "BCA_PYTHON", "python3")),
        "timeout": float(getattr(settings, "BCA_DEFAULT_TIMEOUT", 120)),
        "probe_ttl": float(getattr(settings, "BCA_PROBE_TTL", 30)),
    }


def _platform_problem():
    """跑不起来的环境问题 → (reason, 人话说明)；一切正常则 None。

    这些检查放在起进程之前，是为了让现场演示时一眼看出问题在哪 ——
    "No such file or directory" 对演示者毫无帮助。
    """
    cfg = config()

    if platform.system() != "Linux":
        return (
            "needs_linux",
            "BCA 只能在 Linux 里运行（需要 WSL）。当前系统是 "
            f"{platform.system()}，请改用 WSL 里的 Django（或跑 start-platform-wsl.bat）。",
        )

    if not cfg["dir"] or not os.path.isdir(cfg["dir"]):
        return "missing_dir", f"BCA 目录不存在：{cfg['dir'] or '(未配置 BCA_DIR)'}"

    entry = os.path.join(cfg["dir"], cfg["entry"])
    if not os.path.isfile(entry):
        return "missing_entry", f"BCA 入口脚本不存在：{entry}"

    return None


# ---------------------------------------------------------------------------
# 调用
# ---------------------------------------------------------------------------


def _invoke(payload, timeout):
    """起一次 BCA 子进程，返回解析后的响应 dict。

    任何失败都以 `{"ok": False, "reason": ..., "error": ...}` 返回，
    **不抛异常** —— 调用方（视图层）只需要看 ok 字段。
    """
    cfg = config()
    entry_path = os.path.join(cfg["dir"], cfg["entry"])

    env = os.environ.copy()
    env["PYTHONUNBUFFERED"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"

    try:
        proc = subprocess.run(
            [cfg["python"], cfg["entry"]],
            cwd=cfg["dir"],
            input=json.dumps(payload, ensure_ascii=False),
            text=True,
            encoding="utf-8",
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
            env=env,
        )
    except subprocess.TimeoutExpired:
        return {
            "ok": False,
            "reason": "timeout",
            "error": f"BCA 子进程超过 {timeout:g} 秒仍未结束，已终止。"
                     "已跑出的记录不会丢，同任务重跑会从断点继续。",
            "timeout": timeout,
        }
    except OSError as exc:
        return {
            "ok": False,
            "reason": "spawn_failed",
            "error": f"无法启动 BCA 子进程（{cfg['python']}）：{exc}",
        }

    resp = _parse_response(proc.stdout)
    if resp is None:
        return {
            "ok": False,
            "reason": "bad_output",
            "error": "BCA 没有返回可解析的 JSON。",
            "exit_code": proc.returncode,
            "stdout_tail": (proc.stdout or "")[-2000:],
            "stderr_tail": (proc.stderr or "")[-2000:],
        }

    resp.setdefault("ok", proc.returncode == 0)
    resp["exit_code"] = proc.returncode
    if proc.stderr and proc.stderr.strip():
        resp["stderr_tail"] = proc.stderr[-2000:]
    if not resp.get("ok"):
        _add_hints(resp)
    return resp


def _parse_response(text):
    """从 stdout 里取出响应 JSON。

    正常情况下 stdout 就是一行 JSON（入口把 BCA 的所有输出都抢走了）。
    这里的兜底是为了"万一有东西漏到 stdout"时还能救回来。
    """
    text = (text or "").strip()
    if not text:
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    for line in reversed(text.splitlines()):
        line = line.strip()
        if line.startswith("{"):
            try:
                return json.loads(line)
            except json.JSONDecodeError:
                continue
    return None


def _add_hints(resp):
    """给常见错误补一句"下一步该改什么"。"""
    blob = " ".join(
        str(resp.get(k) or "") for k in ("error", "traceback", "stdout_tail", "stderr_tail")
    )
    hints = []
    if "kissat" in blob and ("No such file" in blob or "not found" in blob
                             or "FileNotFound" in blob):
        hints.append(
            "找不到求解器 kissat。设环境变量 BCA_KISSAT 指向它，"
            "或改 backend/bca_light/config.json 的 solver.path。"
        )
    if "No module named" in blob:
        hints.append("BCA 依赖缺失，在 WSL 里跑 pip install python-sat --break-system-packages。")
    if "未知算法" in blob or "未知模型" in blob:
        hints.append("算法/模型名不在 BCA 注册表里，可调 /api/bca/status/ 看可用清单。")
    if hints:
        resp["hints"] = hints


# ---------------------------------------------------------------------------
# 对外接口
# ---------------------------------------------------------------------------


def status(force=False):
    """BCA 后端自检。

    走的是**和真正搜索完全相同的链路**（起一次子进程、用同一个入口脚本），
    所以"自检通过"意味着后面真跑也能起来，不是理论上应该能跑。

    结果按 `BCA_PROBE_TTL` 秒缓存（probe 要起进程，约 1~3 秒）。
    """
    cfg = config()
    now = time.time()
    if not force and _PROBE_CACHE["data"] is not None and now - _PROBE_CACHE["at"] < cfg["probe_ttl"]:
        return _PROBE_CACHE["data"]

    base = {
        "bca_dir": cfg["dir"],
        "entry": os.path.join(cfg["dir"], cfg["entry"]),
        "python": cfg["python"],
        "platform": platform.system(),
    }

    problem = _platform_problem()
    if problem:
        data = dict(base, available=False, reason=problem[0], detail=problem[1])
    else:
        resp = _invoke({"action": "probe"}, timeout=_PROBE_TIMEOUT)
        if resp.get("ok"):
            data = dict(base, available=True, reason=None, detail=None,
                        capabilities=resp.get("capabilities"), elapsed=resp.get("elapsed"))
        else:
            data = dict(base, available=False, reason=resp.get("reason") or "probe_failed",
                        detail=resp.get("error"), hints=resp.get("hints"),
                        stdout_tail=resp.get("stdout_tail"), traceback=resp.get("traceback"))

    _PROBE_CACHE.update(at=now, data=data)
    return data


def reset_cache():
    """清掉自检缓存（环境变了、或测试要强制刷新时用）。"""
    _PROBE_CACHE.update(at=0.0, data=None)


def run(payload, timeout=None):
    """跑一次 BCA 搜索。

    Args:
        payload: 请求体，字段见 `bca_entry.py` 的协议说明（cipher / model /
                 rounds 必填；task / attack / timeout / sat_jobs 可选）。
        timeout: **子进程**超时（秒）。None = 用 settings.BCA_DEFAULT_TIMEOUT；
                 传 0 或负数 = 不限制（只适合确定要长跑的场景）。

    Returns:
        BCA 入口返回的响应 dict（`ok` 之外还带 records / bounds / paths /
        summary）。失败时 `ok=False`，并带 `reason` 说明属于哪类失败。
    """
    problem = _platform_problem()
    if problem:
        return {"ok": False, "reason": problem[0], "error": problem[1]}

    if timeout is None:
        timeout = config()["timeout"]
    timeout = float(timeout)
    if timeout <= 0:
        timeout = None  # 明确表示"不限时"

    if not _RUN_LOCK.acquire(blocking=False):
        return {
            "ok": False,
            "reason": "busy",
            "error": "已有 BCA 搜索在运行，请等它结束再发起新的搜索。",
        }

    try:
        body = dict(payload)
        body.setdefault("action", "run")
        started = time.perf_counter()
        resp = _invoke(body, timeout=timeout)
        resp["wall"] = round(time.perf_counter() - started, 3)

        if resp.get("reason") == "timeout":
            # 超时不等于无产出：把已经落盘的记录捞回来，让调用方看到进度
            resp["partial"] = _recover(body)
        return resp
    finally:
        _RUN_LOCK.release()


def load_results(payload):
    """只读已有产物，不跑搜索。

    这是**现场演示的"秒出"通道**：预热过的任务走这里，直接把断点续跑攒下的
    记录读出来，完全不碰求解器。
    """
    problem = _platform_problem()
    if problem:
        return {"ok": False, "reason": problem[0], "error": problem[1]}

    body = dict(payload)
    body["search"] = False
    return _invoke(body, timeout=_RECOVER_TIMEOUT)


# 单次进度查询最多回多少行。正常任务一轮只有几行，这里是防畸形/超大文件
# 把响应撑爆的上限，不是分页。
_MAX_PROGRESS_ROWS = 4000


def _results_csv_path(payload):
    """拼出 `results/{task}/{cipher}/{model}/results.csv` 的绝对路径。

    拼法与 BCA 的 `Task.model_dir` 一一对应（见 backend/bca_light/bca/task.py
    的 result_dir / model_dir 两个 property）。真要是那边改了目录结构，
    `analysis/tests.py` 里的进度用例会先红 —— 这就是它存在的意义。

    这里**故意不调 BCA 子进程**：进度是每秒轮询一次的，而起一次子进程要
    1~3 秒、还会把 gurobipy 拉起来，代价和收益完全不成比例。读一个 CSV 就够了。
    """
    def safe(value, field):
        text = str(value or '').strip()
        if not text:
            raise ValueError(f'progress 需要 {field} 参数')
        # / \ .. 都能跳出 results/ 去读目录外的文件，这里直接拒绝
        if any(ch in text for ch in ('/', '\\', '..')):
            raise ValueError(f'{field} 含非法字符：{text!r}')
        return text

    cfg = config()
    return os.path.join(
        cfg["dir"], "results",
        safe(payload.get("task") or "web", "task"),
        safe(payload.get("cipher"), "cipher"),
        safe(payload.get("model"), "model"),
        "results.csv",
    )


def _read_progress_rows(path):
    """读 results.csv 的原始行，返回 (rows, truncated)。

    这个文件**正被 BCA 子进程持续追加**，所以最后一行可能只写了一半。
    csv 解析不出来的行直接跳过 —— 进度少一格，好过整个请求报错。
    """
    if not os.path.isfile(path):
        return [], False
    rows = []
    try:
        with open(path, "r", newline="", encoding="utf-8", errors="replace") as f:
            for row in csv.DictReader(f):
                if not row.get("round"):
                    continue
                rows.append({k: v for k, v in row.items() if k is not None})
                if len(rows) >= _MAX_PROGRESS_ROWS:
                    return rows, True
    except OSError:
        return [], False
    return rows, False


def progress(payload):
    """只读该任务已落盘的记录 —— 供运行中轮询。

    返回 `{"ok", "path", "records": [...], "truncated": bool}`。
    调用方（视图层）再用这些行算出"已完成到第几轮"。

    与 `run()` **不共享那把锁**：它不碰求解器，只是读一个正在被追加的文件，
    所以可以和运行中的搜索并存。runserver 是多线程的，两个请求各跑各的。
    """
    problem = _platform_problem()
    if problem:
        return {"ok": False, "reason": problem[0], "error": problem[1]}

    try:
        path = _results_csv_path(payload)
    except ValueError as exc:
        return {"ok": False, "reason": "bad_request", "error": str(exc)}

    rows, truncated = _read_progress_rows(path)
    return {"ok": True, "path": path, "records": rows, "truncated": truncated}


def _recover(payload):
    """超时后捞一次已落盘记录。失败就返回 None，不影响主响应。"""
    body = dict(payload)
    body["search"] = False
    try:
        resp = _invoke(body, timeout=_RECOVER_TIMEOUT)
    except Exception:  # noqa: BLE001 —— 兜底而已，任何问题都不该盖过超时信息
        return None
    if not resp.get("ok"):
        return None
    return {k: resp.get(k) for k in ("records", "bounds", "paths", "result_root")}
