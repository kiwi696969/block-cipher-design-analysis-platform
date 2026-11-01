"""
S-box 约束数据加载与子句写出（差分 DDT / 线性 LAT 通用）。

数据格式：每项为 18 元素列表 [δin_0..δin_7, δout_0..δout_7, p, q]，
0 = 变量取正（子句含 +var），1 = 变量取反（子句含 -var），9 = 不关心（子句不含）。
pkl 优先（快），txt 兜底（ast.literal_eval），进程内缓存。

两种攻击的数据文件只差「禁止的 (δin, δout) 组合集」：
- 差分 → {DATA_NAME}_S-Box_Consts.{pkl,txt}（espresso 从 DDT 提取，p 区分 6/7 位权）
- 线性 → {DATA_NAME}_S-Box_Linear_Consts.{pkl,txt}（直接从 LAT = WHT(S) 导出，
  p 恒 0；活跃指示 q 的语义见下）

线性数据由 scripts/gen_linear_sbox_data.py 生成（WSL 无 espresso，直接由 LAT
推导禁止集，比跑 espresso 更稳）。
"""

import ast
import os
import pickle

# 进程内缓存：{绝对路径: entries}
_CACHE = {}
# PLA 文件行缓存：{绝对路径: [.p 与 .e 之间的原始行]}（AES gf_mult / 4bit_xor）
_PLA_CACHE = {}


class EspressoData:
    """S-box 差分约束数据。"""

    def __init__(self, entries, source_path=""):
        self.entries = entries
        self.source_path = source_path

    def __len__(self):
        return len(self.entries)


def load_sbox_constraints(cipher, espresso_dir):
    """
    加载某算法的 S-box 约束数据（pkl 优先，txt 兜底），带进程内缓存。

    按攻击类型选数据文件：
    - differential → {DATA_NAME}_S-Box_Consts.{pkl,txt}（由 DDT 提取，p 区分 6/7 位权）
    - linear       → {DATA_NAME}_S-Box_Linear_Consts.{pkl,txt}（由 LAT 直接导出，p 恒 0）

    Args:
        cipher: CipherBase 子类实例（需要 .DATA_NAME/.NAME/.attack 与 espresso 数据）
        espresso_dir: espresso 数据目录（config.json 的 espresso_dir）

    Returns:
        EspressoData 实例
    """
    # DBlock-128/192/256 共享 DBlock 数据、Rijndael256 用 AES 数据 → 按 DATA_NAME 找
    data_name = cipher.DATA_NAME or cipher.NAME
    if cipher.attack == "differential":
        suffix = "_S-Box_Consts"
    else:  # linear
        suffix = "_S-Box_Linear_Consts"
    base = os.path.join(espresso_dir, f"{data_name}{suffix}")
    pkl_path = base + ".pkl"
    txt_path = base + ".txt"

    if os.path.exists(pkl_path):
        return _load_cached(pkl_path, _load_pkl)
    if os.path.exists(txt_path):
        return _load_cached(txt_path, _load_txt)
    if cipher.attack != "differential":
        raise FileNotFoundError(
            f"线性攻击（attack=linear）需要线性 S-box 近似数据 {base}.{{pkl,txt}}，"
            f"当前缺失。生成方式：python scripts/gen_linear_sbox_data.py"
            f"（由 {data_name} 的 S 盒 LAT 直接导出；差分数据 "
            f"{data_name}_S-Box_Consts 不适用于线性）")
    raise FileNotFoundError(f"S-box 约束数据未找到：{base}.{{pkl,txt}}（请先运行 convert-data 或放入数据）")


def _load_cached(path, loader):
    key = os.path.abspath(path)
    if key in _CACHE:
        return _CACHE[key]
    data = loader(path)
    obj = EspressoData(data, source_path=path)
    _CACHE[key] = obj
    return obj


def _load_pkl(path):
    with open(path, "rb") as f:
        return pickle.load(f)


def _load_txt(path):
    with open(path, "r", encoding="utf-8") as f:
        content = f.read()
    return ast.literal_eval(content)


def write_sbox_clauses(esc_data, input_vars, output_vars, p_var, q_var, file):
    """
    写某 S-box 的差分概率约束子句（逐字节移植参考 generate_sbox_constraints 的
    子句写出部分）。

    Args:
        esc_data: EspressoData 实例
        input_vars: 8 个输入差分位变量
        output_vars: 8 个输出差分位变量
        p_var: 该 S-box 的 p 变量（weight-7 指示）
        q_var: 该 S-box 的 q 变量（活跃指示）
        file: 输出句柄
    """
    for zeta in esc_data.entries:
        clause_str = ""

        # 输入位约束
        for k in range(8):
            if zeta[k] == 1:
                clause_str += f"-{input_vars[k]} "
            elif zeta[k] == 0:
                clause_str += f"{input_vars[k]} "

        # 输出位约束
        for k in range(8):
            if zeta[k + 8] == 1:
                clause_str += f"-{output_vars[k]} "
            elif zeta[k + 8] == 0:
                clause_str += f"{output_vars[k]} "

        # p 变量约束
        if zeta[16] == 1:
            clause_str += f"-{p_var} "
        elif zeta[16] == 0:
            clause_str += f"{p_var} "

        # q 变量约束
        if zeta[17] == 1:
            clause_str += f"-{q_var} "
        elif zeta[17] == 0:
            clause_str += f"{q_var} "

        file.write(clause_str + "0\n")


def load_pla_lines(path):
    """
    加载 espresso PLA 文件在 .p 与 .e 之间的原始行（进程内缓存）。

    与参考 get_espresso_result_cnf 的切片逻辑一致：".p" 子串匹配（最后一次
    出现的位置 +1）为起始，".e" 子串匹配为结束。gf 文件头含 "#.phase 0"
    也会命中 ".p"——参考正是靠这一点取到数据行起始，必须原样复刻。
    """
    key = os.path.abspath(path)
    if key in _PLA_CACHE:
        return _PLA_CACHE[key]
    with open(path, "r") as f:
        lines = f.readlines()
    start, end = 0, len(lines)
    for i, line in enumerate(lines):
        if ".p" in line:
            start = i + 1
        if ".e" in line:
            end = i
    result = lines[start:end]
    _PLA_CACHE[key] = result
    return result


def write_pla_clauses(pla_lines, vars, file):
    """
    按参考 get_espresso_result_cnf 写出 PLA 子句。

    每行取前 len(vars) 个字符，逐位判断：'0' → +vars[i]，'1' → -vars[i]，
    其余字符（'-' 等）跳过。与参考行为逐字节一致（数据行均长于 bd，
    不存在 line[i] 越界的情况）。
    """
    bd = len(vars)
    for line in pla_lines:
        clause = ""
        for i in range(bd):
            if line[i] == '0':
                clause += f"{vars[i]} "
            elif line[i] == '1':
                clause += f"-{vars[i]} "
        clause += "0\n"
        file.write(clause)
