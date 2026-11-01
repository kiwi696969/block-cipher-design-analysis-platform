"""
Matsui 概率界管理：概率界用 6a+7b 表示（差分权重 6 与 7）。

DW/AS 模型使用 refresh_prob_bound（先大 b 后小 b 遍历）。
MDW 使用 refresh_probability_bound，RS 使用反向 refresh_prob_bound_new_R，
这两个变体由各自模型自带（模型全自由原则）。

DWP/RSP（同 prob 多格并行模型）用本模块的格枚举 helper：
- enumerate_prob_cells：给定 prob，列出全部可解格 (b, q)（b 降序、q ≥ known）——
  等价于串行 refresh 状态机在该 prob 上"跳过 q<known 格后逐个求解"的格集
- is_expressible / next_expressible_below：DWP advance / RSP descend 用
  （串行 refresh 的 +1/−1 探新 prob 时跳过不可表达 prob 的等价物）
"""


def refresh_prob_bound(prob_bound, p_curr, q_curr, first_refresh=0):
    """
    更新概率边界值（按 p 最大 q 最小到 p 最小 q 最大顺序遍历）。

    概率界 = 6a + 7b，其中 p = b（weight-7 S-box 数），q = a + b（活跃 S-box 总数）。

    Args:
        prob_bound: 当前概率边界值
        p_curr: 当前 p 边界值
        q_curr: 当前 q 边界值（本函数不直接使用，语义保留）
        first_refresh: 1 为初始化，0 为更新（默认）

    Returns:
        更新后的 (prob_bound, p_bound, q_bound) 三元组
    """
    if first_refresh == 1:
        if prob_bound == 0:
            return prob_bound, 0, 0

        # 从最大 b 值开始向下搜索
        max_b = prob_bound // 7
        for b in range(max_b, -1, -1):
            remainder = prob_bound - 7 * b
            if remainder >= 0 and remainder % 6 == 0:
                a = remainder // 6
                return prob_bound, b, a + b

        raise ValueError(f"无法初始化: {prob_bound} 无法表示为6a+7b")
    else:
        current_b = p_curr
        # 从当前 b-1 开始向下搜索，寻找更小的 b
        for b in range(current_b - 1, -1, -1):
            remainder = prob_bound - 7 * b
            if remainder >= 0 and remainder % 6 == 0:
                a = remainder // 6
                return prob_bound, b, a + b

        # 当前 prob_bound 下已无更小 b，则增加 prob_bound 并取最大 b
        new_prob = prob_bound + 1
        while True:
            max_b = new_prob // 7
            for b in range(max_b, -1, -1):
                remainder = new_prob - 7 * b
                if remainder >= 0 and remainder % 6 == 0:
                    a = remainder // 6
                    return new_prob, b, a + b
            new_prob += 1


def enumerate_prob_cells(prob, known_active):
    """列出 prob 下全部可解格 [(b, q), ...]，b 降序、q ≥ known_active。

    格 = 6a+7b = prob 的分解，p = b、q = a + b = (prob - b)/6。
    串行 DW/RS 的 refresh 在同一 prob 内按 b 降序逐格求解、跳过 q < known 的格
    （不求解不记录）——这里给出的正是串行会实际求解的格集（b 降序 = 串行顺序）。
    prob 不可表达（无分解）或全格 q < known 时返回 []。

    注：q ≥ known_active 的格是 b 的一段连续后缀（q 随 b 递减而递增）。
    """
    cells = []
    for b in range(prob // 7, -1, -1):
        remainder = prob - 7 * b
        if remainder >= 0 and remainder % 6 == 0:
            q = remainder // 6 + b
            if q >= known_active:
                cells.append((b, q))
    return cells


def is_expressible(prob):
    """prob 能否表示为 6a+7b（a, b ≥ 0）。0 可表达（a=b=0）。"""
    for b in range(prob // 7, -1, -1):
        remainder = prob - 7 * b
        if remainder >= 0 and remainder % 6 == 0:
            return True
    return False


def next_expressible_below(prob):
    """严格小于 prob 的最大可表达 prob（RSP descend 用；串行 refresh 反向跳
    过不可表达 prob，落到此处）。prob > 0 时总有返回（0 可表达）。"""
    for p in range(prob - 1, -1, -1):
        if is_expressible(p):
            return p
    return -1  # 不可达（prob ≤ 0），调用方勿传
