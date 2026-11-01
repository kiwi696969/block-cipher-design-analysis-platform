"""
SAT 求解结果记录与断点恢复。

CSV 按 (task, algorithm, model) 分文件：
    results/{task}/{algorithm}/{model}/results.csv
字段：task, algorithm, model, attack, round, prob, msv, lsv,
      result, solve_time, var_count, clause_count, cnf_time, solver,
      full_parallel, timestamp

full_parallel：DWP/RSP 每格一行，标该格所属 prob 批是否物理全并行——1 = 格数
≤ 并发上限（或全开），同批格真正同时并发；0 = 格数 > 并发上限（--sat-jobs），
格被分波排队，非真正并行，SAT 首杀/全 UNSAT max 的时间口径失真。串行模型不适用
（留空）。

断点恢复：task+algorithm+model+attack+round+prob+msv+lsv 全部相同才命中，
已记录的 SAT/UNSAT 结果跳过，未完成（TIMEOUT/NoResult）重新求解。
MAP 模型不记录 msv/lsv（留空）。

每个 SAT 模型的 MILP 界数组（pq 体系 p/q 上下界 4 数组 / MAP-w7 上下界 2
数组）集中记在模型目录下一个 bounds.json（见 BoundsStore），每个 SAT 模型
一条、键同 results.csv 行键，原子更新幂等；不记逐次求解的时间/时间戳等冗余。
"""

import csv
import json
import os
import threading
import time

from .consts import RESULT_SATISFIABLE, RESULT_UNSATISFIABLE

HEADER = [
    "task", "algorithm", "model", "attack", "round", "prob",
    "msv", "lsv", "result", "solve_time", "var_count", "clause_count",
    "cnf_time", "solver", "full_parallel", "timestamp",
]


def _norm(x):
    """None → 空字符串，其余 → str（保证与 CSV 读出的键类型一致）。"""
    return "" if x is None else str(x)


class Record:
    """单个 (task, algorithm, model) 的记录器。线程安全。"""

    def __init__(self, task, algorithm_key, model):
        self.task = task
        self.algorithm_key = algorithm_key
        self.model = model
        self.path = os.path.join(
            "results", task.name, algorithm_key, model, "results.csv"
        )
        self._lock = threading.Lock()
        self._rows = {}  # (round, prob, msv, lsv) -> row dict
        self._load()

    def _load(self):
        if not os.path.exists(self.path):
            os.makedirs(os.path.dirname(self.path), exist_ok=True)
            return
        with open(self.path, "r", newline="") as f:
            reader = csv.DictReader(f)
            for row in reader:
                key = (row["round"], row["prob"], row["msv"], row["lsv"])
                self._rows[key] = row

    def lookup(self, round_num, prob, msv=None, lsv=None):
        """断点恢复查询：命中返回记录行，否则 None。"""
        key = (str(round_num), str(prob), _norm(msv), _norm(lsv))
        with self._lock:
            row = self._rows.get(key)
        if row is None:
            return None
        # 未完成的（超时/无结果）不算命中，需要重跑
        if row["result"] not in (RESULT_SATISFIABLE, RESULT_UNSATISFIABLE):
            return None
        return row

    def write(self, round_num, prob, msv, lsv, result, solve_time,
              var_count, clause_count, cnf_time, solver, full_parallel=None):
        """追加/原位覆盖一条记录（同键三态行为）。

        - 键不存在 → 追加新行（串行路径原行为，O(1)）；
        - 键存在且终态（SAT/UNSAT）→ 幂等跳过，返回 False；
        - 键存在且非终态（PENDING/TERMINATED/TIMEOUT…）→ 原位覆盖该行
          （保留其文件中的行位置 = _rows 插入序，全量重写）。
        非终态覆盖用于批处理"先占位、解出结果再回填"模式（DWP/RSP）。

        full_parallel：DWP/RSP 批的物理全并行标记（"1"/"0"），同批全部格同值；
        串行模型不传（留空 = 不适用）。详见模块 docstring。"""
        key = (str(round_num), str(prob), _norm(msv), _norm(lsv))
        row = {
            "task": self.task.name,
            "algorithm": self.algorithm_key,
            "model": self.model,
            "attack": self.task.attack,
            "round": round_num,
            "prob": prob,
            "msv": _norm(msv),
            "lsv": _norm(lsv),
            "result": result,
            "solve_time": f"{solve_time:.4f}",
            "var_count": var_count,
            "clause_count": clause_count,
            "cnf_time": f"{cnf_time:.4f}",
            "solver": solver,
            "full_parallel": _norm(full_parallel),
            "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
        }
        with self._lock:
            existing = self._rows.get(key)
            if existing is not None and existing["result"] in (
                    RESULT_SATISFIABLE, RESULT_UNSATISFIABLE):
                return False
            if existing is not None:
                # 非终态占位行 → 原位回填（键不变 → _rows 插入序/文件行序不变）
                for field in HEADER:
                    existing[field] = row[field]
                self._rewrite_all()
                return True
            new_file = not os.path.exists(self.path)
            os.makedirs(os.path.dirname(self.path), exist_ok=True)
            with open(self.path, "a", newline="") as f:
                writer = csv.DictWriter(f, fieldnames=HEADER)
                if new_file:
                    writer.writeheader()
                writer.writerow(row)
            self._rows[key] = row
            return True

    def _rewrite_all(self):
        """全量重写 CSV：行序 = _rows 插入序 = 文件行序（覆盖占位行专用）。"""
        with open(self.path, "w", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=HEADER)
            writer.writeheader()
            for row in self._rows.values():
                writer.writerow(row)


def _bounds_key(round_num, prob, msv, lsv):
    """界数组记录键：同 results.csv 行键语义，pq 体系带 -m{p}-q{q}。

    同一 (round, prob) 可能多次尝试（p/q 不同），键须含 p/q 才能区分；
    MAP/AS 不传 msv/lsv 时键为 R{round}-P{prob}。"""
    key = f"R{round_num}-P{prob}"
    if msv is not None:
        key += f"-m{msv}"
    if lsv is not None:
        key += f"-q{lsv}"
    return key


class BoundsStore:
    """每个 (task, algorithm, model) 一个界数组文件：results/{task}/{algorithm}/{model}/bounds.json。

    集中记该模型全部 SAT 模型的 MILP 界数组（用户决策：不要逐模型一个 json，
    太分散）。每个 SAT 模型一条，键 = _bounds_key（同 results.csv 行键）：
        {
          "R4-P6-m0-q1": {"round": 4, "prob": 6, "p": 0, "q": 1,
                          "p_lower": [...], "p_upper": [...],
                          "q_lower": [...], "q_upper": [...]},
          "R2-P0":       {"round": 2, "prob": 0, "lower": [...], "upper": [...]}
        }
    线程安全；每次 add 读-改-写 + tmp + os.replace 原子落盘（崩溃不损坏已有
    记录）。同键覆盖（断点恢复命中的记录不在求解时重写）。
    """

    def __init__(self, task, algorithm_key, model):
        self.path = os.path.join(
            "results", task.name, algorithm_key, model, "bounds.json"
        )
        self._lock = threading.Lock()

    def add(self, round_num, prob, msv, lsv, arrays):
        """加入/覆盖一条界数组记录。

        arrays 为模型传入的数组 dict（pq 体系 {"p_lower","p_upper","q_lower",
        "q_upper"} / MAP {"lower","upper"}），补 round/prob（及有 p/q 时的
        p/q 键）。"""
        payload = dict(arrays)
        payload.setdefault("round", round_num)
        payload.setdefault("prob", prob)
        if msv is not None:
            payload.setdefault("p", msv)
        if lsv is not None:
            payload.setdefault("q", lsv)
        key = _bounds_key(round_num, prob, msv, lsv)
        with self._lock:
            data = {}
            if os.path.exists(self.path):
                try:
                    with open(self.path, "r") as f:
                        data = json.load(f)
                except (OSError, ValueError):
                    data = {}
            data[key] = payload
            os.makedirs(os.path.dirname(self.path), exist_ok=True)
            tmp_path = self.path + ".tmp"
            with open(tmp_path, "w") as f:
                json.dump(data, f, indent=2)
            os.replace(tmp_path, self.path)
