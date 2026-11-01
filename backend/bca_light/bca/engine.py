"""
搜索层共享原语（模型可调用也可绕过，模型全自由原则）：

- generate_cnf_file      pq 体系 CNF 生成（AS/DW/MDW/RS 共用）
- generate_cnf_file_w7   w7 体系 CNF 生成（MAP 用）
- solve_sat_and_record   标准"断点恢复→建 CNF→求解→记录"流程
- solve_sat_batch_and_record   DWP/RSP 用：同一 prob 多个格并行的
  "占位→求解→回填"流程（一个格解出就即时回填，顺序 = 占位顺序）

CNF 生成流程（与参考一致）：变量生成 → 轮函数约束 → 序列编码约束 → 写文件。
"""

import time
from dataclasses import dataclass, field
from typing import List, Optional

from .consts import (
    RESULT_ERROR,
    RESULT_NO_RESULT,
    RESULT_PENDING,
    RESULT_SATISFIABLE,
    RESULT_TERMINATED,
    RESULT_TIMEOUT,
)
from .util.cnf import CNFBuffer
from .util.path import extract_rounds, format_path
from .util.seq_encoding import generate_sequential_encoding_constraints


@dataclass
class SolveOutcome:
    """一次 SAT 求解（或断点恢复命中）的结果。"""
    result: str
    solve_time: float = 0.0
    var_count: int = 0
    clause_count: int = 0
    cnf_time: float = 0.0
    model: Optional[List[int]] = None      # SAT 解（带符号整数），None 时无
    resumed: bool = False                   # True = 命中记录，未实际求解


def _flatten_weight_vars(vars, key):
    """拍平权重变量：vars[key][r][i] → 一维列表（r 主序）。"""
    return [var for r in vars[key] for i in r for var in (i if isinstance(i, list) else [i])]


def _build_aux_structure(aux_u):
    """
    构建参考结构的辅助变量列表：按 (r,i) 顺序的辅助变量子列表。

    与参考 generate_variables 一致：每个 (r,i) 一个子列表（最后一个权重变量
    无 aux，varsys 中已不为其分配），序列编码按 u_vars[i][j] 索引。
    """
    return [lst for r in aux_u for lst in r]


def generate_cnf_file(ctx, round_count, p_lower, p_upper, q_lower, q_upper, prob_weight,
                      tag=None, include_p_encoding=True):
    """
    pq 体系 CNF 生成（AS/DW/MDW/RS 共用，逐字节对齐参考）。

    Args:
        ctx: Ctx
        round_count: 轮数
        p_lower/p_upper: p 变量下/上界数组
        q_lower/q_upper: q 变量下/上界数组
        prob_weight: 概率界（仅用于文件名）
        tag: 并行任务编号（文件名后缀）
        include_p_encoding: False 时跳过 p 序列编码（AS 模型，参考注释掉了
            p 编码——p 变量仅受 sbox 约束，无 p 界约束）

    Returns:
        (cnf_path, var_count, clause_count, cnf_time, pool, vars)
    """
    start = time.time()
    pool = ctx.new_pool()

    vars, var_count = ctx.cipher.generate_variables_pq(
        pool, round_count, p_lower, p_upper, q_lower, q_upper
    )

    p_weight_vars = _flatten_weight_vars(vars, "p")
    p_aux_vars = _build_aux_structure(vars["p_aux_u"])
    q_weight_vars = _flatten_weight_vars(vars, "q")
    q_aux_vars = _build_aux_structure(vars["q_aux_u"])

    buf = CNFBuffer()
    ctx.cipher.generate_round_function_constraints(vars, round_count, buf)
    if include_p_encoding:
        generate_sequential_encoding_constraints(p_weight_vars, p_aux_vars, p_lower, p_upper, buf)
    generate_sequential_encoding_constraints(q_weight_vars, q_aux_vars, q_lower, q_upper, buf)

    cnf_path = ctx.cnf_path(round_count, prob_weight, tag)
    buf.save(cnf_path, var_count)
    cnf_time = time.time() - start

    return cnf_path, var_count, buf.clause_count(), cnf_time, pool, vars


def generate_cnf_file_w7(ctx, round_count, lower_bound, upper_bound, prob_weight, tag=None):
    """
    w7 体系 CNF 生成（MAP 用，逐字节对齐参考）。

    Returns:
        (cnf_path, var_count, clause_count, cnf_time, pool, vars)
    """
    start = time.time()
    pool = ctx.new_pool()

    vars, var_count = ctx.cipher.generate_variables_w7(
        pool, round_count, lower_bound, upper_bound
    )

    # 拍平 w 权重变量：w[r][sbox][0..6]
    weight_vars = []
    for r in vars["w"]:
        for sbox in r:
            for wv in sbox:
                weight_vars.append(wv)
    aux_vars = _build_aux_structure(vars["aux_u"])

    buf = CNFBuffer()
    ctx.cipher.generate_round_function_constraints_w7(vars, round_count, buf)
    generate_sequential_encoding_constraints(weight_vars, aux_vars, lower_bound, upper_bound, buf)

    cnf_path = ctx.cnf_path(round_count, prob_weight, tag)
    buf.save(cnf_path, var_count)
    cnf_time = time.time() - start

    return cnf_path, var_count, buf.clause_count(), cnf_time, pool, vars


def _print_solve(ctx, round_num, prob, msv, lsv, result, solve_time,
                 var_count, clause_count, resumed=False):
    """每个 SAT 模型解完即打一行进度（原 DC-SAT 逐模型输出风格）。

    断点恢复命中（resumed）也打一行（不实际求解，标注 skipped），
    让用户看到任务进度而非长时间静默。"""
    p = "-" if msv is None else str(msv)
    q = "-" if lsv is None else str(lsv)
    note = "  (recorded, skip)" if resumed else ""
    print(f"  [{ctx.cipher.NAME}] R{round_num:>2} P{prob:>4} msv={p:>2} lsv={q:>2} "
          f"{result:<13} {solve_time:>8.2f}s vars={var_count:>6} "
          f"clauses={clause_count:>7}{note}")


def solve_sat_and_record(ctx, round_num, prob, msv, lsv, cnf_build, bounds=None, tag=None):
    """
    标准"断点恢复 → 建 CNF → 求解 → 记录"流程。

    Args:
        ctx: Ctx
        round_num: 轮数（记录字段）
        prob: 概率界（记录字段）
        msv: p 值 / MAP 传 None（记录字段，断点恢复键）
        lsv: q 值 / MAP 传 None
        cnf_build: 无参 callable → (cnf_path, var_count, clause_count, cnf_time, pool)
        bounds: 该 SAT 模型的界数组 dict（pq 体系 {"p_lower","p_upper",
            "q_lower","q_upper"} / MAP {"lower","upper"}），None 不记录；
            求解时经 ctx.bounds.add 集中写入模型目录下 bounds.json
        tag: 并行任务编号

    Returns:
        SolveOutcome。命中断点恢复时直接返回记录值（resumed=True）。
    """
    row = ctx.record.lookup(round_num, prob, msv, lsv)
    if row is not None:
        result = row["result"]
        solve_time = float(row["solve_time"])
        var_count = int(row["var_count"])
        clause_count = int(row["clause_count"])
        _print_solve(ctx, round_num, prob, msv, lsv, result, solve_time,
                     var_count, clause_count, resumed=True)
        return SolveOutcome(
            result=result,
            solve_time=solve_time,
            var_count=var_count,
            clause_count=clause_count,
            cnf_time=float(row["cnf_time"]),
            resumed=True,
        )

    cnf_path, var_count, clause_count, cnf_time, pool, vars = cnf_build()
    sol_path = ctx.sol_path(round_num, prob, tag)
    # 超时仅由任务显式指定（None = 不设超时，SAT 求解可跑数小时/天/月）
    result, solve_time, model = ctx.solver.solve(cnf_path, sol_path, timeout=ctx.task.solver_timeout)

    if bounds is not None:
        ctx.bounds.add(round_num, prob, msv, lsv, bounds)
    ctx.record.write(round_num, prob, msv, lsv, result, solve_time,
                     var_count, clause_count, cnf_time, ctx.solver.name)
    _print_solve(ctx, round_num, prob, msv, lsv, result, solve_time,
                 var_count, clause_count)
    ctx.cleanup(cnf_path, sol_path)

    # SAT 解 → 差分路径明细（details/path/），断点恢复命中（resumed）不重写
    if result == RESULT_SATISFIABLE and model:
        rounds, final_state = extract_rounds(model, vars, round_num, ctx.cipher)
        tag_suffix = f" (tag={tag})" if tag is not None else ""
        with open(ctx.path_path(round_num, prob, tag), "w") as f:
            f.write(f"# {ctx.cipher.NAME} R{round_num}-P{prob} SAT 差分路径{tag_suffix}\n")
            f.write(format_path(rounds, final_state))

    return SolveOutcome(result=result, solve_time=solve_time, var_count=var_count,
                        clause_count=clause_count, cnf_time=cnf_time, model=model)


def solve_sat_batch_and_record(ctx, round_num, prob, entries, jobs=None, timeout=None):
    """
    DWP/RSP：同一 prob 下多个 (p,q) 格并行的"占位-回填"批处理流程。

    Args:
        ctx: Ctx
        round_num / prob: 记录字段（同批全部格共享）
        entries: [{msv, lsv, bounds, cnf_build}, ...]——一个格一个条目：
            msv/lsv 为该格 p/q（记录与断点恢复键；同 prob 多格靠它区分）；
            bounds 为该格界数组 dict（None 不记录，经 ctx.bounds.add 落盘）；
            cnf_build 为无参 callable → (cnf_path, var_count, clause_count,
                cnf_time, pool, vars)（CNF 文件名须含 tag，见 generate_cnf_file）
        jobs: 并发上限（None = 全开），透传 ctx.solver.solve_batch
        timeout: 每格单次求解超时（None = 不限），透传

    Returns:
        (outcomes, batch_sat):
        - outcomes: {(msv, lsv): SolveOutcome}——只含实际处理的格：断点命中的
          终态格按记录回放（resumed=True，不建 CNF 不求解）；未命中格占位后
          并行求解（含被杀 TERMINATED）。已记录 SAT 格所在 prob 短路时只含该
          SAT 格（残留 TERMINATED/PENDING 行不动，round 结束语义优先）。
        - batch_sat: 批内是否有 SAT（含回放命中）——模型据此结束本轮/advance

    三种批终态（模型据此判断 prob 结果）：
    - batch_sat=True → 本轮在 prob 处结束，取 SAT 格的 (msv, lsv)
    - batch_sat=False 且无 TIMEOUT/NoResult/ERROR → 本 prob 全 UNSAT，advance
    - batch_sat=False 且存在非终态（TIMEOUT/NoResult/ERROR，被杀 TERMINATED
      不算——它只随 SAT 出现）→ raise RuntimeError：未知格不能当 UNSAT 推进
      prob 记错界；其行非终态，resume 会自然重跑该格
    """
    tag_of = lambda msv, lsv: f"m{msv}-q{lsv}"
    outcomes = {}
    resumed_sat = None
    to_dispatch = []       # (entry, msv, lsv)
    for entry in entries:
        msv, lsv = entry["msv"], entry["lsv"]
        row = ctx.record.lookup(round_num, prob, msv, lsv)
        if row is not None:
            outcome = SolveOutcome(
                result=row["result"],
                solve_time=float(row["solve_time"]),
                var_count=int(row["var_count"]),
                clause_count=int(row["clause_count"]),
                cnf_time=float(row["cnf_time"]),
                resumed=True,
            )
            outcomes[(msv, lsv)] = outcome
            if outcome.result == RESULT_SATISFIABLE:
                resumed_sat = (msv, lsv)
            else:
                _print_solve(ctx, round_num, prob, msv, lsv, outcome.result,
                             outcome.solve_time, outcome.var_count,
                             outcome.clause_count, resumed=True)
        else:
            to_dispatch.append((entry, msv, lsv))

    if resumed_sat is not None:
        # 该 prob 已有记录的 SAT（上一轮 run 在此结束本轮）：短路，不派发任何格
        msv, lsv = resumed_sat
        sat_out = outcomes[(msv, lsv)]
        _print_solve(ctx, round_num, prob, msv, lsv, sat_out.result,
                     sat_out.solve_time, sat_out.var_count, sat_out.clause_count,
                     resumed=True)
        return outcomes, True

    # 占位（枚举序，CSV 行序 = 占位序）→ 建 CNF（全部格，含可能被杀者——
    # 被杀格 var/clause 在 CNF 建时已知，按用户语义计入该 prob 的累加）
    #
    # 物理全并行标记：格数 > 并发上限 jobs 时格被分波排队，不是真正同时并发
    # （SAT 首杀的"prob 时间 = SAT 格时长"、全 UNSAT 的 max 口径都会失真——
    # 排队格晚起跑，max 低估了真实墙钟）→ 该批 full_parallel=0，写进每行 CSV
    # 供汇总指出；jobs=None（全开）或格数不超限时恒为 1。真需要此 prob 的并行
    # 时间时放开 jobs 重跑即可（记录按全字段匹配，已解格自动跳过）。
    n_dispatch = len(to_dispatch)
    full_parallel = "1" if (jobs is None or n_dispatch <= jobs) else "0"
    if full_parallel == "0":
        print(f"  [{ctx.cipher.NAME}] R{round_num:>2} P{prob:>4}: {n_dispatch} 格 "
              f"> 并发上限 {jobs}，非物理全并行（时间口径失真，full_parallel=0）")
    entry_bounds_of = {(e["msv"], e["lsv"]): e["bounds"]
                       for e in entries if e.get("bounds") is not None}
    built = {}             # (msv, lsv) -> (cnf_path, var_count, clause_count, cnf_time, vars)
    for entry, msv, lsv in to_dispatch:
        ctx.record.write(round_num, prob, msv, lsv, RESULT_PENDING,
                         0.0, 0, 0, 0.0, ctx.solver.name,
                         full_parallel=full_parallel)
        cnf_path, var_count, clause_count, cnf_time, _pool, vars_ = entry["cnf_build"]()
        built[(msv, lsv)] = (cnf_path, var_count, clause_count, cnf_time, vars_)

    def backfill(msv, lsv, result, solve_time, model, terminated):
        """solve_batch 每格终态回调：即时回填记录/界/明细，删除临时文件。"""
        cnf_path, var_count, clause_count, cnf_time, vars_ = built[(msv, lsv)]
        if not terminated:
            bounds = entry_bounds_of.get((msv, lsv))
            if bounds is not None:
                ctx.bounds.add(round_num, prob, msv, lsv, bounds)
        ctx.record.write(round_num, prob, msv, lsv, result, solve_time,
                         var_count, clause_count, cnf_time, ctx.solver.name,
                         full_parallel=full_parallel)
        _print_solve(ctx, round_num, prob, msv, lsv, result, solve_time,
                     var_count, clause_count)
        ctx.cleanup(cnf_path, ctx.sol_path(round_num, prob, tag_of(msv, lsv)))
        if result == RESULT_SATISFIABLE and model:
            rounds, final_state = extract_rounds(model, vars_, round_num, ctx.cipher)
            with open(ctx.path_path(round_num, prob, tag_of(msv, lsv)), "w") as f:
                f.write(f"# {ctx.cipher.NAME} R{round_num}-P{prob} "
                        f"SAT 差分路径 (cell m{msv}-q{lsv})\n")
                f.write(format_path(rounds, final_state))

    items = []
    for entry, msv, lsv in to_dispatch:
        items.append(((msv, lsv), built[(msv, lsv)][0],
                      ctx.sol_path(round_num, prob, tag_of(msv, lsv))))
    batch = ctx.solver.solve_batch(
        items, jobs=jobs, timeout=timeout,
        on_result=lambda idx, result, elapsed, model, terminated:
            backfill(idx[0], idx[1], result, elapsed, model, terminated))
    for (msv, lsv), (result, elapsed, model, terminated) in batch.items():
        outcomes[(msv, lsv)] = SolveOutcome(
            result=result, solve_time=elapsed,
            var_count=built[(msv, lsv)][1],
            clause_count=built[(msv, lsv)][2],
            cnf_time=built[(msv, lsv)][3],
            model=model if not terminated else None)

    batch_sat = any(o.result == RESULT_SATISFIABLE for o in outcomes.values())
    if not batch_sat:
        bad = sorted(k for k, o in outcomes.items()
                     if o.result in (RESULT_TIMEOUT, RESULT_NO_RESULT, RESULT_ERROR))
        if bad:
            raise RuntimeError(
                f"R{round_num} P{prob} 批内格 {bad} 无结果且无 SAT，不能当 "
                f"UNSAT 推进 prob（行已记非终态，resume 会重跑该格）；"
                f"请 --timeout 加大或直接重跑续接")
    return outcomes, batch_sat
