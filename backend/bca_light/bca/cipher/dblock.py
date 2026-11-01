"""
DBlock 算法：常量 + 轮函数约束（p/q 与 w7 两套布局）。

逐字节移植自 DBlock_HPD_Auto_Search.py 的变量生成与轮函数：
- 变量布局：x_state（round_count+2 个状态，各 STATE_BITS 位）+ p/q + s_out，
  w7 另加 w_vars（每 S-box 7 个权重变量）
- 轮函数：初始状态子句（x_state[0]+x_state[1] 全正）→ 字节置换 P_n →
  S-box（espresso 数据）→ 线性变换 A（6 输入 XOR，LINEAR_SHIFTS=[8,10,18,26]）
- Feistel 结构：ΔX_{r+2} = A(s_out[r]) ⊕ ΔX_r

DBlock-128/192/256 共享 S-box 数据（DATA_NAME="DBlock"），仅参数不同
（STATE_BITS/SBOX_COUNT/P_PERMUTATION/G_BLOCKS/KNOWN_ACTIVE_SBOXES）。
"""

from .base import CipherBase
from .varsys import alloc_aux
from ..util.cnf import write_xor_clause
from ..util.espresso import write_sbox_clauses

# XOR 约束遍历范围：6 输入 XOR 需 2^7 个 alpha
SIX_INPUT_XOR_RANGE = 2 ** 7


class DBlockCipher(CipherBase):
    NAME = "DBlock"            # 子类覆盖为 DBlock-128 等（注册表键）
    DATA_NAME = "DBlock"       # 三个 block size 共享 DBlock S-box 数据
    WORD_BITS = 32
    SBOX_BITS = 8
    FULL_ROUNDS = 20
    LINEAR_SHIFTS = [8, 10, 18, 26]   # 线性变换 A 的循环移位
    WEIGHT_VARS_PER_SBOX = 7
    SUPPORTS_W7 = True

    # 子类覆盖（各 block size 参数）：
    BLOCK_SIZE = None
    STATE_BITS = None
    SBOX_COUNT = None
    P_PERMUTATION = None       # 字节置换 P_n
    G_BLOCKS = None            # G_n 中 32 位块数
    KNOWN_ACTIVE_SBOXES = None

    def __init__(self, cfg, attack="differential"):
        if self.STATE_BITS is None:
            raise TypeError(f"{self.NAME} 是抽象基类，请用 DBlock128/192/256Cipher")
        super().__init__(cfg, attack=attack)

    # =====================================================================
    # 变量生成（布局同参考 generate_variables 的 var_counter 顺序）
    # =====================================================================

    def generate_variables_pq(self, pool, round_count, p_lower, p_upper, q_lower, q_upper):
        """p/q 体系变量生成。vars 键：x_state, p, q, s_out, p_aux_u, q_aux_u。"""
        state_bits = self.STATE_BITS
        sbox_count = self.SBOX_COUNT

        x_state = []
        p_vars = []
        q_vars = []
        s_out = []

        for r in range(round_count):
            x_state.append([])
            for i in range(state_bits):
                x_state[r].append(pool.id(f"x_{r}_{i}"))

            p_vars.append([])
            q_vars.append([])
            for i in range(sbox_count):
                p_vars[r].append(pool.id(f"p_{r}_{i}"))
                q_vars[r].append(pool.id(f"q_{r}_{i}"))

            s_out.append([])
            for i in range(state_bits):
                s_out[r].append(pool.id(f"s_out_{r}_{i}"))

        # 多出的两个状态：x_state[round_count], x_state[round_count+1]
        for r in range(round_count, round_count + 2):
            x_state.append([])
            for i in range(state_bits):
                x_state[r].append(pool.id(f"x_{r}_{i}"))

        p_aux_u = alloc_aux(pool, round_count, sbox_count, p_lower, p_upper, "pu")
        q_aux_u = alloc_aux(pool, round_count, sbox_count, q_lower, q_upper, "qu")

        return {
            "x_state": x_state, "p": p_vars, "q": q_vars, "s_out": s_out,
            "p_aux_u": p_aux_u, "q_aux_u": q_aux_u,
        }, pool.top

    def generate_variables_w7(self, pool, round_count, lower_bound, upper_bound):
        """w7 体系变量生成（MAP 布局）。vars 键：x_state, p, q, w, s_out, aux_u。"""
        state_bits = self.STATE_BITS
        sbox_count = self.SBOX_COUNT
        total_weight_vars = sbox_count * self.WEIGHT_VARS_PER_SBOX

        x_state = []
        p_vars = []
        q_vars = []
        s_out = []

        for r in range(round_count):
            x_state.append([])
            for i in range(state_bits):
                x_state[r].append(pool.id(f"x_{r}_{i}"))

            p_vars.append([])
            q_vars.append([])
            for i in range(sbox_count):
                p_vars[r].append(pool.id(f"p_{r}_{i}"))
                q_vars[r].append(pool.id(f"q_{r}_{i}"))

            s_out.append([])
            for i in range(state_bits):
                s_out[r].append(pool.id(f"s_out_{r}_{i}"))

        for r in range(round_count, round_count + 2):
            x_state.append([])
            for i in range(state_bits):
                x_state[r].append(pool.id(f"x_{r}_{i}"))

        # 7 权重变量（在 x_state/p/q/s_out 之后分配，顺序同参考）
        w_vars = []
        for r in range(round_count):
            w_vars.append([])
            for i in range(sbox_count):
                w_vars[r].append([])
                for j in range(self.WEIGHT_VARS_PER_SBOX):
                    w_vars[r][i].append(pool.id(f"w_{r}_{i}_{j}"))

        aux_u = alloc_aux(pool, round_count, total_weight_vars, lower_bound, upper_bound, "au")

        return {
            "x_state": x_state, "p": p_vars, "q": q_vars, "w": w_vars,
            "s_out": s_out, "aux_u": aux_u,
        }, pool.top

    # =====================================================================
    # 轮函数约束（逐字节移植参考）
    # =====================================================================

    def generate_round_function_constraints(self, vars, round_count, file):
        """p/q 体系全部轮函数约束。vars 键：x_state, p, q, s_out。"""
        # 初始状态子句：X_0 与 X_1 全正文字
        clause = " ".join(str(x) for x in vars["x_state"][0] + vars["x_state"][1]) + " 0\n"
        file.write(clause)

        for r in range(round_count):
            # 1. 字节置换 P_n：s_in = P_n(reverse(x_state[r+1] 的字节))
            x_sbox = [vars["x_state"][r + 1][i * self.SBOX_BITS: (i + 1) * self.SBOX_BITS]
                      for i in range(self.SBOX_COUNT)]
            x_sbox_re = x_sbox[::-1]
            s_in = [x_sbox_re[self.P_PERMUTATION[i]] for i in range(self.SBOX_COUNT)]

            # 2. S-box 层
            for sbox_idx in range(self.SBOX_COUNT):
                input_vars = s_in[sbox_idx]
                output_vars = vars["s_out"][r][sbox_idx * self.SBOX_BITS: (sbox_idx + 1) * self.SBOX_BITS]
                write_sbox_clauses(
                    self.esc_data, input_vars, output_vars,
                    vars["p"][r][sbox_idx], vars["q"][r][sbox_idx], file,
                )

            # 3. 线性变换 A + Feistel 更新
            for word_idx in range(self.G_BLOCKS):
                self.generate_linear_transform_constraints(vars, r, word_idx, file)

    def generate_round_function_constraints_w7(self, vars, round_count, file):
        """w7 体系全部轮函数约束（含 w⟺p/q 等值映射）。"""
        clause = " ".join(str(x) for x in vars["x_state"][0] + vars["x_state"][1]) + " 0\n"
        file.write(clause)

        for r in range(round_count):
            x_sbox = [vars["x_state"][r + 1][i * self.SBOX_BITS: (i + 1) * self.SBOX_BITS]
                      for i in range(self.SBOX_COUNT)]
            x_sbox_re = x_sbox[::-1]
            s_in = [x_sbox_re[self.P_PERMUTATION[i]] for i in range(self.SBOX_COUNT)]

            for sbox_idx in range(self.SBOX_COUNT):
                input_vars = s_in[sbox_idx]
                output_vars = vars["s_out"][r][sbox_idx * self.SBOX_BITS: (sbox_idx + 1) * self.SBOX_BITS]
                p_var = vars["p"][r][sbox_idx]
                q_var = vars["q"][r][sbox_idx]
                write_sbox_clauses(self.esc_data, input_vars, output_vars, p_var, q_var, file)

                # 权重映射等值约束
                w_var = vars["w"][r][sbox_idx]
                for i in range(self.WEIGHT_VARS_PER_SBOX):
                    if i == 0:
                        file.write(f"-{w_var[i]} {p_var} 0\n")
                        file.write(f"{w_var[i]} -{p_var} 0\n")
                    else:
                        file.write(f"-{w_var[i]} {q_var} 0\n")
                        file.write(f"{w_var[i]} -{q_var} 0\n")

            for word_idx in range(self.G_BLOCKS):
                self.generate_linear_transform_constraints(vars, r, word_idx, file)

    def generate_linear_transform_constraints(self, vars, round_num, word_idx, file):
        """线性变换 A 约束：ΔX_{r+2} = A(s_out[r]) ⊕ ΔX_r（6 输入 XOR）。"""
        s_out = vars["s_out"]
        x_state = vars["x_state"]
        word_bits = self.WORD_BITS
        shifts = self.LINEAR_SHIFTS

        for bit_idx in range(word_bits):
            shifted_indices = [(bit_idx + shift) % word_bits for shift in shifts]

            input_vars = [s_out[round_num][word_idx * word_bits + bit_idx]]
            for shift_idx in shifted_indices:
                input_vars.append(s_out[round_num][word_idx * word_bits: (word_idx + 1) * word_bits][shift_idx])

            output_var = x_state[round_num + 2][word_idx * word_bits + bit_idx]
            input_for_xor = x_state[round_num][word_idx * word_bits + bit_idx]

            for alpha in range(SIX_INPUT_XOR_RANGE):
                if bin(alpha).count("1") % 2 == 0:
                    continue
                write_xor_clause(input_vars + [input_for_xor, output_var], alpha, file)


class DBlock128Cipher(DBlockCipher):
    NAME = "DBlock-128"
    BLOCK_SIZE = 128
    STATE_BITS = 64
    SBOX_COUNT = 8
    P_PERMUTATION = [6, 5, 3, 1, 4, 7, 0, 2]
    G_BLOCKS = 2
    HALF_BLOCK_WEIGHT_SIZE = 8
    KNOWN_ACTIVE_SBOXES = [0] + [0, 1, 2, 6, 10, 12, 14, 18, 21, 23, 26, 28, 31, 34, 36, 39, 42, 45, 47, 50]


class DBlock192Cipher(DBlockCipher):
    NAME = "DBlock-192"
    BLOCK_SIZE = 192
    STATE_BITS = 96
    SBOX_COUNT = 12
    P_PERMUTATION = [9, 6, 4, 3, 5, 11, 0, 2, 10, 7, 8, 1]
    G_BLOCKS = 3
    HALF_BLOCK_WEIGHT_SIZE = 12
    KNOWN_ACTIVE_SBOXES = [0] + [0, 1, 2, 6, 10, 14, 18, 22, 26, 29, 32, 35, 37, 41, 44, 49, 52, 56, 59, 62]


class DBlock256Cipher(DBlockCipher):
    NAME = "DBlock-256"
    BLOCK_SIZE = 256
    STATE_BITS = 128
    SBOX_COUNT = 16
    P_PERMUTATION = [10, 5, 0, 15, 6, 11, 12, 1, 13, 8, 7, 2, 4, 9, 14, 3]
    G_BLOCKS = 4
    HALF_BLOCK_WEIGHT_SIZE = 16
    KNOWN_ACTIVE_SBOXES = [0] + [0, 1, 2, 6, 10, 16, 22, 29, 32, 36, 37, 41, 47, 54, 58, 62, 64, 68, 72, 78]
