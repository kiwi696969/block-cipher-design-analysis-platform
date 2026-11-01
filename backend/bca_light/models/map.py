"""
MAP 模型：主循环移植自 SM4_HPD_Auto_Search_MAP.py。

与 p/q 体系模型（DW/MDW/RS/AS）的关键差异：
- 变量体系 w7：每 S-box 7 个权重变量 w[0..6]（w[0]⟺p、w[1..6]⟺q 等值约束），
  序列编码作用于拍平的 w 变量（每轮 SBOX_COUNT×7 个）
- 概率界为单数组 prob_bound（无 p/q 双界）；PW[r] = PW[r-1] + PW[1]，
  失败（UNSAT 或 MILP infeasible）则 +1
- compute_weight_bound 无 is_q：任意连续段和 ≥ PW[段长]，且 ≤ 剩余界
- 无 refresh、无 known_active 参与；SAT 求解无 msv/lsv（记录时传 None）

参考里 PW[1] 从未 seed（模块级 init_global_state 全 0，主循环开头不赋值）→
PW[1] 恒为 0，PW[r] = PW[r-1] + 0 = 0，概率界只能靠失败 +1 增长。BCA 照搬
此行为（逐字节移植目标：与参考结果一致），不做修正。
"""

import time
from contextlib import redirect_stderr, redirect_stdout
from functools import partial

from gurobipy import GRB, LinExpr, Model

from bca.consts import INFEASIBLE, RESULT_SATISFIABLE, RESULT_UNSATISFIABLE
from bca.engine import generate_cnf_file_w7, solve_sat_and_record
from bca.solver import make_pool
from models.base import ModelBase


def compute_weight_bound(obj_idx, round_count, prob_bound, block_size, maximize=False,
                         return_stats=False):
    """
    用整数规划计算单个权重变量的下/上界（MAP 变体，无 is_q）。

    Args:
        obj_idx: 目标变量索引（w_flat 中的下标）
        round_count: 轮数
        prob_bound: 概率界数组（长 FULL_ROUNDS+1）
        block_size: 每轮权重变量数（SBOX_COUNT×7）
        maximize: True 上界，False 下界
        return_stats: True 时返回 (界值, stats dict)（调试/统计用）；
            False（默认）只返回界值（verify_phase3 等调用点不变）

    Returns:
        int 界值，或 INFEASIBLE（MILP 无可行解）；return_stats=True 时返回
        (界值, stats)
    """
    # Gurobi 创建 Model 时向 stdout 打印 LicenseID/版本号（LogToConsole 拦不住），
    # 重定向到 None 屏蔽；LogToConsole=0 必须也在块内设置（旧版 gurobipy 每次
    # setParam 回显 "Set parameter ..."，放块外会漏刷），同时抑制 optimize() 进度日志。
    with redirect_stdout(None), redirect_stderr(None):
        model = Model()
        model.Params.LogToConsole = 0

    # 二元变量矩阵：round_count × block_size
    w_variables = []
    for r in range(round_count):
        w_variables.append([])
        for j in range(block_size):
            w_variables[r].append(model.addVar(vtype=GRB.BINARY))

    # 约束 1：任意连续段权重和 ≥ 对应概率界
    for e1 in range(round_count):
        for e2 in range(e1, round_count):
            constraint = LinExpr()
            for i in range(e1, e2 + 1):
                for j in range(block_size):
                    constraint += w_variables[i][j]
            model.addConstr(constraint >= prob_bound[e2 - e1 + 1])

    # 约束 2：任意连续段权重和 ≤ 剩余概率界
    for e1 in range(round_count):
        for e2 in range(e1, round_count):
            constraint = LinExpr()
            for i in range(e1, e2 + 1):
                for j in range(block_size):
                    constraint += w_variables[i][j]
            model.addConstr(constraint <= (prob_bound[round_count] -
                                           prob_bound[e1] -
                                           prob_bound[round_count - 1 - e2]))

    # 目标：最小/最大化前 obj_idx+1 个变量的和
    w_flat = []
    for var in w_variables:
        w_flat.extend(var)

    obj_constraint = LinExpr()
    for i in range(obj_idx + 1):
        obj_constraint += w_flat[i]

    if maximize:
        model.setObjective(obj_constraint, GRB.MAXIMIZE)
    else:
        model.setObjective(obj_constraint, GRB.MINIMIZE)

    start_time = time.perf_counter()
    model.optimize()
    elapsed = time.perf_counter() - start_time

    if model.Status == 2:  # OPTIMAL
        value = round(model.ObjVal)
    else:
        value = INFEASIBLE

    if return_stats:
        stats = {
            "round": round_count,
            "prob": prob_bound[round_count],
            "p": "",
            "q": "",
            "obj_idx": obj_idx,
            "maximize": maximize,
            "is_q": "",
            "status": "OPTIMAL" if model.Status == 2 else "INFEASIBLE",
            "obj_val": value if model.Status == 2 else "",
            "solve_time": elapsed,
            "milp_vars": model.NumVars,
            "milp_constrs": model.NumConstrs,
        }
        return value, stats
    return value


class MAPModel(ModelBase):
    """MAP 模型：w7 体系单界数组主循环（无 refresh、无 known_active）。"""

    name = "MAP"

    def run_search(self, ctx):
        cipher = ctx.cipher
        task = ctx.task
        block_weight_size = cipher.total_weight_vars_per_round()  # SBOX_COUNT × 7
        workers = ctx.cfg.milp_workers()
        rc_start, rc_end = task.round_start, task.round_end

        # 单界数组（等价参考的 ProbWeightBound，显式化）
        prob_bound = [0] * (cipher.FULL_ROUNDS + 1)

        total_var = 0
        total_clause = 0
        total_time = 0.0
        round_summaries = []

        for round_count in range(rc_start, rc_end + 1):
            count_var = 0
            count_clause = 0
            count_time = 0.0
            result = RESULT_UNSATISFIABLE

            # PW[r] = PW[r-1] + PW[1]（参考行为：PW[1] 恒 0，见文件头注释）
            prob_bound[round_count] = prob_bound[round_count - 1] + prob_bound[1]

            while result == RESULT_UNSATISFIABLE:
                # 并行计算全部权重变量下/上界（Pool.map + partial，同参考）
                indices = list(range(round_count * block_weight_size))
                pool = make_pool(workers)
                try:
                    lower_bounds = pool.map(
                        partial(compute_weight_bound, round_count=round_count,
                                prob_bound=prob_bound, block_size=block_weight_size,
                                maximize=False),
                        indices)
                    upper_bounds = pool.map(
                        partial(compute_weight_bound, round_count=round_count,
                                prob_bound=prob_bound, block_size=block_weight_size,
                                maximize=True),
                        indices)
                finally:
                    pool.close()
                    pool.join()

                # MILP 无可行解：概率界 +1 后重试
                if INFEASIBLE in lower_bounds or INFEASIBLE in upper_bounds:
                    prob_bound[round_count] += 1
                    continue

                outcome = solve_sat_and_record(
                    ctx, round_count, prob_bound[round_count], None, None,
                    lambda: generate_cnf_file_w7(ctx, round_count, lower_bounds,
                                                 upper_bounds, prob_bound[round_count]),
                    bounds={"lower": lower_bounds, "upper": upper_bounds})
                result = outcome.result
                count_var += outcome.var_count
                count_clause += outcome.clause_count
                count_time += outcome.solve_time

                if result == RESULT_SATISFIABLE:
                    break

                # UNSAT：概率界 +1，继续
                prob_bound[round_count] += 1

            total_var += count_var
            total_clause += count_clause
            total_time += count_time

            summary = {
                "round": round_count,
                "prob": prob_bound[round_count],
                "result": result,
                "solve_time": count_time,
                "var_count": count_var,
                "clause_count": count_clause,
            }
            round_summaries.append(summary)
            print(f"Round {round_count:>2}: Prob={prob_bound[round_count]:>4} "
                  f"{result:<12} solve={count_time:8.2f}s "
                  f"vars={count_var} clauses={count_clause}")

        return {
            "prob_weight_bound": [prob_bound[i] for i in range(rc_start, rc_end + 1)],
            "total_solve_time": total_time,
            "total_var": total_var,
            "total_clause": total_clause,
            "rounds": round_summaries,
        }
