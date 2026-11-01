"""
bca/record.py 与 bca/engine.py 的单测。

两个模块是搜索层的"记账"与"流程"中枢，出错方式都是静默的：
- record：断点恢复键写错 → 该重跑的没重跑（用旧解冒充新解），
  或非终态行被当成命中；批处理占位行回填错位 → 行的 round/prob 与内容不符。
- engine：占位/回填顺序错 → CSV 行序与枚举序不符；被 SAT 杀掉的格仍写界数组
  → bounds.json 里出现"没解出来却有界"的条目；批内出现 TIMEOUT 却当 UNSAT
  推进 → prob 界记错，后续全部结果偏低。

所以这里不测"函数返回了什么"，而测"落到磁盘上的东西是否符合约定"：
CSV 行内容/行序、bounds.json 键、path 明细是否该出现、cleanup 是否真删了文件。

engine 的输入是 ctx 原语，因此用 FakeCtx（真 Record/BoundsStore + 假 solver/cipher）
注入。CNF 生成用 FakeCipher 提供变量结构，但走真的 CNFBuffer 与序列编码，
断言的是真实写出的 CNF 文件（含 p cnf 头与子句计数自洽）。

运行：
    manage.py test analysis.test_bca_engine_record
    python -m unittest analysis.test_bca_engine_record
"""

import contextlib
import csv
import io
import itertools
import json
import os
import pathlib
import re
import shutil
import sys
import tempfile
import threading
import unittest
from unittest import mock

BCA_DIR = pathlib.Path(__file__).resolve().parent.parent / "backend" / "bca_light"
if str(BCA_DIR) not in sys.path:
    sys.path.append(str(BCA_DIR))

from bca import engine  # noqa: E402
from bca.consts import (  # noqa: E402
    RESULT_ERROR,
    RESULT_NO_RESULT,
    RESULT_PENDING,
    RESULT_SATISFIABLE,
    RESULT_TERMINATED,
    RESULT_TIMEOUT,
    RESULT_UNSATISFIABLE,
)
from bca.record import HEADER, BoundsStore, Record  # noqa: E402


# =============================================================================
# 公共夹具
# =============================================================================

def read_csv_rows(path):
    with open(path, newline="") as f:
        return list(csv.DictReader(f))


def capture(fn, *args, **kwargs):
    """跑一次并抓 stdout（engine 的进度行/告警都在 stdout 上）。"""
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        result = fn(*args, **kwargs)
    return result, buf.getvalue()


class TempCwdCase(unittest.TestCase):
    """Record/BoundsStore 的路径是相对 cwd 的（results/...），必须在空临时目录里跑。"""

    def setUp(self):
        self._old_cwd = os.getcwd()
        self.tmp = tempfile.mkdtemp(prefix="bca-test-")
        os.chdir(self.tmp)
        self.addCleanup(self._restore)
        # engine 每解一格都往 stdout 打进度行，对断言无用；测试期统一收进
        # 缓冲（capture() 内层再重定向，仍能单独抓某一次调用的输出）
        quiet = contextlib.redirect_stdout(io.StringIO())
        quiet.__enter__()
        self.addCleanup(quiet.__exit__, None, None, None)

    def _restore(self):
        os.chdir(self._old_cwd)
        shutil.rmtree(self.tmp, ignore_errors=True)


class FakeTask:
    def __init__(self, name="t1", algorithm="SM4", model="DW",
                 attack="differential", solver_timeout=None):
        self.name = name
        self.algorithm = algorithm
        self.model = model
        self.attack = attack
        self.solver_timeout = solver_timeout

    @property
    def algorithm_key(self):
        return self.algorithm

    @property
    def detail_dir(self):
        return os.path.join("results", self.name, self.algorithm, self.model, "details")


class FakeSolver:
    """串行求解器替身：solve 总是立即返回预设结果，并落一个假 sol 文件。"""

    name = "fake"

    def __init__(self, result=RESULT_UNSATISFIABLE, elapsed=1.25, model=None):
        self.result = result
        self.elapsed = elapsed
        self.model = model
        self.solve_calls = []
        self.batch_calls = []

    def solve(self, cnf_path, solution_path, timeout=None):
        self.solve_calls.append(
            {"cnf": cnf_path, "sol": solution_path, "timeout": timeout})
        with open(solution_path, "w") as f:
            f.write("s FAKE\n")
        return self.result, self.elapsed, self.model


class FakeBatchSolver(FakeSolver):
    """批处理替身：按 plan 逐格回 result，并复刻"任一 SAT → 其余 TERMINATED"。"""

    def __init__(self, plan=None, default=RESULT_UNSATISFIABLE, on_batch=None):
        super().__init__()
        self.plan = plan or {}
        self.default = default
        self.on_batch = on_batch       # 求解瞬间回调（用于断言"占位已先落盘"）

    def solve_batch(self, items, jobs=None, timeout=None, on_result=None):
        items = list(items)
        self.batch_calls.append({"items": items, "jobs": jobs, "timeout": timeout})
        if self.on_batch is not None:
            self.on_batch()
        out = {}
        sat_seen = False
        for index, _cnf, _sol in items:
            if sat_seen:
                result, elapsed, model, terminated = (
                    RESULT_TERMINATED, 0.1, None, True)
            else:
                result, elapsed, model, terminated = self.plan.get(
                    index, (self.default, 0.5, None, False))
                if result == RESULT_SATISFIABLE:
                    sat_seen = True
            if on_result is not None:
                on_result(index, result, elapsed, model, terminated)
            out[index] = (result, elapsed, model, terminated)
        return out


class FakeCtx:
    """engine 依赖的原语集合：真 Record/BoundsStore，假 solver/cipher。"""

    def __init__(self, task=None, solver=None, cipher=None):
        self.task = task or FakeTask()
        self.solver = solver or FakeSolver()
        self.cipher = cipher or FakeCipher()
        self.record = Record(self.task, self.task.algorithm_key, self.task.model)
        self.bounds = BoundsStore(self.task, self.task.algorithm_key, self.task.model)
        self.cnf_dir = os.path.join(self.task.detail_dir, "cnf")
        self.sol_dir = os.path.join(self.task.detail_dir, "sol")
        self.path_dir = os.path.join(self.task.detail_dir, "path")
        for d in (self.cnf_dir, self.sol_dir, self.path_dir):
            os.makedirs(d, exist_ok=True)
        self.cleanup_calls = []

    def new_pool(self):
        return None

    @staticmethod
    def _tag(tag):
        return f"-T{tag}" if tag is not None else ""

    def cnf_path(self, round_num, prob, tag=None):
        return os.path.join(self.cnf_dir, f"R{round_num}-P{prob}{self._tag(tag)}.cnf")

    def sol_path(self, round_num, prob, tag=None):
        return os.path.join(
            self.sol_dir, f"R{round_num}-P{prob}{self._tag(tag)}_Solution.txt")

    def path_path(self, round_num, prob, tag=None):
        return os.path.join(self.path_dir, f"R{round_num}-P{prob}{self._tag(tag)}.txt")

    def cleanup(self, cnf_path=None, sol_path=None):
        self.cleanup_calls.append((cnf_path, sol_path))
        # 对齐真 Ctx 的默认：删 CNF，保留 sol
        if cnf_path and os.path.exists(cnf_path):
            os.unlink(cnf_path)


class FakeCipher:
    """只提供 engine 需要的变量结构与轮函数钩子，编号连续可预测。"""

    NAME = "FAKE"

    def __init__(self, weight_vars=3):
        self.weight_vars = weight_vars
        self._n = 0

    def _next(self):
        self._n += 1
        return self._n

    # -- pq 体系 --
    def generate_variables_pq(self, pool, round_count, p_lower, p_upper,
                              q_lower, q_upper):
        n = self.weight_vars
        vars = {}
        for key in ("p", "q"):
            # 一行、n 个权重变量；aux 与之一一对应（每个 2 位）
            vars[key] = [[self._next() for _ in range(n)]]
            vars[f"{key}_aux_u"] = [
                [[self._next() for _ in range(2)] for _ in range(n)]]
        return vars, self._n

    def generate_round_function_constraints(self, vars, round_count, buf):
        anchor = vars["p"][0][0]
        for _ in range(round_count):
            buf.write_clause([anchor, -anchor])

    # -- w7 体系 --
    def generate_variables_w7(self, pool, round_count, lower_bound, upper_bound):
        n = 7
        vars = {
            # w[r][sbox][0..6]：单轮单 S-box → 7 个权重变量
            "w": [[[self._next() for _ in range(n)]]],
            "aux_u": [[[self._next() for _ in range(2)] for _ in range(n)]],
        }
        return vars, self._n

    def generate_round_function_constraints_w7(self, vars, round_count, buf):
        w = vars["w"][0][0][0]
        for _ in range(round_count):
            buf.write_clause([w])


def cnf_build_stub(ctx, round_num=1, prob=4, tag=None, var_count=2, clauses=1):
    """engine 期望的 cnf_build：无参 callable → 6 元组。"""
    calls = []

    def build():
        calls.append(1)
        path = ctx.cnf_path(round_num, prob, tag)
        with open(path, "w") as f:
            f.write(f"p cnf {var_count} {clauses}\n1 0\n")
        return path, var_count, clauses, 0.125, None, {"stub": True}

    build.calls = calls
    return build


# =============================================================================
# record.Record
# =============================================================================

class RecordTest(TempCwdCase):
    def make(self, task=None, algorithm=None, model=None):
        task = task or FakeTask()
        return Record(task, algorithm or task.algorithm_key, model or task.model)

    def test_path_layout_matches_convention(self):
        r = self.make()
        self.assertEqual(
            r.path,
            os.path.join("results", "t1", "SM4", "DW", "results.csv"))
        self.assertTrue(os.path.isdir(os.path.dirname(r.path)),
                        "构造时应自动建目录")

    def test_first_write_creates_header_then_rows(self):
        r = self.make()
        self.assertTrue(r.write(4, 6, 0, 1, RESULT_SATISFIABLE, 1.5,
                                120, 340, 0.25, "kissat"))
        with open(r.path, newline="") as f:
            lines = f.read().splitlines()
        self.assertEqual(lines[0].split(",")[:4],
                         ["task", "algorithm", "model", "attack"])
        self.assertEqual(len(lines), 2)
        row = read_csv_rows(r.path)[0]
        self.assertEqual(row["task"], "t1")
        self.assertEqual(row["algorithm"], "SM4")
        self.assertEqual(row["model"], "DW")
        self.assertEqual(row["attack"], "differential")
        self.assertEqual(row["round"], "4")
        self.assertEqual(row["prob"], "6")
        self.assertEqual(row["solve_time"], "1.5000")
        self.assertEqual(row["cnf_time"], "0.2500")
        self.assertEqual(row["solver"], "kissat")
        self.assertEqual(row["full_parallel"], "", "串行模型留空")

    def test_lookup_hit_returns_row_and_miss_returns_none(self):
        r = self.make()
        r.write(4, 6, 0, 1, RESULT_SATISFIABLE, 1.0, 10, 20, 0.1, "kissat")
        self.assertIsNotNone(r.lookup(4, 6, 0, 1))
        self.assertIsNone(r.lookup(5, 6, 0, 1), "轮数不同不该命中")
        self.assertIsNone(r.lookup(4, 8, 0, 1), "prob 不同不该命中")
        self.assertIsNone(r.lookup(4, 6, 0, 2), "lsv 不同不该命中")

    def test_non_terminal_rows_are_not_resume_hits(self):
        """超时/无结果必须重跑，否则会把"没解出来"当已完成跳过。"""
        for result in (RESULT_TIMEOUT, RESULT_NO_RESULT, RESULT_ERROR,
                       RESULT_PENDING):
            with self.subTest(result=result):
                r = self.make(model=f"M{result}")
                r.write(1, 0, None, None, result, 0.0, 0, 0, 0.0, "kissat")
                self.assertIsNone(r.lookup(1, 0, None, None))

    def test_terminal_row_is_idempotent(self):
        r = self.make()
        self.assertTrue(r.write(1, 0, None, None, RESULT_UNSATISFIABLE,
                                1.0, 10, 20, 0.1, "kissat"))
        self.assertFalse(r.write(1, 0, None, None, RESULT_SATISFIABLE,
                                 9.0, 99, 999, 9.0, "kissat"))
        rows = read_csv_rows(r.path)
        self.assertEqual(len(rows), 1, "终态行不许被覆盖或追加")
        self.assertEqual(rows[0]["result"], RESULT_UNSATISFIABLE)
        self.assertEqual(rows[0]["solve_time"], "1.0000")

    def test_non_terminal_placeholder_is_filled_in_place(self):
        """批处理"先占位、解出回填"：行数不变，内容更新。"""
        r = self.make()
        self.assertTrue(r.write(4, 6, 0, 1, RESULT_PENDING, 0.0, 0, 0, 0.0,
                                "kissat", full_parallel="1"))
        self.assertTrue(r.write(4, 6, 0, 1, RESULT_SATISFIABLE, 2.0,
                                120, 340, 0.25, "kissat", full_parallel="1"))
        rows = read_csv_rows(r.path)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["result"], RESULT_SATISFIABLE)
        self.assertEqual(rows[0]["var_count"], "120")
        self.assertEqual(rows[0]["full_parallel"], "1")
        self.assertEqual(r.lookup(4, 6, 0, 1)["result"], RESULT_SATISFIABLE)

    def test_in_place_fill_keeps_file_row_order(self):
        """回填顺序与占位顺序无关，文件行序恒为占位序（=枚举序）。"""
        r = self.make()
        r.write(1, 4, 0, 1, RESULT_PENDING, 0.0, 0, 0, 0.0, "kissat")
        r.write(1, 4, 0, 2, RESULT_PENDING, 0.0, 0, 0, 0.0, "kissat")
        r.write(1, 4, 0, 3, RESULT_PENDING, 0.0, 0, 0, 0.0, "kissat")
        # 倒序回填
        r.write(1, 4, 0, 3, RESULT_UNSATISFIABLE, 1.0, 1, 1, 0.1, "kissat")
        r.write(1, 4, 0, 2, RESULT_UNSATISFIABLE, 1.0, 1, 1, 0.1, "kissat")
        r.write(1, 4, 0, 1, RESULT_UNSATISFIABLE, 1.0, 1, 1, 0.1, "kissat")
        self.assertEqual([row["lsv"] for row in read_csv_rows(r.path)],
                         ["1", "2", "3"])

    def test_map_and_pq_keys_do_not_collide(self):
        """MAP 的 msv/lsv=None 与 pq 的 0 值必须区分开，否则串行/并行记录互相覆盖。"""
        r = self.make()
        r.write(2, 0, None, None, RESULT_SATISFIABLE, 1.0, 1, 1, 0.1, "kissat")
        r.write(2, 0, 0, 0, RESULT_UNSATISFIABLE, 1.0, 1, 1, 0.1, "kissat")
        self.assertEqual(len(read_csv_rows(r.path)), 2)
        self.assertEqual(r.lookup(2, 0, None, None)["result"],
                         RESULT_SATISFIABLE)
        self.assertEqual(r.lookup(2, 0, 0, 0)["result"],
                         RESULT_UNSATISFIABLE)

    def test_reload_from_disk_resumes(self):
        """断点恢复的根基：新进程重新构造 Record 时必须读回旧行。"""
        self.make().write(3, 0, None, None, RESULT_SATISFIABLE,
                          1.0, 11, 22, 0.5, "kissat")
        fresh = self.make()
        row = fresh.lookup(3, 0, None, None)
        self.assertIsNotNone(row, "重新构造后应命中已有记录")
        self.assertEqual(row["var_count"], "11")
        self.assertEqual(row["cnf_time"], "0.5000")

    def test_empty_existing_file_is_tolerated(self):
        r = self.make()
        os.makedirs(os.path.dirname(r.path), exist_ok=True)
        open(r.path, "w").close()
        self.make()  # 不抛异常
        self.assertIsNone(r.lookup(1, 0, None, None))

    def test_per_algorithm_and_model_are_separate_files(self):
        a = self.make()
        b = Record(FakeTask(), "SM4", "AS")
        c = Record(FakeTask(algorithm="AES"), "AES", "DW")
        self.assertEqual(len({a.path, b.path, c.path}), 3)
        a.write(1, 0, None, None, RESULT_SATISFIABLE, 1.0, 1, 1, 0.1, "k")
        self.assertIsNone(b.lookup(1, 0, None, None), "不同模型不该共享记录")

    def test_concurrent_writes_are_all_persisted(self):
        """批处理回填是多线程回调，行不能丢也不能重复。"""
        r = self.make()

        def work(i):
            r.write(1, i, None, None, RESULT_UNSATISFIABLE, 0.1, 1, 1, 0.1, "k")

        threads = [threading.Thread(target=work, args=(i,)) for i in range(20)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        rows = read_csv_rows(r.path)
        self.assertEqual(len(rows), 20)
        self.assertEqual(sorted(int(row["prob"]) for row in rows),
                         list(range(20)))
        for i in range(20):
            self.assertIsNotNone(r.lookup(1, i, None, None))

    def test_header_constants_cover_written_fields(self):
        """CSV 头与 write() 写入的键必须一致（少一个字段 DictReader 会 KeyError）。"""
        r = self.make()
        r.write(1, 0, None, None, RESULT_ERROR, 0.0, 0, 0, 0.0, "k")
        with open(r.path, newline="") as f:
            reader = csv.DictReader(f)
            self.assertEqual(reader.fieldnames, HEADER)
            row = next(iter(reader))
        self.assertEqual(set(row), set(HEADER))


# =============================================================================
# record.BoundsStore
# =============================================================================

class BoundsStoreTest(TempCwdCase):
    def load(self, store):
        with open(store.path) as f:
            return json.load(f)

    def test_path_is_json_beside_results_csv(self):
        store = BoundsStore(FakeTask(), "SM4", "DW")
        self.assertEqual(
            store.path,
            os.path.join("results", "t1", "SM4", "DW", "bounds.json"))

    def test_pq_key_includes_p_and_q(self):
        store = BoundsStore(FakeTask(), "SM4", "DW")
        store.add(4, 6, 0, 1, {"p_lower": [0], "p_upper": [1],
                               "q_lower": [1], "q_upper": [1]})
        data = self.load(store)
        self.assertEqual(list(data), ["R4-P6-m0-q1"])
        entry = data["R4-P6-m0-q1"]
        self.assertEqual(entry["round"], 4)
        self.assertEqual(entry["prob"], 6)
        self.assertEqual(entry["p"], 0)
        self.assertEqual(entry["q"], 1)
        self.assertEqual(entry["p_upper"], [1])

    def test_map_key_has_no_pq(self):
        store = BoundsStore(FakeTask(), "SM4", "MAP")
        store.add(2, 0, None, None, {"lower": [0, 1], "upper": [1, 2]})
        data = self.load(store)
        self.assertEqual(list(data), ["R2-P0"])
        self.assertNotIn("p", data["R2-P0"])
        self.assertNotIn("q", data["R2-P0"])
        self.assertEqual(data["R2-P0"]["lower"], [0, 1])

    def test_adds_accumulate_and_same_key_overwrites(self):
        store = BoundsStore(FakeTask(), "SM4", "DW")
        store.add(4, 6, 0, 1, {"p_lower": [0]})
        store.add(4, 6, 0, 2, {"p_lower": [1]})
        store.add(5, 0, None, None, {"lower": [2]})
        self.assertEqual(sorted(self.load(store)),
                         ["R4-P6-m0-q1", "R4-P6-m0-q2", "R5-P0"])
        store.add(4, 6, 0, 1, {"p_lower": [9]})
        data = self.load(store)
        self.assertEqual(data["R4-P6-m0-q1"]["p_lower"], [9], "同键应覆盖")
        self.assertEqual(len(data), 3)

    def test_corrupt_json_is_reset_not_fatal(self):
        """崩溃留下的半截文件不能让后续 SAT 模型全部写不进界。"""
        store = BoundsStore(FakeTask(), "SM4", "DW")
        os.makedirs(os.path.dirname(store.path), exist_ok=True)
        with open(store.path, "w") as f:
            f.write('{"R1-P0": {"lower": [0')      # 截断
        store.add(2, 0, None, None, {"lower": [1], "upper": [2]})
        self.assertEqual(list(self.load(store)), ["R2-P0"])

    def test_atomic_write_leaves_no_tmp_file(self):
        store = BoundsStore(FakeTask(), "SM4", "DW")
        store.add(1, 0, None, None, {"lower": [0]})
        self.assertFalse(os.path.exists(store.path + ".tmp"),
                         "os.replace 后不该残留 .tmp")
        self.assertEqual(len(os.listdir(os.path.dirname(store.path))), 1)

    def test_same_key_dict_payload_is_not_aliased(self):
        """payload 是 arrays 的浅拷贝：调用方后续改自己的 dict 不该污染落盘内容。"""
        store = BoundsStore(FakeTask(), "SM4", "DW")
        arrays = {"lower": [0]}
        store.add(1, 0, None, None, arrays)
        arrays["lower"].append(5)
        self.assertEqual(self.load(store)["R1-P0"]["lower"], [0])


# =============================================================================
# engine：变量拍平与 CNF 生成
# =============================================================================

class EngineAuxTest(unittest.TestCase):
    def test_flatten_weight_vars_is_row_major(self):
        vars = {"p": [[1, 2], [3, 4]]}
        self.assertEqual(engine._flatten_weight_vars(vars, "p"), [1, 2, 3, 4])

    def test_flatten_weight_vars_unwraps_nested_lists(self):
        """w7 布局里 row 的每个元素本身是列表（每 S-box 一组）。"""
        vars = {"w": [[[1, 2], [3]], [[4]]]}
        self.assertEqual(engine._flatten_weight_vars(vars, "w"), [1, 2, 3, 4])

    def test_build_aux_structure_drops_one_row_level(self):
        aux_u = [[[1], [2]], [[3]]]
        self.assertEqual(engine._build_aux_structure(aux_u), [[1], [2], [3]])


class EngineCnfGenTest(TempCwdCase):
    def test_pq_cnf_file_is_self_consistent(self):
        ctx = FakeCtx()
        ctx.cipher = FakeCipher(weight_vars=3)
        path, var_count, clause_count, cnf_time, _pool, vars_ = \
            engine.generate_cnf_file(
                ctx, round_count=2,
                p_lower=[0, 0, 0], p_upper=[1, 1, 1],
                q_lower=[0, 0, 0], q_upper=[1, 1, 1],
                prob_weight=4)
        self.assertTrue(os.path.exists(path))
        self.assertEqual(path, ctx.cnf_path(2, 4))
        self.assertGreaterEqual(cnf_time, 0.0)
        with open(path) as f:
            lines = f.read().splitlines()
        m = re.match(r"^p cnf (\d+) (\d+)$", lines[0])
        self.assertIsNotNone(m, f"首行应是 p cnf 头，实际 {lines[0]!r}")
        self.assertEqual(int(m.group(1)), var_count)
        self.assertEqual(int(m.group(2)), clause_count,
                         "头部子句数必须等于实际子句行数")
        self.assertEqual(len(lines) - 1, clause_count)
        self.assertEqual(vars_["p"][0], [1, 2, 3], "变量编号应连续可预测")

    def test_pq_tag_goes_into_filename(self):
        ctx = FakeCtx()
        path, *_ = engine.generate_cnf_file(
            ctx, 1, [0, 0, 0], [1, 1, 1], [0, 0, 0], [1, 1, 1],
            prob_weight=0, tag="m0-q1")
        self.assertTrue(path.endswith("R1-P0-Tm0-q1.cnf"))

    def test_include_p_encoding_false_skips_p_clauses(self):
        """AS 模型走这条路：p 变量只受 S-box 约束，不做序列编码。"""
        p0, p_aux = 1, 4       # FakeCipher 的编号：p=1..3, p_aux=4..9
        bounds = dict(p_lower=[0, 0, 0], p_upper=[1, 1, 1],
                      q_lower=[0, 0, 0], q_upper=[1, 1, 1])

        ctx = FakeCtx()
        path_on, *_ = engine.generate_cnf_file(
            ctx, 1, prob_weight=0, include_p_encoding=True, **bounds)
        with open(path_on) as f:
            on = f.read()
        self.assertIn(f"-{p0} {p_aux + p0 - 1} 0", on, "p 序列编码应存在")

        path_off, *_ = engine.generate_cnf_file(
            ctx, 1, prob_weight=0, include_p_encoding=False, **bounds)
        with open(path_off) as f:
            off = f.read()
        self.assertNotIn(f"-{p0} {p_aux + p0 - 1} 0", off,
                         "关掉 p 编码后不该再有 p 的子句")
        self.assertNotEqual(on, off)
        # q 编码两条路径都必须保留（关的只是 p）
        self.assertIn("0\n", off)

    def test_zero_bounds_force_weight_var_to_false(self):
        ctx = FakeCtx()
        path, *_ = engine.generate_cnf_file(
            ctx, 1, [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], prob_weight=0)
        with open(path) as f:
            clauses = f.read().splitlines()[1:]
        self.assertIn("-1 0", clauses, "上下界都 0 → 权重变量必须为假")

    def test_w7_cnf_flattens_seven_weight_vars(self):
        ctx = FakeCtx()
        path, var_count, clause_count, _t, _p, vars_ = \
            engine.generate_cnf_file_w7(
                ctx, round_count=3, lower_bound=[0] * 7, upper_bound=[1] * 7,
                prob_weight=0)
        self.assertEqual(len(vars_["w"][0][0]), 7)
        with open(path) as f:
            lines = f.read().splitlines()
        self.assertTrue(lines[0].startswith(f"p cnf {var_count} {clause_count}"))
        self.assertEqual(len(lines) - 1, clause_count)
        weights = engine._flatten_weight_vars(vars_, "w")
        self.assertEqual(weights, list(range(1, 8)))


# =============================================================================
# engine：串行流程 solve_sat_and_record
# =============================================================================

class EngineSolveRecordTest(TempCwdCase):
    def make_ctx(self, **kw):
        solver = kw.pop("solver", None) or FakeSolver()
        ctx = FakeCtx(solver=solver, **kw)
        return ctx

    def test_resume_hit_skips_build_and_solve(self):
        ctx = self.make_ctx()
        ctx.record.write(4, 6, 0, 1, RESULT_SATISFIABLE, 2.5, 100, 200, 0.75,
                         "kissat")
        build = cnf_build_stub(ctx, 4, 6)

        outcome, out = capture(engine.solve_sat_and_record,
                               ctx, 4, 6, 0, 1, build)

        self.assertTrue(outcome.resumed)
        self.assertEqual(outcome.result, RESULT_SATISFIABLE)
        self.assertEqual(outcome.solve_time, 2.5)
        self.assertEqual(outcome.var_count, 100)
        self.assertEqual(outcome.clause_count, 200)
        self.assertEqual(outcome.cnf_time, 0.75)
        self.assertIsNone(outcome.model)
        self.assertEqual(build.calls, [], "命中恢复不该重建 CNF")
        self.assertEqual(ctx.solver.solve_calls, [], "命中恢复不该再求解")
        self.assertIn("recorded, skip", out, "应打一行 skip 进度，避免长时间静默")
        self.assertEqual(len(read_csv_rows(ctx.record.path)), 1, "不许重复追加")

    def test_resume_miss_runs_full_pipeline(self):
        ctx = self.make_ctx(solver=FakeSolver(RESULT_UNSATISFIABLE, 3.0))
        build = cnf_build_stub(ctx, 1, 4)

        outcome = engine.solve_sat_and_record(ctx, 1, 4, 0, 1, build)

        self.assertFalse(outcome.resumed)
        self.assertEqual(outcome.result, RESULT_UNSATISFIABLE)
        self.assertEqual(outcome.solve_time, 3.0)
        self.assertEqual(outcome.var_count, 2)
        self.assertEqual(outcome.clause_count, 1)
        self.assertEqual(outcome.cnf_time, 0.125)
        self.assertEqual(len(ctx.solver.solve_calls), 1)
        rows = read_csv_rows(ctx.record.path)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["result"], RESULT_UNSATISFIABLE)
        self.assertEqual(rows[0]["solve_time"], "3.0000")
        self.assertEqual(rows[0]["cnf_time"], "0.1250")
        self.assertEqual(rows[0]["var_count"], "2")
        self.assertEqual(rows[0]["clause_count"], "1")
        self.assertEqual(rows[0]["solver"], "fake")

    def test_solver_timeout_comes_from_task(self):
        ctx = self.make_ctx(task=FakeTask(solver_timeout=42))
        engine.solve_sat_and_record(ctx, 1, 0, None, None,
                                    cnf_build_stub(ctx, 1, 0))
        self.assertEqual(ctx.solver.solve_calls[0]["timeout"], 42)

    def test_cnf_is_cleaned_up_after_solve(self):
        ctx = self.make_ctx()
        build = cnf_build_stub(ctx, 1, 0)
        engine.solve_sat_and_record(ctx, 1, 0, None, None, build)
        cnf, sol = ctx.cleanup_calls[0]
        self.assertEqual(cnf, ctx.cnf_path(1, 0))
        self.assertEqual(sol, ctx.sol_path(1, 0))
        self.assertFalse(os.path.exists(cnf), "cleanup 应真的删掉 CNF")

    def test_bounds_written_only_when_passed(self):
        ctx = self.make_ctx()
        engine.solve_sat_and_record(ctx, 1, 0, None, None,
                                    cnf_build_stub(ctx, 1, 0))
        self.assertFalse(os.path.exists(ctx.bounds.path),
                         "bounds=None 不该产生 bounds.json")

        ctx2 = self.make_ctx(task=FakeTask(model="MAP"))
        engine.solve_sat_and_record(ctx2, 2, 0, None, None,
                                    cnf_build_stub(ctx2, 2, 0),
                                    bounds={"lower": [0], "upper": [1]})
        self.assertEqual(list(json.load(open(ctx2.bounds.path))), ["R2-P0"])

    def test_sat_with_model_writes_path_detail(self):
        ctx = self.make_ctx(solver=FakeSolver(RESULT_SATISFIABLE, 1.0,
                                              model=[1, -2, 3]))
        with mock.patch.object(engine, "extract_rounds",
                               return_value=(["rounds"], "final")) as er, \
                mock.patch.object(engine, "format_path",
                                  return_value="FORMATTED-PATH\n"):
            outcome = engine.solve_sat_and_record(ctx, 4, 6, 0, 1,
                                                  cnf_build_stub(ctx, 4, 6),
                                                  tag="m0-q1")
        detail = ctx.path_path(4, 6, "m0-q1")
        self.assertTrue(os.path.exists(detail), "SAT 应写差分路径明细")
        text = open(detail).read()
        self.assertIn("FAKE R4-P6 SAT 差分路径", text)
        self.assertIn("(tag=m0-q1)", text)
        self.assertIn("FORMATTED-PATH", text)
        er.assert_called_once()
        self.assertEqual(outcome.model, [1, -2, 3])

    def test_sat_without_model_writes_no_detail(self):
        """kissat 偶发拿不到 v 行时不能写空明细（否则会被当成有效路径）。"""
        ctx = self.make_ctx(solver=FakeSolver(RESULT_SATISFIABLE, 1.0, model=None))
        engine.solve_sat_and_record(ctx, 4, 6, 0, 1, cnf_build_stub(ctx, 4, 6))
        self.assertFalse(os.path.exists(ctx.path_path(4, 6)))

    def test_unsat_writes_no_detail(self):
        ctx = self.make_ctx(solver=FakeSolver(RESULT_UNSATISFIABLE, 1.0,
                                              model=[1]))
        engine.solve_sat_and_record(ctx, 4, 6, 0, 1, cnf_build_stub(ctx, 4, 6))
        self.assertFalse(os.path.exists(ctx.path_path(4, 6)),
                         "UNSAT 不该有路径明细")


# =============================================================================
# engine：批处理流程 solve_sat_batch_and_record
# =============================================================================

class EngineSolveBatchTest(TempCwdCase):
    def entries(self, ctx, cells, prob=6):
        out = []
        for msv, lsv in cells:
            out.append({
                "msv": msv,
                "lsv": lsv,
                "bounds": {"lower": [msv], "upper": [lsv]},
                "cnf_build": cnf_build_stub(
                    ctx, 1, prob, tag=f"m{msv}-q{lsv}"),
            })
        return out

    def test_all_unsat_records_every_cell_in_enumeration_order(self):
        ctx = FakeCtx()
        cells = [(0, 1), (0, 2), (0, 3)]
        solver = FakeBatchSolver(default=RESULT_UNSATISFIABLE)
        ctx.solver = solver

        outcomes, batch_sat = engine.solve_sat_batch_and_record(
            ctx, 1, 6, self.entries(ctx, cells))

        self.assertFalse(batch_sat)
        self.assertEqual(sorted(outcomes), cells)
        rows = read_csv_rows(ctx.record.path)
        self.assertEqual([(int(r["msv"]), int(r["lsv"])) for r in rows], cells)
        self.assertEqual({r["result"] for r in rows}, {RESULT_UNSATISFIABLE})
        self.assertEqual({r["full_parallel"] for r in rows}, {"1"})

    def test_placeholders_are_on_disk_before_solving(self):
        """断点恢复靠占位行兜住"进程被杀"——占位必须先落盘再派发。"""
        ctx = FakeCtx()
        cells = [(0, 1), (0, 2)]
        seen = {}

        def snapshot():
            rows = read_csv_rows(ctx.record.path)
            seen["results"] = [row["result"] for row in rows]
            seen["msv"] = [row["msv"] for row in rows]

        ctx.solver = FakeBatchSolver(on_batch=snapshot)
        engine.solve_sat_batch_and_record(ctx, 1, 6, self.entries(ctx, cells))

        self.assertEqual(seen["results"], [RESULT_PENDING] * 2,
                         "求解开始时两格都应已是 PENDING 占位")
        self.assertEqual(seen["msv"], ["0", "0"],
                         "占位顺序 = entries 顺序")

    def test_resumed_sat_short_circuits_whole_batch(self):
        """上一轮在本 prob 已解出 SAT：直接回放，不派发任何格（否则重复烧机时）。"""
        ctx = FakeCtx()
        cells = [(0, 1), (0, 2), (0, 3)]
        ctx.record.write(1, 6, 0, 2, RESULT_SATISFIABLE, 7.0, 50, 60, 0.5,
                         "kissat")
        ctx.solver = FakeBatchSolver()

        outcomes, batch_sat = engine.solve_sat_batch_and_record(
            ctx, 1, 6, self.entries(ctx, cells))

        self.assertTrue(batch_sat)
        self.assertEqual(list(outcomes), [(0, 2)],
                         "短路时只回放那个 SAT 格")
        self.assertTrue(outcomes[(0, 2)].resumed)
        self.assertEqual(outcomes[(0, 2)].solve_time, 7.0)
        self.assertEqual(ctx.solver.batch_calls, [], "不该派发求解")
        self.assertEqual(len(read_csv_rows(ctx.record.path)), 1)

    def test_resumed_unsat_is_replayed_and_rest_solved(self):
        ctx = FakeCtx()
        cells = [(0, 1), (0, 2), (0, 3)]
        ctx.record.write(1, 6, 0, 1, RESULT_UNSATISFIABLE, 2.0, 10, 20, 0.1,
                         "kissat")
        ctx.solver = FakeBatchSolver(default=RESULT_UNSATISFIABLE)

        outcomes, batch_sat = engine.solve_sat_batch_and_record(
            ctx, 1, 6, self.entries(ctx, cells))

        self.assertFalse(batch_sat)
        self.assertEqual(sorted(outcomes), cells)
        self.assertTrue(outcomes[(0, 1)].resumed)
        self.assertFalse(outcomes[(0, 2)].resumed)
        dispatched = [index for index, _c, _s in ctx.solver.batch_calls[0]["items"]]
        self.assertEqual(sorted(dispatched), [(0, 2), (0, 3)],
                         "已解出的格不该再派发")
        rows = read_csv_rows(ctx.record.path)
        self.assertEqual(len(rows), 3, "回放不新增行")

    def test_sat_kills_siblings_and_their_bounds_are_not_recorded(self):
        """被 SAT 杀掉的格没解出来，写进 bounds.json 会变成"无解却有界"。"""
        ctx = FakeCtx()
        cells = [(0, 1), (0, 2), (0, 3)]
        ctx.solver = FakeBatchSolver(
            plan={(0, 1): (RESULT_SATISFIABLE, 4.0, [1, -2], False)})

        with mock.patch.object(engine, "extract_rounds",
                               return_value=([], "")), \
                mock.patch.object(engine, "format_path", return_value="P\n"):
            outcomes, batch_sat = engine.solve_sat_batch_and_record(
                ctx, 1, 6, self.entries(ctx, cells))

        self.assertTrue(batch_sat)
        self.assertEqual(outcomes[(0, 1)].model, [1, -2])
        self.assertIsNone(outcomes[(0, 2)].model, "被杀格不该带 model")
        self.assertEqual(outcomes[(0, 2)].result, RESULT_TERMINATED)
        bounds = json.load(open(ctx.bounds.path))
        self.assertEqual(list(bounds), ["R1-P6-m0-q1"],
                         "只有真正解出的格才记界数组")
        rows = {int(r["lsv"]): r for r in read_csv_rows(ctx.record.path)}
        self.assertEqual(rows[1]["result"], RESULT_SATISFIABLE)
        self.assertEqual(rows[2]["result"], RESULT_TERMINATED)
        self.assertEqual(rows[3]["result"], RESULT_TERMINATED)

    def test_timeout_without_sat_raises_and_keeps_row_nonterminal(self):
        """把未知格当 UNSAT 推进会让 prob 界记错，必须炸出来。"""
        ctx = FakeCtx()
        cells = [(0, 1), (0, 2)]
        ctx.solver = FakeBatchSolver(plan={
            (0, 1): (RESULT_UNSATISFIABLE, 1.0, None, False),
            (0, 2): (RESULT_TIMEOUT, 9.0, None, False),
        })

        with self.assertRaises(RuntimeError) as cm:
            engine.solve_sat_batch_and_record(ctx, 1, 6, self.entries(ctx, cells))
        msg = str(cm.exception)
        self.assertIn("R1 P6", msg)
        self.assertIn("(0, 2)", msg)
        self.assertIn("resume", msg)

        rows = {int(r["lsv"]): r for r in read_csv_rows(ctx.record.path)}
        self.assertEqual(rows[2]["result"], RESULT_TIMEOUT)
        self.assertIsNone(ctx.record.lookup(1, 6, 0, 2),
                          "超时行非终态，resume 必须重跑该格")

    def test_full_parallel_flag_zero_when_cells_exceed_jobs(self):
        ctx = FakeCtx()
        cells = [(0, 1), (0, 2), (0, 3)]
        ctx.solver = FakeBatchSolver(default=RESULT_UNSATISFIABLE)

        _out, out = capture(engine.solve_sat_batch_and_record,
                            ctx, 1, 6, self.entries(ctx, cells), jobs=2)

        self.assertEqual({r["full_parallel"] for r in read_csv_rows(ctx.record.path)},
                         {"0"})
        self.assertIn("非物理全并行", out, "口径失真必须打出来，不能静默")
        self.assertEqual(ctx.solver.batch_calls[0]["jobs"], 2)

    def test_full_parallel_flag_one_when_jobs_allow_all(self):
        ctx = FakeCtx()
        cells = [(0, 1), (0, 2), (0, 3)]
        ctx.solver = FakeBatchSolver(default=RESULT_UNSATISFIABLE)

        engine.solve_sat_batch_and_record(ctx, 1, 6,
                                          self.entries(ctx, cells), jobs=3)
        self.assertEqual({r["full_parallel"] for r in read_csv_rows(ctx.record.path)},
                         {"1"})

    def test_batch_bounds_key_matches_cell_pq(self):
        ctx = FakeCtx()
        cells = [(1, 2), (3, 4)]
        ctx.solver = FakeBatchSolver(default=RESULT_UNSATISFIABLE)
        engine.solve_sat_batch_and_record(ctx, 5, 8, self.entries(ctx, cells))
        self.assertEqual(sorted(json.load(open(ctx.bounds.path))),
                         ["R5-P8-m1-q2", "R5-P8-m3-q4"])

    def test_batch_path_detail_only_for_sat_cell(self):
        ctx = FakeCtx()
        cells = [(0, 1), (0, 2)]
        ctx.solver = FakeBatchSolver(
            plan={(0, 2): (RESULT_SATISFIABLE, 1.0, [5], False)})
        with mock.patch.object(engine, "extract_rounds", return_value=([], "")), \
                mock.patch.object(engine, "format_path", return_value="P\n"):
            engine.solve_sat_batch_and_record(ctx, 1, 6,
                                              self.entries(ctx, cells))
        self.assertTrue(os.path.exists(ctx.path_path(1, 6, "m0-q2")))
        self.assertFalse(os.path.exists(ctx.path_path(1, 6, "m0-q1")))
        text = open(ctx.path_path(1, 6, "m0-q2")).read()
        self.assertIn("cell m0-q2", text)

    def test_batch_cleans_up_every_dispatched_cnf(self):
        ctx = FakeCtx()
        cells = [(0, 1), (0, 2)]
        ctx.solver = FakeBatchSolver(default=RESULT_UNSATISFIABLE)
        engine.solve_sat_batch_and_record(ctx, 1, 6, self.entries(ctx, cells))
        self.assertEqual(len(ctx.cleanup_calls), 2)
        self.assertEqual(
            sorted(call[0] for call in ctx.cleanup_calls),
            sorted([ctx.cnf_path(1, 6, "m0-q1"), ctx.cnf_path(1, 6, "m0-q2")]))
        self.assertEqual(os.listdir(ctx.cnf_dir), [], "CNF 应被清空")

    def test_empty_entries_returns_no_sat(self):
        ctx = FakeCtx()
        ctx.solver = FakeBatchSolver()
        outcomes, batch_sat = engine.solve_sat_batch_and_record(ctx, 1, 6, [])
        self.assertEqual(outcomes, {})
        self.assertFalse(batch_sat)


if __name__ == "__main__":
    unittest.main(verbosity=2)
