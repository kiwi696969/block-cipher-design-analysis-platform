"""
Phase 3 验证：MDW / AS 模型 vs 参考实现。

两部分：
1. 单元比对：refresh / compute_weight_bound / compute_double_matsui_bound 等
   纯函数与参考逐值一致（不求解）。
2. 行为对照：打补丁驱动参考主循环（solve_sat_problem → kissat subprocess，
   解析 s SATISFIABLE / s UNSATISFIABLE），跑小轮任务，比较最终界数组与
   每轮求解记录 vs BCA 模型 run_search 输出（经 record CSV 落盘）。

⚠️ 本脚本依赖本机的外部参考实现（REF_BASE 指向 ODSearch 的参考文件目录），
不属于本框架的一部分，拿到别的机器上跑之前需要先把 REF_BASE 改指到你自己的
参考实现路径。

用法：
    python scripts/verify_phase3.py          # 全部
    python scripts/verify_phase3.py --model MDW|AS
"""
import argparse
import importlib.util
import os
import shutil
import subprocess
import sys
import tempfile
import time

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_ESPRESSO = os.path.join(PROJECT_ROOT, "data", "espresso")
REF_BASE = "/home/Academic/projects/Fight2026/ODSearch/参考文件" \
           "（独立于项目的参考文件，非项目文件！）"
REF_SM4 = os.path.join(REF_BASE, "SM4")
SBOX_PATH = os.path.join(DATA_ESPRESSO, "SM4_S-Box_Consts.txt")

ALL_PASS = True
TASK_NAME = "verify-phase3"
RESULTS_DIR = os.path.join(PROJECT_ROOT, "results", TASK_NAME)


def check(label, ok, detail=""):
    global ALL_PASS
    ALL_PASS &= ok
    print(f"{label}: {'PASS' if ok else 'FAIL'}{('  ' + detail) if detail else ''}")


# =============================================================================
# 参考模块加载 / 参考循环驱动
# =============================================================================

def load_reference(ref_path):
    # 注册进 sys.modules：参考主循环用 Pool 并行算界，partial 打 pickle 时
    # 需要能 import 参考模块（fork 出的子进程从 sys.modules 取）
    spec = importlib.util.spec_from_file_location("bca_p3_ref", ref_path)
    ref = importlib.util.module_from_spec(spec)
    sys.modules["bca_p3_ref"] = ref
    spec.loader.exec_module(ref)
    return ref


def make_driver(ref, solver_path, prob_array, known_active=None):
    """打补丁 ref.solve_sat_problem → kissat subprocess，忠实移植参考行为。

    参考原版用 os.system + mallob 格式解析（[ result ] 段），kissat 输出格式
    不同（s SATISFIABLE 行）→ 换成 subprocess + 解析 s 行。返回求解日志列表
    [(round, prob, p, q, result)]，供与 BCA record CSV 对照。
    """
    solves = []

    def solve_sat_problem(round_count, p_lower, p_upper, q_lower, q_upper):
        prob_weight = getattr(ref, prob_array)[round_count]

        # RS 特有剪枝：q 界低于已知最小活跃 S-box 数 → 直接 UNSAT，不求解不记录
        # （与参考一致：此处 return 前不调 log_result，BCA 侧也不落 CSV）
        if known_active is not None and ref.qBound[round_count] < known_active[round_count]:
            return ref.RESULT_UNSATISFIABLE, 0, 0, 0

        # MDW 参考返回 3 元组（无 cnf_time），RS/AS 返回 4 元组
        gen = ref.generate_cnf_file(round_count, p_lower, p_upper, q_lower, q_upper,
                                    prob_weight)
        var_count, clause_count, cnf_filename = gen[:3]
        cnf_time = gen[3] if len(gen) > 3 else 0.0

        solution_filename = ref.SOLUTION_FILE_TEMPLATE.format(round_count, prob_weight)
        t0 = time.time()
        with open(solution_filename, "wb") as f:
            subprocess.run([solver_path, cnf_filename], stdout=f, check=False)
        solve_time = time.time() - t0
        with open(solution_filename, "rb") as f:
            out = f.read()
        if b"s SATISFIABLE" in out:
            result = ref.RESULT_SATISFIABLE
        elif b"s UNSATISFIABLE" in out:
            result = ref.RESULT_UNSATISFIABLE
        else:
            result = ref.RESULT_NO_RESULT

        ref.log_result(round_count, prob_weight, result, solve_time,
                       var_count, clause_count, cnf_time)
        os.remove(cnf_filename)
        solves.append((round_count, prob_weight, ref.pBound[round_count],
                       ref.qBound[round_count], result))
        return result, var_count, clause_count, solve_time

    ref.solve_sat_problem = solve_sat_problem
    return solves


def drive_reference(ref, solver_path, round_start, round_end):
    """在临时 cwd 跑参考主循环。返回最终界数组切片（含每轮结果）。"""
    workdir = tempfile.mkdtemp(prefix="verify_p3_ref_")
    os.chdir(workdir)
    try:
        ref.SBOX_CONSTRAINT_FILE = SBOX_PATH
        ref.SOLVER_PATH = solver_path
        if hasattr(ref, "KISSAT_PATH"):
            ref.KISSAT_PATH = solver_path
        ref.SEARCH_ROUND_START = round_start
        ref.SEARCH_ROUND_END = round_end
        ref.run_differential_search()
    finally:
        os.chdir(PROJECT_ROOT)
        shutil.rmtree(workdir, ignore_errors=True)


def bca_run(model_name, round_start, round_end):
    """构造 Ctx 跑 BCA 模型 run_search → (result dict, task)。"""
    sys.path.insert(0, PROJECT_ROOT)
    from bca.config import load_config
    from bca.cipher import get_cipher
    from bca.ctx import Ctx
    from bca.solver import KissatSolver
    from bca.task import Task
    from models import get_model

    cfg = load_config()
    task = Task(name=TASK_NAME, algorithm="SM4", model=model_name,
                round_start=round_start, round_end=round_end)
    ctx = Ctx(cfg, task, get_cipher("SM4", cfg), KissatSolver(cfg.solver_path()))
    result = get_model(model_name)().run_search(ctx)
    return result, task


def read_csv_rows(task, model_name):
    """读 record CSV → [(round, prob, msv, lsv, result)]（仅实际求解的记录）。"""
    import csv
    path = os.path.join(task.model_dir, "results.csv")
    if not os.path.exists(path):
        return []
    rows = []
    with open(path) as f:
        for row in csv.DictReader(f):
            rows.append((int(row["round"]), int(row["prob"]),
                         None if row["msv"] == "" else int(row["msv"]),
                         None if row["lsv"] == "" else int(row["lsv"]),
                         row["result"]))
    return rows


# =============================================================================
# 单元比对
# =============================================================================

def unit_mdw_refresh():
    ref = load_reference(os.path.join(REF_SM4, "SM4_HPD_Auto_Search_MDW.py"))
    sys.path.insert(0, PROJECT_ROOT)
    from models.mdw import refresh_probability_bound

    cases = [(0, 0, 0, 1), (12, 0, 0, 1), (14, 0, 0, 1), (30, 0, 0, 1),
             (31, 0, 0, 1), (12, 0, 2, 0), (12, 2, 1, 0), (13, 1, 2, 0),
             (0, 0, 0, 0), (6, 0, 1, 0), (7, 1, 1, 0)]
    ok = True
    for args in cases:
        got = refresh_probability_bound(*args)
        want = ref.refresh_probability_bound(*args)
        ok &= got == want
        if got != want:
            print(f"  refresh_probability_bound{args}: bca={got} ref={want}")
    check("MDW refresh_probability_bound", ok, f"{len(cases)} cases")


def unit_weight_bound():
    """map.compute_weight_bound vs ref_MDW；as_model.compute_weight_bound vs ref_AS。"""
    sys.path.insert(0, PROJECT_ROOT)

    ref_mdw = load_reference(os.path.join(REF_SM4, "SM4_HPD_Auto_Search_MDW.py"))
    from models.map import compute_weight_bound as map_wb
    # ref_MDW compute_weight_bound(obj_idx, round_count, probability_bound, block_size, maximize)
    pb = [0, 0, 0, 6, 6, 12]
    ok = True
    for maximize in (False, True):
        for obj in (0, 1, 4, 7, 11):
            got = map_wb(obj, 3, pb, 4, maximize=maximize)
            want = ref_mdw.compute_weight_bound(obj, 3, pb, 4, maximize=maximize)
            ok &= got == want
            if got != want:
                print(f"  map.wb obj={obj} max={maximize}: bca={got} ref={want}")
    check("MAP/MDW compute_weight_bound", ok)

    ref_as = load_reference(os.path.join(REF_SM4, "SM4_HPD_Auto_Search_AS.py"))
    from models.as_model import compute_weight_bound as as_wb
    ab = [0, 0, 0, 0]
    p_bound = [0] * 5
    ok = True
    for is_q in (True, False):
        for maximize in (False, True):
            for obj in (0, 1, 4, 7, 11):
                got = as_wb(obj, 3, ab, 4, is_q, p_bound, maximize=maximize)
                want = ref_as.compute_weight_bound(obj, 3, ab, 4, is_q, maximize=maximize)
                ok &= got == want
                if got != want:
                    print(f"  as.wb obj={obj} is_q={is_q} max={maximize}: bca={got} ref={want}")
    check("AS compute_weight_bound", ok)


def unit_matsui_bound():
    """compute_double_matsui_bound vs ref_MDW（构造全局数组场景）。"""
    sys.path.insert(0, PROJECT_ROOT)
    ref = load_reference(os.path.join(REF_SM4, "SM4_HPD_Auto_Search_MDW.py"))
    from models.mdw import compute_double_matsui_bound, refresh_probability_bound

    # 场景：PWB[1]=0（SM4 参考实际），PWB[2]=6, PWB[3]=6
    ref.ProbWeightBound = [0] * 5
    ref.pBound = [0] * 5
    ref.qBound = [0] * 5
    ref.ProbWeightBound[2] = 6
    ref.pBound[2], ref.qBound[2] = 0, 1
    ref.ProbWeightBound[3] = 6
    ref.pBound[3], ref.qBound[3] = 0, 1
    ref.ImpossibleBound = []

    prob = [0, 0, 6, 6, 0]
    p = [0, 0, 0, 0, 0]
    q = [0, 0, 1, 1, 0]
    got = compute_double_matsui_bound(4, prob, p, q, [])
    want = ref.compute_double_matsui_bound(4)
    check("MDW compute_double_matsui_bound", got == want,
          f"p={got[0]} q={got[1]} vs ref p={want[0]} q={want[1]}")

    # ImpossibleBound 跳过场景：把 (6,0,1) 标记 impossible → p/q 界不应取到 1
    ref.ProbWeightBound = [0] * 5
    ref.pBound = [0] * 5
    ref.qBound = [0] * 5
    ref.ProbWeightBound[2] = 6
    ref.pBound[2], ref.qBound[2] = 0, 1
    ref.ProbWeightBound[3] = 6
    ref.pBound[3], ref.qBound[3] = 0, 1
    ref.ImpossibleBound = [[6, 0, 1]]
    prob = [0, 0, 6, 6, 0]
    p = [0, 0, 0, 0, 0]
    q = [0, 0, 1, 1, 0]
    got = compute_double_matsui_bound(4, prob, p, q, [(6, 0, 1)])
    want = ref.compute_double_matsui_bound(4)
    check("MDW matsui impossible-skip", got == want,
          f"p={got[0]} q={got[1]} vs ref p={want[0]} q={want[1]}")


# =============================================================================
# 行为对照（打补丁驱动参考主循环）
# =============================================================================

# 每个模型：参考文件、最终界数组名、参考 KNOWN_ACTIVE（None = 无剪枝）、
# 验证轮次（小轮，运行时间可控）
BEHAVIOR_CASES = {
    "MDW": dict(ref_file="SM4_HPD_Auto_Search_MDW.py", array="ProbWeightBound",
                known_active=None, rounds=(1, 3)),
    "AS": dict(ref_file="SM4_HPD_Auto_Search_AS.py", array="ActiveSBoxBound",
               known_active=None, rounds=(1, 3)),
}


def behavior_model(model_name):
    sys.path.insert(0, PROJECT_ROOT)
    from bca.config import load_config

    case = BEHAVIOR_CASES[model_name]
    rs, re = case["rounds"]
    cfg = load_config()
    solver_path = cfg.solver_path()

    # --- 参考侧：临时 cwd 驱动主循环 ---
    ref = load_reference(os.path.join(REF_SM4, case["ref_file"]))
    known_active = getattr(ref, case["known_active"]) if case["known_active"] else None
    solves = make_driver(ref, solver_path, case["array"], known_active)
    drive_reference(ref, solver_path, rs, re)
    ref_array = list(getattr(ref, case["array"])[rs:re + 1])

    # --- BCA 侧：真实 run_search ---
    if os.path.exists(RESULTS_DIR):
        shutil.rmtree(RESULTS_DIR)
    result, task = bca_run(model_name, rs, re)
    bca_array = result["prob_weight_bound"]
    rows = read_csv_rows(task, model_name)

    # 参考求解日志与 BCA 记录（round, prob, result）对照
    ref_solves = [(r, p, res) for (r, p, _, _, res) in solves]
    bca_solves = [(r, p, res) for (r, p, _, _, res) in rows]
    ok = True
    if ref_solves != bca_solves:
        ok = False
        print(f"  solve 序列不一致:")
        print(f"    ref: {ref_solves}")
        print(f"    bca: {bca_solves}")

    check(f"{model_name} 行为对照：最终界数组", ref_array == bca_array,
          f"ref={ref_array} bca={bca_array}")
    check(f"{model_name} 行为对照：求解记录序列", ok, f"ref {len(ref_solves)} 条 / bca {len(bca_solves)} 条")

    # 断点恢复：重跑同任务，CSV 行数不变（全部命中记录，不新增求解）
    result2, _ = bca_run(model_name, rs, re)
    rows2 = read_csv_rows(task, model_name)
    check(f"{model_name} 断点恢复", len(rows2) == len(rows) and result2["prob_weight_bound"] == bca_array,
          f"重跑后仍 {len(rows2)} 条记录")

    shutil.rmtree(RESULTS_DIR, ignore_errors=True)


# =============================================================================
# 入口
# =============================================================================

def main():
    parser = argparse.ArgumentParser(description="Phase 3 验证：MDW/AS vs 参考")
    parser.add_argument("--model", default=None, choices=["MDW", "AS"],
                        help="只跑指定模型（默认全部）")
    args = parser.parse_args()

    sys.path.insert(0, PROJECT_ROOT)

    if args.model in (None, "MDW"):
        print("\n===== 单元比对 =====")
        unit_mdw_refresh()
        unit_weight_bound()
        unit_matsui_bound()

    print("\n===== 行为对照 =====")
    models = [args.model] if args.model else ["MDW", "AS"]
    for m in models:
        print(f"\n----- {m} -----")
        behavior_model(m)

    print("\nALL PASS" if ALL_PASS else "\nSOME FAILED")
    sys.exit(0 if ALL_PASS else 1)


if __name__ == "__main__":
    main()
