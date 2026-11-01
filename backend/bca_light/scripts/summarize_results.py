"""
BCA 结果汇总统计：对齐各任务 results.csv，支撑不同模型/算法间的数据对比。

数据来源：results/{task}/{algorithm}/{model}/results.csv（Record 的 HEADER：
task, algorithm, model, attack, round, prob, msv, lsv, result, solve_time, ...）。

每轮"结果概率界"（bound）= 该轮最后一次 SAT 记录的 prob：
- DW/MAP/MDW/AS 前向搜索（prob 递增至 SAT）→ 即终止 SAT 的 prob，等于该轮
  ProbWeightBound/ASB；
- RS 反向搜索（prob 递减，每轮末 OptWeightBound = 最后一次 SAT 的 prob）→ 同样成立。
该轮无 SAT 记录（任务未跑完/全 UNSAT）显示 "-"。

用法：
    python scripts/summarize_results.py                     # 全部任务
    python scripts/summarize_results.py --task sm4-dw       # 只看某任务
    python scripts/summarize_results.py --algorithm SM4     # 只看某算法
    python scripts/summarize_results.py --compare           # 只输出跨模型对比表

输出两个视图：
1. 明细：逐任务 → 逐 (算法, 模型) → 逐轮表（bound/SAT数/UNSAT数/求解时间）+ 汇总
2. 对比：按算法对齐，模型@任务 为列、轮次为行，单元格 = 该轮结果概率界
"""

import argparse
import csv
import glob
import os

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RESULTS_ROOT = os.path.join(PROJECT_ROOT, "results")

SAT = "SATISFIABLE"
UNSAT = "UNSATISFIABLE"
# 并行模型（同一 prob 多格并行 + 首 SAT 杀其余格）：prob 时间语义与串行不同，
# 见 summarize_round 的 parallel 分支。串行模型永远不出现这两类行。
PENDING = "PENDING"
TERMINATED = "TERMINATED"
PARALLEL_MODELS = ("DWP", "RSP", "ROSP")


def collect_rows(results_root=RESULTS_ROOT):
    """扫描 results/ 下所有 results.csv，返回行 dict 列表。"""
    rows = []
    for path in sorted(glob.glob(os.path.join(results_root, "*", "*", "*", "results.csv"))):
        with open(path, newline="") as f:
            for row in csv.DictReader(f):
                rows.append(row)
    return rows


def group_by_model(rows):
    """按 (task, algorithm, model) 分组，保持组内 CSV 顺序（轮内即求解顺序）。"""
    groups = {}
    for row in rows:
        key = (row["task"], row["algorithm"], row["model"])
        groups.setdefault(key, []).append(row)
    return groups


def summarize_round(round_rows, parallel=False):
    """一轮的汇总：bound（最后一次 SAT 的 prob）、SAT/UNSAT/其他计数、总时间、
    受限（非物理全并行）的 prob 列表。

    parallel（DWP/RSP）时总时间按 prob 分组：被杀格（TERMINATED）与胜出 SAT 格
    并行同属一次墙钟、占位残留行（PENDING）无结果，两者都不逐行计入；每 prob
    取剩余行的最长时长（全 UNSAT prob = 最久完成格，有 SAT 的 prob = SAT 格
    ——SAT prob 内其余行只会是被杀格）。串行模型每 prob 至多一行、永无
    PENDING/TERMINATED，退化为逐行求和，与旧行为一致。

    limited：该轮 full_parallel=0 的行按 prob 聚成 [(prob, 格数)]——这些 prob 的
    格数超过了运行时并发上限（--sat-jobs），实际分波排队，不是物理全并行，
    SAT 首杀/全 UNSAT max 的时间口径失真，需要真实并行时间时放开 jobs 重跑。"""
    sat_rows = [r for r in round_rows if r["result"] == SAT]
    unsat_n = sum(1 for r in round_rows if r["result"] == UNSAT)
    other_n = len(round_rows) - len(sat_rows) - unsat_n
    bound = int(sat_rows[-1]["prob"]) if sat_rows else None
    if parallel:
        by_prob = {}
        for r in round_rows:
            by_prob.setdefault(r["prob"], []).append(r)
        total_time = 0.0
        for rows in by_prob.values():
            done = [float(r["solve_time"]) for r in rows
                    if r["result"] not in (PENDING, TERMINATED)]
            total_time += max(done) if done else 0.0
    else:
        total_time = sum(float(r["solve_time"]) for r in round_rows)
    n_by_prob = {}
    for r in round_rows:
        if r.get("full_parallel", "") == "0":
            n_by_prob[r["prob"]] = n_by_prob.get(r["prob"], 0) + 1
    limited = [(int(p), n) for p, n in sorted(n_by_prob.items())]
    return bound, len(sat_rows), unsat_n, other_n, total_time, limited


def summarize_model(rows, parallel=False):
    """一个 (task, algorithm, model) 的逐轮汇总（按 round 升序）。"""
    by_round = {}
    for row in rows:
        by_round.setdefault(int(row["round"]), []).append(row)
    rounds = []
    for r in sorted(by_round):
        bound, sat_n, unsat_n, other_n, total_time, limited = summarize_round(
            by_round[r], parallel)
        rounds.append((r, bound, sat_n, unsat_n, other_n, total_time, limited))
    return rounds


def fmt_bound(bound):
    return "-" if bound is None else str(bound)


def fmt_time(t):
    return f"{t:.1f}"


def print_detail(groups, only_task=None, only_alg=None):
    """视图 1：逐任务逐模型明细表。"""
    for (task, alg, model) in sorted(groups):
        if only_task and task != only_task:
            continue
        if only_alg and alg != only_alg:
            continue
        rows = groups[(task, alg, model)]
        rounds = summarize_model(rows, parallel=model in PARALLEL_MODELS)
        print(f"\n[task={task}] {alg} / {model}")
        print(f"  {'round':>5} {'bound':>5} {'SAT':>3} {'UNSAT':>5} {'其他':>4} {'时间(s)':>9}")
        tot_sat = tot_unsat = tot_other = 0
        tot_time = 0.0
        n_limited = 0
        for r, bound, sat_n, unsat_n, other_n, t, limited in rounds:
            print(f"  {r:>5} {fmt_bound(bound):>5} {sat_n:>3} {unsat_n:>5} {other_n:>4} {fmt_time(t):>9}")
            for p, n in limited:
                n_limited += 1
                print(f"       prob {p}: {n} 格受并发上限截断，非物理全并行"
                      f"（时间失真，需真实并行时间请放开 jobs 重跑）")
            tot_sat += sat_n
            tot_unsat += unsat_n
            tot_other += other_n
            tot_time += t
        print(f"  合计: {len(rounds)} 轮, {len(rows)} 条记录, "
              f"{tot_sat} SAT / {tot_unsat} UNSAT"
              + (f" / {tot_other} 其他" if tot_other else "")
              + (f", {n_limited} 个受限 prob（非物理全并行）" if n_limited else "")
              + f", 求解总时间 {fmt_time(tot_time)}s")


def print_compare(groups, only_task=None, only_alg=None):
    """视图 2：按算法对齐的跨模型对比表（单元格 = 该轮结果概率界）。"""
    by_alg = {}
    for (task, alg, model) in groups:
        if only_task and task != only_task:
            continue
        if only_alg and alg != only_alg:
            continue
        rounds = summarize_model(groups[(task, alg, model)],
                                 parallel=model in PARALLEL_MODELS)
        by_alg.setdefault(alg, []).append((task, model, rounds))

    if not by_alg:
        return

    for alg in sorted(by_alg):
        entries = by_alg[alg]
        all_rounds = sorted({r for _, _, rounds in entries for r, *_ in rounds})
        headers = [f"{model}@{task}" for task, model, _ in entries]
        width = max(10, max(len(h) for h in headers) + 2)
        print(f"\n===== 算法 {alg}: 跨模型对比（单元格 = 该轮结果概率界） =====")
        print(f"  {'round':>5} " + "".join(f"{h:>{width}}" for h in headers))
        for r in all_rounds:
            cells = []
            for _, _, rounds in entries:
                for rr, bound, *_ in rounds:
                    if rr == r:
                        cells.append(fmt_bound(bound))
                        break
                else:
                    cells.append("-")
            print(f"  {r:>5} " + "".join(f"{c:>{width}}" for c in cells))


def main():
    parser = argparse.ArgumentParser(description="BCA 结果汇总统计（对齐 results.csv）")
    parser.add_argument("--task", default=None, help="只统计指定任务名")
    parser.add_argument("--algorithm", default=None, help="只统计指定算法（如 SM4）")
    parser.add_argument("--compare", action="store_true",
                        help="只输出跨模型对比表（不输出逐模型明细）")
    args = parser.parse_args()

    rows = collect_rows()
    if not rows:
        print(f"results/ 下没有 results.csv（扫描 {RESULTS_ROOT}）")
        return
    groups = group_by_model(rows)

    if not args.compare:
        print_detail(groups, args.task, args.algorithm)
    print_compare(groups, args.task, args.algorithm)


if __name__ == "__main__":
    main()
