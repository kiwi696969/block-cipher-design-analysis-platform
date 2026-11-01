"""
变量生成共享辅助（按变量体系参数化）。

各算法变量布局不同（SM4 尾词表示、DBlock x_state、AES s_in+gf_out 等），
变量生成是各 cipher 类的方法（CipherBase.generate_variables_pq / _w7）；
这里只放跨算法共用的辅助函数。

变量用 IDPool 分配，调用顺序严格同参考 var_counter 顺序 → 编号一致，
生成 CNF 可与参考实现逐字节比对。
"""


def alloc_aux(pool, round_count, per_round, lower, upper, prefix):
    """
    序列编码辅助变量分配（p/q 体系与 w7 体系共用）。

    布局：aux[r][i] 为第 r 轮第 i 个权重变量的辅助变量列表。
    跳过最后一个 (r, i)（对应最后一轮最后一个权重变量，其权重不再需要
    辅助变量）；lower[idx] == upper[idx] 时该权重变量固定，无需辅助变量。

    Args:
        pool: IDPool 实例（本 CNF 专用）
        round_count: 轮数
        per_round: 每轮权重变量数（p/q 体系 = SBOX_COUNT；w7 体系 = SBOX_COUNT*7）
        lower/upper: 下/上界数组（长度 round_count*per_round）
        prefix: 变量名前缀（如 "pu"/"qu"/"au"）

    Returns:
        aux: list[list[list[int]]]
    """
    aux = []
    for r in range(round_count):
        aux.append([])
        for i in range(per_round):
            if (r == round_count - 1) and (i == per_round - 1):
                continue
            aux[r].append([])
            current_idx = r * per_round + i
            if lower[current_idx] == upper[current_idx]:
                continue
            for j in range(lower[current_idx], upper[current_idx]):
                aux[r][i].append(pool.id(f"{prefix}_{r}_{i}_{j}"))
    return aux
