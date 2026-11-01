"""
SM4 算法：常量 + 轮函数约束（p/q 与 w7 两套布局）。

p/q 轮函数逐字节移植自 SM4_HPD_Auto_Search_DW.py（AS/DW/MDW/RS 共用），
w7 轮函数逐字节移植自 SM4_HPD_Auto_Search_MAP.py（MAP 用）。

⚠️ 参考实现中 SM4 各模型误用 DBlock_S-Box_Consts.txt / AES_S-Box_Consts.txt
（复制残留 bug）；此处使用正确的 SM4_S-Box_Consts 数据（已与真实 SM4 sbox
DDT 验证一致）。
"""

from itertools import chain

from .base import CipherBase
from .varsys import alloc_aux
from ..util.cnf import write_xor_clause
from ..util.espresso import write_sbox_clauses

# XOR 约束遍历范围：3 输入 XOR 需 2^4 个 alpha，6 输入需 2^7 个
THREE_INPUT_XOR_RANGE = 2 ** 4
SIX_INPUT_XOR_RANGE = 2 ** 7


class SM4Cipher(CipherBase):
    NAME = "SM4"
    STATE_BITS = 128
    WORD_BITS = 32
    SBOX_COUNT = 4
    SBOX_BITS = 8
    FULL_ROUNDS = 32
    HALF_BLOCK_WEIGHT_SIZE = 4
    LINEAR_SHIFTS = [2, 10, 18, 24]  # 线性变换 L 的循环移位

    # 各轮最好已知活跃 S-box 数（理论下界，搜索验证是否可达）
    KNOWN_ACTIVE_SBOXES = ([0] + [0, 0, 0, 1, 2, 2, 5, 6, 7, 8, 9, 10, 10, 10, 12, 15,
                                  16, 16, 18, 20, 20, 20, 23, 24, 25, 26, 27, 28, 29,
                                  30, 31, 32])

    # =====================================================================
    # 变量生成（布局同参考 DW / MAP 文件的 var_counter 顺序）
    # =====================================================================

    def generate_variables_pq(self, pool, round_count, p_lower, p_upper, q_lower, q_upper):
        """
        p/q 体系变量生成（尾词表示：r_in[r] 为 WORD_BITS 位，r_in[round_count]
        为 STATE_BITS 完整状态）。vars 键：r_in, p, q, s_in, s_out, p_aux_u, q_aux_u。
        """
        state_bits = self.STATE_BITS
        word_bits = self.WORD_BITS
        sbox_count = self.SBOX_COUNT

        r_in = []   # 输入状态（尾词表示）
        p_vars = []  # 每轮 S-box 的 p（weight-7 指示）
        q_vars = []  # 每轮 S-box 的 q（活跃指示）
        s_in = []   # XOR 输出（每轮 32 位）
        s_out = []  # S-box 输出（每轮 32 位）

        for r in range(round_count):
            r_in.append([])
            s_in.append([])
            p_vars.append([])
            q_vars.append([])
            s_out.append([])

            # 尾词状态位（WORD_BITS 个）
            for i in range(word_bits):
                r_in[r].append(pool.id(f"r_in_{r}_{i}"))

            # p、q 变量
            for i in range(sbox_count):
                p_vars[r].append(pool.id(f"p_{r}_{i}"))
                q_vars[r].append(pool.id(f"q_{r}_{i}"))

            # XOR 输出与 S-box 输出（各 word_bits 个）
            for i in range(word_bits):
                s_in[r].append(pool.id(f"s_in_{r}_{i}"))
                s_out[r].append(pool.id(f"s_out_{r}_{i}"))

        # 最后一轮完整状态
        r_in.append([])
        for i in range(state_bits):
            r_in[round_count].append(pool.id(f"r_in_{round_count}_{i}"))

        p_aux_u = alloc_aux(pool, round_count, sbox_count, p_lower, p_upper, "pu")
        q_aux_u = alloc_aux(pool, round_count, sbox_count, q_lower, q_upper, "qu")

        return {
            "r_in": r_in, "p": p_vars, "q": q_vars,
            "s_in": s_in, "s_out": s_out,
            "p_aux_u": p_aux_u, "q_aux_u": q_aux_u,
        }, pool.top

    def generate_variables_w7(self, pool, round_count, lower_bound, upper_bound):
        """
        w7 体系变量生成（MAP 布局：完整状态 xin + xout 复用 + 7 权重变量）。
        vars 键：xin, xout, p, q, w, xor_out, sbox_out, aux_u。
        """
        state_bits = self.STATE_BITS
        word_bits = self.WORD_BITS
        sbox_count = self.SBOX_COUNT
        wps = self.WEIGHT_VARS_PER_SBOX
        total_weight_vars = sbox_count * wps

        xin = []
        xor_out = []
        p_vars = []
        q_vars = []
        sbox_out = []
        xout = []

        for r in range(round_count):
            xin.append([])
            xor_out.append([])
            p_vars.append([])
            q_vars.append([])
            sbox_out.append([])

            # 完整状态位
            for i in range(state_bits):
                xin[r].append(pool.id(f"xin_{r}_{i}"))

            # p、q 变量
            for i in range(sbox_count):
                p_vars[r].append(pool.id(f"p_{r}_{i}"))
                q_vars[r].append(pool.id(f"q_{r}_{i}"))

            # XOR 输出与 S-box 输出
            for i in range(word_bits):
                xor_out[r].append(pool.id(f"xo_{r}_{i}"))
                sbox_out[r].append(pool.id(f"so_{r}_{i}"))

        # 输出状态复用输入状态（xout[r] = xin[r+1]）
        for i in range(round_count - 1):
            xout.append([pool.id(f"xin_{i + 1}_{j}") for j in range(state_bits)])

        # 最后一轮输出独立变量
        xout.append([])
        for i in range(state_bits):
            xout[round_count - 1].append(pool.id(f"xout_{round_count - 1}_{i}"))

        # 7 权重变量
        w_vars = []
        for r in range(round_count):
            w_vars.append([])
            for i in range(sbox_count):
                w_vars[r].append([])
                for j in range(wps):
                    w_vars[r][i].append(pool.id(f"w_{r}_{i}_{j}"))

        # 序列编码辅助变量（作用于拍平的 w 变量，每轮 total_weight_vars 个）
        aux_u = alloc_aux(pool, round_count, total_weight_vars, lower_bound, upper_bound, "au")

        return {
            "xin": xin, "xout": xout, "p": p_vars, "q": q_vars,
            "w": w_vars, "xor_out": xor_out, "sbox_out": sbox_out,
            "aux_u": aux_u,
        }, pool.top

    # =====================================================================
    # p/q 体系轮函数（AS/DW/MDW/RS 共用，逐字节移植参考 DW 文件）
    # =====================================================================

    def generate_round_function_constraints(self, vars, round_count, file):
        """p/q 体系全部轮函数约束。vars 键：r_in, p, q, s_in, s_out。"""
        self.write_initial_state_clause(vars, file)

        for r in range(round_count):
            # 1. 初始 3-XOR：s_in = X_{r+2} ⊕ X_{r+3} ⊕ X_{r+4}
            self.generate_initial_xor_constraints(vars, r, file)

            # 2. S-box 层（τ 函数）
            for sbox_idx in range(self.SBOX_COUNT):
                self.generate_sbox_constraints(vars, r, sbox_idx, file)

            # 3. 最终 6-XOR 与状态更新
            self.generate_final_xor_and_update_constraints(vars, r, file)

    def write_initial_state_clause(self, vars, file):
        """初始状态子句（128 位全正文字）。"""
        r_in_list = list(chain.from_iterable(vars["r_in"]))
        clause = " ".join(str(x) for x in r_in_list[: self.STATE_BITS]) + " 0\n"
        file.write(clause)

    def generate_initial_xor_constraints(self, vars, round_num, file):
        """3-输入 XOR：s_in[round_num] = X_{r+2} ⊕ X_{r+3} ⊕ X_{r+4}。"""
        r_in_list = list(chain.from_iterable(vars["r_in"]))
        s_in = vars["s_in"]
        for bit_idx in range(self.WORD_BITS):
            idx1 = (round_num + 1) * self.WORD_BITS + bit_idx
            idx2 = (round_num + 2) * self.WORD_BITS + bit_idx
            idx3 = (round_num + 3) * self.WORD_BITS + bit_idx
            out_var = s_in[round_num][bit_idx]

            variables = [r_in_list[idx1], r_in_list[idx2], r_in_list[idx3], out_var]
            for alpha in range(THREE_INPUT_XOR_RANGE):
                if bin(alpha).count("1") % 2 == 0:
                    continue
                write_xor_clause(variables, alpha, file)

    def generate_sbox_constraints(self, vars, round_num, sbox_idx, file):
        """S-box 差分概率约束（espresso 数据）。"""
        s_in = vars["s_in"]
        s_out = vars["s_out"]
        p_var = vars["p"][round_num][sbox_idx]
        q_var = vars["q"][round_num][sbox_idx]

        input_vars = [s_in[round_num][sbox_idx * self.SBOX_BITS + i] for i in range(self.SBOX_BITS)]
        output_vars = [s_out[round_num][sbox_idx * self.SBOX_BITS + i] for i in range(self.SBOX_BITS)]

        write_sbox_clauses(self.esc_data, input_vars, output_vars, p_var, q_var, file)

    def generate_final_xor_and_update_constraints(self, vars, round_num, file):
        """线性变换 L 与状态更新：X_{r+5} = X_{r+1} ⊕ L(τ(...))。"""
        r_in = vars["r_in"]
        s_out = vars["s_out"]
        r_in_list = list(chain.from_iterable(r_in))

        for bit_idx in range(self.WORD_BITS):
            shifted_indices = [(bit_idx + shift) % self.WORD_BITS for shift in self.LINEAR_SHIFTS]

            input_vars = [
                r_in[round_num][bit_idx],
                s_out[round_num][bit_idx],
                s_out[round_num][shifted_indices[0]],
                s_out[round_num][shifted_indices[1]],
                s_out[round_num][shifted_indices[2]],
                s_out[round_num][shifted_indices[3]],
            ]

            output_var = r_in_list[(round_num + 4) * self.WORD_BITS + bit_idx]
            for alpha in range(SIX_INPUT_XOR_RANGE):
                if bin(alpha).count("1") % 2 == 0:
                    continue
                write_xor_clause(input_vars + [output_var], alpha, file)

    # =====================================================================
    # w7 体系轮函数（MAP 用，逐字节移植参考 MAP 文件）
    # =====================================================================

    def generate_round_function_constraints_w7(self, vars, round_count, file):
        """w7 体系全部轮函数约束。vars 键：xin, xout, p, q, w, xor_out, sbox_out。"""
        self.write_initial_state_clause_w7(vars, file)

        for r in range(round_count):
            # 1. 初始 3-XOR
            self.generate_initial_xor_constraints_w7(vars, r, file)

            # 2. S-box 层 + w 权重映射
            for sbox_idx in range(self.SBOX_COUNT):
                self.generate_sbox_constraints_w7(vars, r, sbox_idx, file)

            # 3. 线性变换 L
            self.generate_final_xor_constraints_w7(vars, r, file)

            # 4. 复制未修改的状态位
            self.generate_state_copy_constraints_w7(vars, r, file)

    def write_initial_state_clause_w7(self, vars, file):
        """初始状态子句：xin[0] 全正文字。"""
        clause = " ".join(str(x) for x in vars["xin"][0]) + " 0\n"
        file.write(clause)

    def generate_initial_xor_constraints_w7(self, vars, round_num, file):
        """3-输入 XOR：xor_out = 状态第 2/3/4 词的异或。"""
        xin = vars["xin"]
        xor_out = vars["xor_out"]
        for bit_idx in range(self.WORD_BITS):
            idx1 = self.WORD_BITS + bit_idx
            idx2 = 2 * self.WORD_BITS + bit_idx
            idx3 = 3 * self.WORD_BITS + bit_idx
            out_var = xor_out[round_num][bit_idx]

            variables = [xin[round_num][idx1], xin[round_num][idx2], xin[round_num][idx3], out_var]
            for alpha in range(THREE_INPUT_XOR_RANGE):
                if bin(alpha).count("1") % 2 == 0:
                    continue
                write_xor_clause(variables, alpha, file)

    def generate_sbox_constraints_w7(self, vars, round_num, sbox_idx, file):
        """S-box 差分约束 + w 权重映射等值（w[0]⟺p，w[i≥1]⟺q）。"""
        xor_out = vars["xor_out"]
        sbox_out = vars["sbox_out"]
        p_var = vars["p"][round_num][sbox_idx]
        q_var = vars["q"][round_num][sbox_idx]
        w_var = vars["w"][round_num][sbox_idx]

        input_vars = [xor_out[round_num][sbox_idx * self.SBOX_BITS + i] for i in range(self.SBOX_BITS)]
        output_vars = [sbox_out[round_num][sbox_idx * self.SBOX_BITS + i] for i in range(self.SBOX_BITS)]

        write_sbox_clauses(self.esc_data, input_vars, output_vars, p_var, q_var, file)

        # 权重映射等值约束
        for i in range(self.WEIGHT_VARS_PER_SBOX):
            if i == 0:
                file.write(f"-{w_var[i]} {p_var} 0\n")
                file.write(f"{w_var[i]} -{p_var} 0\n")
            else:
                file.write(f"-{w_var[i]} {q_var} 0\n")
                file.write(f"{w_var[i]} -{q_var} 0\n")

    def generate_final_xor_constraints_w7(self, vars, round_num, file):
        """6-输入 XOR：新词 = 状态第 1 词 ⊕ L(τ(...))。"""
        xin = vars["xin"]
        sbox_out = vars["sbox_out"]
        xout = vars["xout"]

        for bit_idx in range(self.WORD_BITS):
            shifted_indices = [(bit_idx + shift) % self.WORD_BITS for shift in self.LINEAR_SHIFTS]

            input_vars = [
                xin[round_num][bit_idx],
                sbox_out[round_num][bit_idx],
                sbox_out[round_num][shifted_indices[0]],
                sbox_out[round_num][shifted_indices[1]],
                sbox_out[round_num][shifted_indices[2]],
                sbox_out[round_num][shifted_indices[3]],
            ]

            output_var = xout[round_num][96 + bit_idx]
            for alpha in range(SIX_INPUT_XOR_RANGE):
                if bin(alpha).count("1") % 2 == 0:
                    continue
                write_xor_clause(input_vars + [output_var], alpha, file)

    def generate_state_copy_constraints_w7(self, vars, round_num, file):
        """复制未修改状态位：xout 前 96 位 = 状态第 2/3/4 词。"""
        xin = vars["xin"]
        xout = vars["xout"]
        for bit_offset in range(96):
            in_idx = 32 + bit_offset
            out_idx = bit_offset
            file.write(f"{xout[round_num][out_idx]} -{xin[round_num][in_idx]} 0\n")
            file.write(f"-{xout[round_num][out_idx]} {xin[round_num][in_idx]} 0\n")
