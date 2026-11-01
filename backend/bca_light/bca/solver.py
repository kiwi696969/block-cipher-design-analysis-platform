"""
SAT 求解器封装：留扩展口（SolverBase），默认 kissat。

kissat 输出解析基于其实际格式（"s SATISFIABLE" / "s UNSATISFIABLE" /
"v <lits> 0" 与返回码 10/20），参考实现中 mallob 残留的 "[ result ]"
段解析不适用于 kissat。

solve() 返回 (result_code, elapsed, model)：
- result_code: RESULT_SATISFIABLE / RESULT_UNSATISFIABLE / RESULT_TIMEOUT / RESULT_NO_RESULT / RESULT_ERROR
- model: SAT 时为带符号整数列表（正 = 真，负 = 假），否则 None

solve_batch()（DWP/RSP 用）并行求解多个 CNF：独立进程组 + PDEATHSIG
双保险保证杀掉（零孤儿），单线程 poll 循环，无 Python worker 线程。

孤儿保护（PR_SET_PDEATHSIG，Linux）：kissat 用 preexec_fn 在 fork 后立刻
arm "创建它的线程一死就 SIGKILL 它"，与 Python 信号 handler 能否执行无关
（覆盖主进程被 SIGKILL / OOM 强杀等 handler 不可捕获的场景）。libc.prctl 在
父进程 import 时预热（见 _load_prctl），子进程只做纯 FFI 调用。模型里
用 multiprocessing.Pool 并行算 MILP 界的地方请走 make_pool()（同样带
PDEATHSIG），不要直接 Pool(...)。
"""

import collections
import ctypes
import functools
import os
import signal
import subprocess
import time
from abc import ABC, abstractmethod
from multiprocessing import Pool

from .config import resolve_solver_path
from .consts import (
    ENV_SOLVER,
    RESULT_ERROR,
    RESULT_NO_RESULT,
    RESULT_SATISFIABLE,
    RESULT_TERMINATED,
    RESULT_TIMEOUT,
    RESULT_UNSATISFIABLE,
    KISSAT_RET_SAT,
    KISSAT_RET_UNSAT,
)


_PR_SET_PDEATHSIG = 1


def _load_prctl():
    """父进程 import 时预热 libc.prctl（CDLL 加载 + argtypes + 一次无害调用）。

    预热是为了让 fork 出的子进程只做纯 FFI 调用（不动态加载、不新建 ctypes
    对象）——多线程进程里 fork + preexec_fn 的死锁风险主要来自子进程侧的
    动态加载/内存分配。本项目只在 Linux 上跑，libc.so.6 必然存在（加载失败
    直接报错，不做降级）。
    """
    libc = ctypes.CDLL("libc.so.6", use_errno=True)
    libc.prctl.argtypes = [
        ctypes.c_int, ctypes.c_ulong, ctypes.c_ulong,
        ctypes.c_ulong, ctypes.c_ulong,
    ]
    libc.prctl.restype = ctypes.c_int
    # option=0 是未分配的 prctl option → 返回 -1/EINVAL，对本进程无副作用，
    # 只是让 libffi 完成首次调用的准备（避免子进程里首次调用触发加载）
    libc.prctl(0, 0, 0, 0, 0)
    return libc.prctl


_prctl = _load_prctl()


def _arm_pdeathsig(expected_ppid):
    """在 fork 出的子进程/worker 里调：创建它的线程一死内核立即 SIGKILL 本进程。

    必须在 prctl 之后核对 getppid()：父进程若在 fork 与 prctl 之间已死，
    内核不会补发信号（经典竞态）→ ppid 不符直接退出，不干活。
    """
    _prctl(_PR_SET_PDEATHSIG, signal.SIGKILL, 0, 0, 0)
    if os.getppid() != expected_ppid:
        os._exit(1)


def _make_preexec(parent_pid):
    """子进程 preexec_fn：父进程死亡时子进程自杀（PDEATHSIG + ppid 竞态自检）。"""
    return functools.partial(_arm_pdeathsig, parent_pid)


def _pool_initializer(orig_ppid):
    """multiprocessing.Pool worker 初始化：自带 PDEATHSIG。

    ⚠️ PR_SET_PDEATHSIG 绑定"调用它的线程"（不是整个父进程）：CPython 的
    Pool.__init__ 先在**调用线程**里 _repopulate_pool()（pool.py:212）再启动
    _handle_workers 线程 → 初始那批 worker 绑调用线程，之后被 _maintain_pool
    重生的才绑 _handle_workers。本项目里池都在主线程建，两种绑定都退化为
    "主进程一死（含 SIGKILL，所有线程同时消失）内核立刻 SIGKILL 全部 worker"，
    不依赖任何 Python 轮询；池正常 close()/join() 时 _handle_workers 退出会把
    重生的 worker 一起 SIGKILL（pool.map() 已收齐结果，只是"退得早点"，不影响
    结果）。注意：若将来有人在非主线程里建池，语义会变成"那个线程退出时杀
    worker"，需重看此处。
    """
    _arm_pdeathsig(orig_ppid)


def make_pool(workers):
    """建 multiprocessing.Pool，worker 自带 PDEATHSIG（模型算 MILP 界用）。

    workers 取值同 multiprocessing.Pool：None = 按 CPU 数决定，0 / 负数会
    ValueError（不特判）。
    """
    return Pool(processes=workers,
                initializer=_pool_initializer, initargs=(os.getpid(),))


class SolverBase(ABC):
    """SAT 求解器接口。"""

    name = "base"

    @abstractmethod
    def solve(self, cnf_path, solution_path, timeout=None):
        """
        求解一个 CNF 文件。

        Args:
            cnf_path: CNF 文件路径
            solution_path: 求解器输出文件路径
            timeout: 单次求解超时（秒），None 不设超时（无限）

        Returns:
            (result_code, elapsed, model)
        """


def parse_kissat_solution(solution_path):
    """
    解析 kissat 输出，提取模型（v 行）。

    Returns:
        带符号整数列表（正 = 真，负 = 假）；无模型时返回 None
    """
    if not solution_path or not os.path.exists(solution_path):
        return None
    model = []
    with open(solution_path, "r") as f:
        for line in f:
            line = line.strip()
            if line.startswith("v "):
                for lit in line[2:].split():
                    if lit == "0":
                        continue
                    model.append(int(lit))
    return model or None


class KissatSolver(SolverBase):
    """kissat 求解器封装：subprocess + 崩溃重试。"""

    name = "kissat"

    def __init__(self, solver_path, max_retries=3):
        self.solver_path = solver_path
        self.max_retries = max_retries

    def _solver_binary(self):
        """解析成真实可执行路径（裸命令名查 PATH，找不到兜底项目自带副本）。

        解析失败直接抛错，不静默换一个二进制 —— 配置写错必须当场看见。
        """
        resolved = resolve_solver_path(self.solver_path)
        if resolved is None:
            raise FileNotFoundError(
                f"Solver not found: {self.solver_path} "
                f"(设置环境变量 {ENV_SOLVER} 或改 config.json 的 solver.path)"
            )
        return resolved

    def solve(self, cnf_path, solution_path, timeout=None):
        solver_bin = self._solver_binary()

        # 主进程被 SIGKILL（handler 不可捕获）时由内核带走 kissat，零孤儿
        preexec = _make_preexec(os.getpid())
        for attempt in range(self.max_retries):
            start = time.time()
            try:
                with open(solution_path, "w") as out:
                    proc = subprocess.run(
                        [solver_bin, cnf_path],
                        stdout=out,
                        stderr=subprocess.DEVNULL,
                        timeout=timeout,
                        preexec_fn=preexec,
                    )
                elapsed = time.time() - start

                if proc.returncode == KISSAT_RET_SAT:
                    return RESULT_SATISFIABLE, elapsed, parse_kissat_solution(solution_path)
                if proc.returncode == KISSAT_RET_UNSAT:
                    return RESULT_UNSATISFIABLE, elapsed, None

                # 求解器崩溃（返回码异常）
                if attempt == self.max_retries - 1:
                    return RESULT_NO_RESULT, elapsed, None
            except subprocess.TimeoutExpired:
                elapsed = time.time() - start
                if attempt == self.max_retries - 1:
                    return RESULT_TIMEOUT, elapsed, None

        return RESULT_ERROR, 0.0, None

    def solve_batch(self, items, jobs=None, timeout=None, on_result=None):
        """
        并行求解多个 CNF（DWP/RSP：同一概率权重下的多个 (p,q) 格并行）。

        Args:
            items: [(index, cnf_path, sol_path), ...]
            jobs: 并发上限；None = 全部同时跑
            timeout: 每格单次求解超时（秒）；None = 不限（同 solve()）
            on_result: 每格出终态时回调一次 on_result(index, result, elapsed,
                model, terminated)——引擎用它即时回填记录/写明细。被 SAT 杀掉的
                格与从未派发的格也回调一次（result=TERMINATED, terminated=True）。

        Returns:
            dict index -> (result, elapsed, model, terminated)

        杀进程语义（guaranteed kill，零孤儿）：
        - 每格独立进程组（start_new_session）+ PR_SET_PDEATHSIG（父死子自杀，
          含 ppid 竞态自检）双保险；
        - 任一格 SAT → killpg(SIGKILL) 全部运行中格、队列剩余格不再派发，
          一律 TERMINATED（该批判 SAT，模型只认首个 SAT 格）；
        - 崩溃/超时逐格重试（同串行 solve() 的 max_retries），超限 NO_RESULT/TIMEOUT；
        - SIGINT/SIGTERM → 清理完子进程后按原信号退出（PENDING 占位行留给断点恢复）；
        - try/finally 兜底 reap 全部子进程（零僵尸）。
        """
        solver_bin = self._solver_binary()
        preexec = _make_preexec(os.getpid())
        states = {}       # index -> {"cnf", "sol", "attempts", "final"}
        todo = collections.deque()
        for index, cnf_path, sol_path in items:
            states[index] = {
                "cnf": cnf_path, "sol": sol_path, "attempts": 0, "final": None,
            }
            todo.append(index)
        running = {}      # pid -> {"idx", "proc", "attempt_start", "attempts", "timed_out"}
        jobs_cap = jobs if jobs and jobs > 0 else len(items)
        sat_found = [False]
        abort = [None]

        def finalize(idx, result, elapsed, model, terminated):
            if states[idx]["final"] is not None:
                return
            states[idx]["final"] = (result, elapsed, model, terminated)
            if on_result is not None:
                on_result(idx, result, elapsed, model, terminated)

        def spawn(idx, attempts):
            st = states[idx]
            proc = subprocess.Popen(
                [solver_bin, st["cnf"]],
                stdout=open(st["sol"], "w"),
                stderr=subprocess.DEVNULL,
                start_new_session=True,
                preexec_fn=preexec,
            )
            st["attempts"] = attempts
            running[proc.pid] = {
                "idx": idx, "proc": proc,
                "attempt_start": time.time(), "attempts": attempts,
                "timed_out": False,
            }

        def kill_all_running(record_terminated):
            """杀光运行中格并 reap（零僵尸）。record_terminated=True 时逐格回调
            TERMINATED（SAT 判定的批内终止）；False 只清理（异常/信号退出路径，
            占位行保持 PENDING 供断点恢复）。"""
            for pid, info in list(running.items()):
                try:
                    os.killpg(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                try:
                    info["proc"].wait(timeout=10)
                except subprocess.TimeoutExpired:
                    pass  # 极端罕见（D 状态进程），交由系统回收
                running.pop(pid, None)
                if record_terminated:
                    finalize(info["idx"], RESULT_TERMINATED,
                             time.time() - info["attempt_start"], None, True)

        old_handlers = {}

        def _abort_handler(signum, frame):
            abort[0] = signum

        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                old_handlers[sig] = signal.signal(sig, _abort_handler)
            except (ValueError, OSError):
                pass  # 非主线程不能设 handler（solve_batch 只在主线程被调）

        try:
            while not abort[0]:
                # 派发填满空位（SAT 后不再派发新格）
                while (not sat_found[0]) and todo and len(running) < jobs_cap:
                    spawn(todo.popleft(), 1)
                if not running:
                    break
                time.sleep(0.02)
                # 收一轮完成/超时事件
                events = []
                for pid, info in list(running.items()):
                    proc = info["proc"]
                    rc = proc.poll()
                    if rc is not None:
                        events.append((pid, rc, info))
                    elif timeout is not None and \
                            time.time() - info["attempt_start"] > timeout:
                        info["timed_out"] = True
                        try:
                            os.killpg(pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                        try:
                            proc.wait(timeout=10)
                        except subprocess.TimeoutExpired:
                            pass
                        events.append((pid, proc.returncode, info))
                for pid, rc, info in events:
                    if pid not in running:
                        continue  # 已被 SAT 终止处理过
                    running.pop(pid, None)
                    idx = info["idx"]
                    elapsed = time.time() - info["attempt_start"]
                    if rc == KISSAT_RET_SAT:
                        sat_found[0] = True
                        finalize(idx, RESULT_SATISFIABLE, elapsed,
                                 parse_kissat_solution(states[idx]["sol"]), False)
                        kill_all_running(record_terminated=True)
                        break
                    if rc == KISSAT_RET_UNSAT:
                        finalize(idx, RESULT_UNSATISFIABLE, elapsed, None, False)
                        continue
                    # 崩溃或超时 → 重试（同串行 max_retries 语义：第 max_retries
                    # 次仍失败才给终态；timeout 命中的杀出 TIMEOUT，其余 NO_RESULT）
                    if info["attempts"] < self.max_retries:
                        spawn(idx, info["attempts"] + 1)
                    elif info["timed_out"]:
                        finalize(idx, RESULT_TIMEOUT, elapsed, None, False)
                    else:
                        finalize(idx, RESULT_NO_RESULT, elapsed, None, False)
            if sat_found[0]:
                # 队列里从未派发的格：一并 TERMINATED（占位行已写，回填之）
                while todo:
                    finalize(todo.popleft(), RESULT_TERMINATED, 0.0, None, True)
        finally:
            kill_all_running(record_terminated=False)
            for sig, handler in old_handlers.items():
                try:
                    signal.signal(sig, handler)
                except (ValueError, OSError):
                    pass

        if abort[0]:
            # 默认 handler 已恢复 → 标准退出码（SIGINT→KeyboardInterrupt/130，
            # SIGTERM→143），PENDING 占位行留盘供断点恢复重跑
            signal.raise_signal(abort[0])

        return {idx: st["final"] for idx, st in states.items()
                if st["final"] is not None}
