"""
序列编码（基数约束）生成。

逐字节移植自参考实现（SM4_HPD_Auto_Search_DW.py 的
generate_sequential_encoding_constraints），所有模型共用：
- p/q 体系：w_vars = 拍平的 p 或 q 变量，bounds 为 p/q 各自的 lower/upper
- w7 体系（MAP）：w_vars = 拍平的 7 权重变量，bounds 为单组 lower/upper
"""


def generate_sequential_encoding_constraints(w_vars, u_vars, lower_bound, upper_bound, file):
    """
    生成权重变量的序列编码约束。

    Args:
        w_vars: 拍平的权重变量列表（p / q / w7 均可）
        u_vars: 按 (r,i) 顺序的辅助变量子列表（与参考结构一致，见 engine._build_aux_structure）
        lower_bound: 各权重变量的下界数组（长度 = len(w_vars)）
        upper_bound: 各权重变量的上界数组
        file: 输出句柄
    """
    if len(u_vars[0]) > 0:
        clause = f"-{w_vars[0]} {u_vars[0][0]} 0\n"
        file.write(clause)

    if lower_bound[0] == 0 and upper_bound[0] == 0:
        clause = f"-{w_vars[0]} 0\n"
        file.write(clause)

    if lower_bound[0] == 1 and upper_bound[0] == 1:
        clause = f"{w_vars[0]} 0\n"
        file.write(clause)

    if len(w_vars) > 2:
        for i in range(1, len(w_vars) - 1):
            l_prev = lower_bound[i - 1]
            u_prev = upper_bound[i - 1]
            l_curr = lower_bound[i]
            u_curr = upper_bound[i]

            if u_curr == 0:
                clause = f"-{w_vars[i]} 0\n"
                file.write(clause)
                continue

            if l_curr == 0:
                clause = f"-{w_vars[i]} {u_vars[i][0]} 0\n"
                file.write(clause)
                if l_prev < u_prev:
                    clause = f"-{u_vars[i - 1][0]} {u_vars[i][0]} 0\n"
                    file.write(clause)

            if u_curr > max(1, l_curr):
                for j in range(max(1, l_curr), u_curr):
                    if j <= l_prev:
                        clause = f"-{w_vars[i]} {u_vars[i][j - l_curr]} 0\n"
                        file.write(clause)
                    if (j > l_prev) and (j <= u_prev):
                        clause = f"-{w_vars[i]} -{u_vars[i - 1][j - 1 - l_prev]} {u_vars[i][j - l_curr]} 0\n"
                        file.write(clause)
                    if (j >= l_prev) and (j <= u_prev - 1):
                        clause = f"-{u_vars[i - 1][j - l_prev]} {u_vars[i][j - l_curr]} 0\n"
                        file.write(clause)

            if l_prev == u_curr:
                clause = f"-{w_vars[i]} 0\n"
                file.write(clause)
            if (u_prev == u_curr) and (l_prev < u_curr):
                clause = f"-{w_vars[i]} -{u_vars[i - 1][len(u_vars[i - 1]) - 1]} 0\n"
                file.write(clause)

    if len(w_vars) >= 2:
        i = len(w_vars) - 1
        l_prev = lower_bound[i - 1]
        u_prev = upper_bound[i - 1]
        l_curr = lower_bound[i]
        u_curr = upper_bound[i]

        if l_prev == u_curr:
            clause = f"-{w_vars[i]} 0\n"
            file.write(clause)
        if (u_prev == u_curr) and (l_prev < u_curr):
            clause = f"-{w_vars[i]} -{u_vars[i - 1][len(u_vars[i - 1]) - 1]} 0\n"
            file.write(clause)
