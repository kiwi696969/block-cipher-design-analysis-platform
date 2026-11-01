"""
AS 模型：活跃 S-box 搜索主循环移植自 SM4_HPD_Auto_Search_AS.py。

与 DW 的关键差异：
- 只搜 ActiveSBoxBound（活跃 S-box 界）：失败（MILP 无可行解或 UNSAT）则
  ActiveSBoxBound[round] += 1，无 refresh；p/q 界数组全程不写（恒 0）
- compute_weight_bound：q 分支无 ×7/×6 乘子（参考注释掉了）且无总量约束；
  p 分支保留 ×7 与 pBound 总量（pBound 恒 0 → p 界全压成 0）
- CNF 不写 p 序列编码（参考 generate_cnf_file 里 p 编码被注释掉，p 变量仅受
  sbox 约束）→ engine.generate_cnf_file(include_p_encoding=False)
- MILP 无可行解只检查 q（参考行为；p 分支有总量约束不会不可行）
- 记录不写 msv/lsv（p/q 界无意义，参考只记录 ActiveSBoxBound）

参考里 ActiveSBoxBound[1] 从未 seed（恒 0）→ ASB[r] = ASB[r-1] + 0 = 0，
SM4 各轮从 0 起搜、全零路径直接 SAT。BCA 照搬此行为（与 MAP/MDW 同类怪癖，
espresso 粗粒度模型允许 weight-0 差分），不做修正。
"""

import time
from contextlib import redirect_stderr, redirect_stdout
from functools import partial

from gurobipy import GRB, LinExpr, Model

from bca.consts import INFEASIBLE, RESULT_SATISFIABLE, RESULT_UNSATISFIABLE
from bca.engine import generate_cnf_file, solve_sat_and_record
from bca.solver import make_pool
from models.base import ModelBase


def compute_weight_bound(obj_idx, round_count, prob_bound, block_size, is_q, p_bound,
                         maximize=False, return_stats=False):
    """
    用整数规划计算单个权重变量的下/上界（AS 变体，移植参考 compute_weight_bound）。

    q 分支：任意连续段 ≥ / ≤ 对应概率界，无乘子、无总量约束。
    p 分支：任意连续段 ×7 ≤ 剩余界，总量固定 = pBound[round_count]（参考恒 0）。

    Args:
        obj_idx: 目标变量索引（w_flat 中的下标，即 r*block_size + j）
        round_count: 轮数
        prob_bound: ActiveSBoxBound 概率界数组
        block_size: 每轮权重变量数
        is_q: True 求 q 变量界，False 求 p 变量界
        p_bound: p 界数组（取 p_bound[round_count] 作总量约束）
        maximize: True 上界，False 下界
        return_stats: True 时返回 (界值, stats dict)（调试/统计用）；
            False（默认）只返回界值

    Returns:
        int 界值，或 INFEASIBLE（MILP 无可行解）；return_stats=True 时返回
        (界值, stats)
    """
    with redirect_stdout(None), redirect_stderr(None):
        model = Model()
        # LogToConsole=0 必须在屏蔽块内设置：旧版 gurobipy 每次 setParam 都向
        # stdout 回显 "Set parameter ..."，放块外会漏刷（本机 11.x 不回显）。
        model.Params.LogToConsole = 0

    # 二元变量矩阵：round_count × block_size
    w_variables = []
    for r in range(round_count):
        w_variables.append([])
        for j in range(block_size):
            w_variables[r].append(model.addVar(vtype=GRB.BINARY))

    if is_q:
        # q 变量约束（无乘子）
        for e1 in range(round_count):
            for e2 in range(e1, round_count):
                constraint = LinExpr()
                for i in range(e1, e2 + 1):
                    for j in range(block_size):
                        constraint += w_variables[i][j]
                model.addConstr(constraint >= prob_bound[e2 - e1 + 1])

        for e1 in range(round_count):
            for e2 in range(e1, round_count):
                constraint = LinExpr()
                for i in range(e1, e2 + 1):
                    for j in range(block_size):
                        constraint += w_variables[i][j]
                model.addConstr(constraint <= (prob_bound[round_count] -
                                               prob_bound[e1] -
                                               prob_bound[round_count - 1 - e2]))
    else:
        # p 变量约束（保留 ×7）+ 总量固定
        for e1 in range(round_count):
            for e2 in range(e1, round_count):
                constraint = LinExpr()
                for i in range(e1, e2 + 1):
                    for j in range(block_size):
                        constraint += w_variables[i][j]
                model.addConstr(constraint * 7 <= (prob_bound[round_count] -
                                                   prob_bound[e1] -
                                                   prob_bound[round_count - 1 - e2]))

        constraint = LinExpr()
        for r in range(round_count):
            for j in range(block_size):
                constraint += w_variables[r][j]
        model.addConstr(constraint >= p_bound[round_count])
        model.addConstr(constraint <= p_bound[round_count])

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
        # q 分支无 p_bound 参数，prob_bound 即 ActiveSBoxBound（q 语义）
        stats = {
            "round": round_count,
            "prob": prob_bound[round_count],
            "p": p_bound[round_count] if not is_q else "",
            "q": prob_bound[round_count] if is_q else "",
            "obj_idx": obj_idx,
            "maximize": maximize,
            "is_q": "q" if is_q else "p",
            "status": "OPTIMAL" if model.Status == 2 else "INFEASIBLE",
            "obj_val": value if model.Status == 2 else "",
            "solve_time": elapsed,
            "milp_vars": model.NumVars,
            "milp_constrs": model.NumConstrs,
        }
        return value, stats
    return value


def compute_double_bounds(round_count, half_block_size, prob_bound, p_bound,
                          weight_count, workers=None):
    """
    并行计算全部 p/q 变量的下/上界（AS 变体，Pool.map + partial）。

    Args:
        round_count: 轮数
        half_block_size: 每轮权重变量数（MILP 建模用，SM4 = 4）
        prob_bound: ActiveSBoxBound 界数组
        p_bound: p 界数组（AS 恒 0）
        weight_count: 每轮权重变量总数（索引列表长度，参考用 SBOX_COUNT）
        workers: MILP 并行进程数，None 用默认（os.cpu_count）

    Returns:
        (p_lower, p_upper, q_lower, q_upper) 四元组，各为等长列表
        （元素为 int 或 INFEASIBLE）。逐次求解细节不记录（见 dw.compute_double_bounds）
    """
    indices = list(range(round_count * weight_count))

    pool = make_pool(workers)
    try:
        p_lower = pool.map(
            partial(compute_weight_bound, round_count=round_count, prob_bound=prob_bound,
                    block_size=half_block_size, is_q=False, maximize=False,
                    p_bound=p_bound),
            indices)
        p_upper = pool.map(
            partial(compute_weight_bound, round_count=round_count, prob_bound=prob_bound,
                    block_size=half_block_size, is_q=False, maximize=True,
                    p_bound=p_bound),
            indices)
        q_lower = pool.map(
            partial(compute_weight_bound, round_count=round_count, prob_bound=prob_bound,
                    block_size=half_block_size, is_q=True, maximize=False,
                    p_bound=p_bound),
            indices)
        q_upper = pool.map(
            partial(compute_weight_bound, round_count=round_count, prob_bound=prob_bound,
                    block_size=half_block_size, is_q=True, maximize=True,
                    p_bound=p_bound),
            indices)
    finally:
        pool.close()
        pool.join()

    return p_lower, p_upper, q_lower, q_upper


class ASModel(ModelBase):
    """AS 模型：ActiveSBoxBound 递增主循环（无 refresh、无 p 序列编码）。"""

    name = "AS"

    def run_search(self, ctx):
        cipher = ctx.cipher
        task = ctx.task
        rc_start, rc_end = task.round_start, task.round_end
        half_block = cipher.HALF_BLOCK_WEIGHT_SIZE
        workers = ctx.cfg.milp_workers()

        # 全局界数组（等价参考的 ActiveSBoxBound/pBound/qBound，显式化）
        asb_bound = [0] * (cipher.FULL_ROUNDS + 1)
        p_bound = [0] * (cipher.FULL_ROUNDS + 1)   # 参考全程不写（恒 0）
        q_bound = [0] * (cipher.FULL_ROUNDS + 1)   # 参考全程不写（恒 0）

        total_var = 0
        total_clause = 0
        total_time = 0.0
        round_summaries = []

        for round_count in range(rc_start, rc_end + 1):
            count_var = 0
            count_clause = 0
            count_time = 0.0
            result = RESULT_UNSATISFIABLE

            # ASB[r] = ASB[r-1] + ASB[1]（参考行为：ASB[1] 恒 0，见文件头注释）
            asb_bound[round_count] = asb_bound[round_count - 1] + asb_bound[1]
            pb_now = asb_bound[round_count]
            count_var_now_pb = 0
            count_clause_now_pb = 0
            count_time_now_pb = 0.0

            while result == RESULT_UNSATISFIABLE:
                (p_lower, p_upper, q_lower, q_upper) = compute_double_bounds(
                    round_count, half_block, asb_bound, p_bound,
                    weight_count=cipher.SBOX_COUNT, workers=workers)

                # MILP 无可行解：ASB+1 后重试（参考只检查 q，p 有总量约束不会不可行）
                if INFEASIBLE in q_lower or INFEASIBLE in q_upper:
                    asb_bound[round_count] += 1
                    if pb_now == asb_bound[round_count]:
                        pass
                    else:
                        count_var += count_var_now_pb
                        count_clause += count_clause_now_pb
                        count_time += count_time_now_pb
                        pb_now = asb_bound[round_count]
                        count_var_now_pb = 0
                        count_clause_now_pb = 0
                        count_time_now_pb = 0.0
                    continue

                outcome = solve_sat_and_record(
                    ctx, round_count, asb_bound[round_count], None, None,
                    lambda: generate_cnf_file(ctx, round_count, p_lower, p_upper,
                                              q_lower, q_upper, asb_bound[round_count],
                                              include_p_encoding=False),
                    bounds={"p_lower": p_lower, "p_upper": p_upper,
                            "q_lower": q_lower, "q_upper": q_upper})
                result = outcome.result

                if result == RESULT_SATISFIABLE:
                    count_var += outcome.var_count
                    count_clause += outcome.clause_count
                    count_time += outcome.solve_time
                    break

                # UNSAT：ASB+1，继续
                asb_bound[round_count] += 1
                count_var_now_pb += outcome.var_count
                count_clause_now_pb += outcome.clause_count
                count_time_now_pb = max(count_time_now_pb, outcome.solve_time)
                if pb_now == asb_bound[round_count]:
                    pass
                else:
                    count_var += count_var_now_pb
                    count_clause += count_clause_now_pb
                    count_time += count_time_now_pb
                    pb_now = asb_bound[round_count]
                    count_var_now_pb = 0
                    count_clause_now_pb = 0
                    count_time_now_pb = 0.0

            total_var += count_var
            total_clause += count_clause
            total_time += count_time

            summary = {
                "round": round_count,
                "asb": asb_bound[round_count],
                "result": result,
                "solve_time": count_time,
                "var_count": count_var,
                "clause_count": count_clause,
            }
            round_summaries.append(summary)
            print(f"Round {round_count:>2}: ASB={asb_bound[round_count]:>4} "
                  f"{result:<12} solve={count_time:8.2f}s "
                  f"vars={count_var} clauses={count_clause}")

        return {
            "prob_weight_bound": [asb_bound[i] for i in range(rc_start, rc_end + 1)],
            "total_solve_time": total_time,
            "total_var": total_var,
            "total_clause": total_clause,
            "rounds": round_summaries,
        }
