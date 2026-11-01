"""
MDW 模型：主循环移植自 SM4_HPD_Auto_Search_MDW.py。

与 DW 的关键差异：
- compute_weight_bound 为 matsui 变体（无 is_q、无 ×7/×6 乘子、无 p/q 总量
  约束），与 MAP 的完全相同 → 复用 models.map.compute_weight_bound
- 每轮先算 dual Matsui 界（compute_double_matsui_bound）：对前 r-1 轮各自的
  概率界，枚举其全体 (p, q) 组合，跳过 ImpossibleBound 中的组合，取最小 p/q
- refresh_probability_bound（MDW 变体）：init 取最小 b（p 最小）、update 取
  更大 b，同 prob 无解则 prob+1 —— 与 DW/RS 的方向相反
- ImpossibleBound：记录 MILP 无可行解 / UNSAT 的 (prob, p, q) 组合，后续跳过
- 参考里 ProbWeightBound/pBound/qBound 是模块级全局数组，这里显式传参
  （模型无全局状态，可多模型/多任务并存）

参考里 PW[1] 从未 seed（模块级 init 全 0，主循环开头不赋值）→ PW[1] 恒为 0，
PW[r] = PW[r-1] + 0 = 0，概率界只能靠失败后 refresh 增长。BCA 照搬此行为
（逐字节移植目标：与参考结果一致），不做修正。
"""

from contextlib import redirect_stderr, redirect_stdout
from functools import partial

from gurobipy import GRB, LinExpr, Model

from bca.consts import INFEASIBLE, RESULT_SATISFIABLE, RESULT_UNSATISFIABLE
from bca.engine import generate_cnf_file, solve_sat_and_record
from bca.solver import make_pool
from models.base import ModelBase
from models.map import compute_weight_bound


def refresh_probability_bound(prob_bound, p_curr, q_curr, first_refresh=0):
    """
    更新概率边界值（MDW 变体，移植参考 refresh_probability_bound）。

    概率界 = 6a + 7b，其中 p = b（weight-7 S-box 数），q = a + b（活跃总数）。
    init 取最小 b；update 在相同 prob 下取更大的 b，耗尽则 prob+1 取最小 b。
    （与 DW/RS 的 refresh 方向相反：DW/RS 从最大 b 起、b 递减）

    Returns:
        更新后的 (prob_bound, p_bound, q_bound) 三元组
    """
    if first_refresh == 1:
        # 初始化模式：prob 0 特判，>=30 快速路径（最小 b = prob%6），否则找最小 b
        if prob_bound == 0:
            return 0, 0, 0

        if prob_bound >= 30:
            b_val = prob_bound % 6
            a_plus_b = (prob_bound - b_val) // 6
            return prob_bound, b_val, a_plus_b

        min_b = None
        for b in range(0, prob_bound // 7 + 1):
            remainder = prob_bound - 7 * b
            if remainder >= 0 and remainder % 6 == 0:
                min_b = b
                break

        if min_b is not None:
            q_bound_val = (prob_bound - min_b) // 6
            return prob_bound, min_b, q_bound_val
        else:
            raise ValueError(f"Cannot initialize: {prob_bound} cannot be represented as 6a+7b")

    # 更新模式：相同 prob 下取更大 b
    current_b = p_curr
    max_b = prob_bound // 7

    next_b = None
    for b in range(current_b + 1, max_b + 1):
        diff = prob_bound - b
        if diff >= 0 and diff % 6 == 0:
            next_b = b
            break

    if next_b is not None:
        q_bound_next = (prob_bound - next_b) // 6
        return prob_bound, next_b, q_bound_next

    # 相同 prob 已无更大 b：prob+1 找最小表示
    new_prob = prob_bound + 1
    while True:
        if new_prob >= 30:
            b_val = new_prob % 6
            q_bound_val = (new_prob - b_val) // 6
            return new_prob, b_val, q_bound_val

        for b in range(0, new_prob // 7 + 1):
            remainder = new_prob - 7 * b
            if remainder >= 0 and remainder % 6 == 0:
                q_bound_val = (new_prob - b) // 6
                return new_prob, b, q_bound_val

        new_prob += 1


def compute_double_matsui_bound(round_count, prob_bound, p_bound, q_bound, impossible):
    """
    计算 p/q 的 dual Matsui 界（移植参考 compute_double_matsui_bound）。

    对每个前轮 r（1..round_count-1），枚举 ProbWeightBound[r] 的全体 (p, q)
    组合（refresh 链），跳过 ImpossibleBound 中的组合，取最小的 p/q 作为
    该轮界。MILP 建模用该数组作概率界。

    Args:
        round_count: 轮数
        prob_bound / p_bound / q_bound: 全局界数组（前 round_count 项已定）
        impossible: ImpossibleBound 列表（(prob, p, q) 元组）

    Returns:
        (p_matsui_bound, q_matsui_bound)，各长 round_count+1
    """
    p_matsui_bound = [p_bound[i] for i in range(round_count + 1)]
    q_matsui_bound = [q_bound[i] for i in range(round_count + 1)]

    for r in range(1, round_count):
        prob = prob_bound[r]
        prob, p_b, q_b = refresh_probability_bound(prob, 0, 0, 1)
        while prob == prob_bound[r]:
            if (prob, p_b, q_b) not in impossible:
                p_matsui_bound[r] = min(p_matsui_bound[r], p_b)
                q_matsui_bound[r] = min(q_matsui_bound[r], q_b)
            prob, p_b, q_b = refresh_probability_bound(prob, p_b, q_b)

    return p_matsui_bound, q_matsui_bound


class MDWModel(ModelBase):
    """MDW 模型：matsui 双界 + ImpossibleBound 主循环（参考 MDW 文件）。"""

    name = "MDW"

    def run_search(self, ctx):
        cipher = ctx.cipher
        task = ctx.task
        rc_start, rc_end = task.round_start, task.round_end
        half_block = cipher.HALF_BLOCK_WEIGHT_SIZE
        workers = ctx.cfg.milp_workers()

        # 全局界数组（等价参考的 ProbWeightBound/pBound/qBound，显式化）
        prob_bound = [0] * (cipher.FULL_ROUNDS + 1)
        p_bound = [0] * (cipher.FULL_ROUNDS + 1)
        q_bound = [0] * (cipher.FULL_ROUNDS + 1)
        impossible = []  # (prob, p, q) 元组，跨轮累积

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
            (prob_bound[round_count], p_bound[round_count], q_bound[round_count]) = \
                refresh_probability_bound(prob_bound[round_count], p_bound[round_count],
                                          q_bound[round_count], 1)

            while result == RESULT_UNSATISFIABLE:
                (p_matsui_bound, q_matsui_bound) = compute_double_matsui_bound(
                    round_count, prob_bound, p_bound, q_bound, impossible)

                # 并行计算全部 p/q 变量下/上界（Pool.map + partial，同参考）
                indices = list(range(round_count * half_block))
                pool = make_pool(workers)
                try:
                    p_lower = pool.map(
                        partial(compute_weight_bound, round_count=round_count,
                                prob_bound=p_matsui_bound, block_size=half_block,
                                maximize=False),
                        indices)
                    p_upper = pool.map(
                        partial(compute_weight_bound, round_count=round_count,
                                prob_bound=p_matsui_bound, block_size=half_block,
                                maximize=True),
                        indices)
                    q_lower = pool.map(
                        partial(compute_weight_bound, round_count=round_count,
                                prob_bound=q_matsui_bound, block_size=half_block,
                                maximize=False),
                        indices)
                    q_upper = pool.map(
                        partial(compute_weight_bound, round_count=round_count,
                                prob_bound=q_matsui_bound, block_size=half_block,
                                maximize=True),
                        indices)
                finally:
                    pool.close()
                    pool.join()

                # MILP 无可行解：记录不可行组合，refresh 后重试
                if (INFEASIBLE in p_lower or INFEASIBLE in p_upper or
                        INFEASIBLE in q_lower or INFEASIBLE in q_upper):
                    impossible.append((prob_bound[round_count],
                                       p_bound[round_count], q_bound[round_count]))
                    (prob_bound[round_count], p_bound[round_count], q_bound[round_count]) = \
                        refresh_probability_bound(prob_bound[round_count],
                                                  p_bound[round_count], q_bound[round_count])
                    continue

                outcome = solve_sat_and_record(
                    ctx, round_count, prob_bound[round_count],
                    p_bound[round_count], q_bound[round_count],
                    lambda: generate_cnf_file(ctx, round_count, p_lower, p_upper,
                                              q_lower, q_upper, prob_bound[round_count]),
                    bounds={"p_lower": p_lower, "p_upper": p_upper,
                            "q_lower": q_lower, "q_upper": q_upper})
                result = outcome.result
                count_var += outcome.var_count
                count_clause += outcome.clause_count
                count_time += outcome.solve_time

                if result == RESULT_SATISFIABLE:
                    break

                # UNSAT：记录不可行组合，refresh 后继续
                impossible.append((prob_bound[round_count],
                                   p_bound[round_count], q_bound[round_count]))
                (prob_bound[round_count], p_bound[round_count], q_bound[round_count]) = \
                    refresh_probability_bound(prob_bound[round_count],
                                              p_bound[round_count], q_bound[round_count])

            total_var += count_var
            total_clause += count_clause
            total_time += count_time

            summary = {
                "round": round_count,
                "prob": prob_bound[round_count],
                "p": p_bound[round_count],
                "q": q_bound[round_count],
                "result": result,
                "solve_time": count_time,
                "var_count": count_var,
                "clause_count": count_clause,
            }
            round_summaries.append(summary)
            print(f"Round {round_count:>2}: Prob={prob_bound[round_count]:>4} "
                  f"p={p_bound[round_count]} q={q_bound[round_count]} {result:<12} "
                  f"solve={count_time:8.2f}s vars={count_var} clauses={count_clause}")

        return {
            "prob_weight_bound": [prob_bound[i] for i in range(rc_start, rc_end + 1)],
            "p_bound": [p_bound[i] for i in range(rc_start, rc_end + 1)],
            "q_bound": [q_bound[i] for i in range(rc_start, rc_end + 1)],
            "total_solve_time": total_time,
            "total_var": total_var,
            "total_clause": total_clause,
            "rounds": round_summaries,
        }
