"""
AES 算法：常量 + 轮函数约束（p/q 体系）。

逐字节移植自 AES_HPD_Auto_Search_Perfect_Serial_New.py 的变量生成与轮函数：
- 变量布局：s_in / p / q / s_out / gf_out_x2 / gf_out_x3（每轮各 STATE_BITS
  位 / SBOX_COUNT 个），最后再加 s_in[round_count]（完整输出状态）
- 轮函数：初始状态子句 → S-box（espresso 数据）→ ShiftRows + MixColumns
  （gf(2)/gf(3) 用 PLA 文件 AES_gf_x2/x3_Espresso_Result.txt，MixColumns 用
  4bit_xor.txt，切片/写出逻辑与参考 get_espresso_result_cnf 一致）

ShiftRows+MixColumns 的字节组织方式因算法而异（AES 4x4 转置舞蹈；
Rijndael-256 直接行主序），由各子类实现；变量生成与 S-box 层共用。

w7（MAP）体系无参考实现（参考项目只有 SM4 的 MAP），此处按 SM4 MAP 的布局
原则自行设计：SPN 结构无 Feistel 3-XOR，S-box 输入直接取 xin（无 xor_out /
state copy）；变量键 xin/xout/p/q/w/sbox_out/gf_out_x2/x3/aux_u。
"""

import os

from .base import CipherBase
from .varsys import alloc_aux
from ..util.espresso import load_pla_lines, write_pla_clauses, write_sbox_clauses


class AESLikeCipher(CipherBase):
    """AES 系算法共享部分：变量生成、S-box 层、PLA 辅助、轮函数骨架。"""

    # 子类覆盖：STATE_BITS / SBOX_COUNT / FULL_ROUNDS / HALF_BLOCK_WEIGHT_SIZE /
    # KNOWN_ACTIVE_SBOXES / SUPPORTS_W7 / SHIFT_OFFSETS / COLUMNS

    # =====================================================================
    # 变量生成（布局同参考 generate_variables 的 var_counter 顺序）
    # =====================================================================

    def generate_variables_pq(self, pool, round_count, p_lower, p_upper, q_lower, q_upper):
        """p/q 体系变量生成。vars 键：s_in, p, q, s_out, gf_out_x2, gf_out_x3,
        p_aux_u, q_aux_u。"""
        state_bits = self.STATE_BITS
        sbox_count = self.SBOX_COUNT

        s_in = []
        s_out = []
        p_vars = []
        q_vars = []
        gf_out_x2 = []
        gf_out_x3 = []

        for r in range(round_count):
            s_in.append([])
            s_out.append([])
            p_vars.append([])
            q_vars.append([])
            gf_out_x2.append([])
            gf_out_x3.append([])

            # 状态位
            for i in range(state_bits):
                s_in[r].append(pool.id(f"s_in_{r}_{i}"))

            # p、q 变量
            for i in range(sbox_count):
                p_vars[r].append(pool.id(f"p_{r}_{i}"))
                q_vars[r].append(pool.id(f"q_{r}_{i}"))

            # S-box 输出与 gf(2)/gf(3) 辅助变量
            for i in range(state_bits):
                s_out[r].append(pool.id(f"s_out_{r}_{i}"))
            for i in range(state_bits):
                gf_out_x2[r].append(pool.id(f"gf2_{r}_{i}"))
            for i in range(state_bits):
                gf_out_x3[r].append(pool.id(f"gf3_{r}_{i}"))

        # 最后一轮完整输出状态
        s_in.append([])
        for i in range(state_bits):
            s_in[round_count].append(pool.id(f"s_in_{round_count}_{i}"))

        p_aux_u = alloc_aux(pool, round_count, sbox_count, p_lower, p_upper, "pu")
        q_aux_u = alloc_aux(pool, round_count, sbox_count, q_lower, q_upper, "qu")

        return {
            "s_in": s_in, "p": p_vars, "q": q_vars,
            "s_out": s_out, "gf_out_x2": gf_out_x2, "gf_out_x3": gf_out_x3,
            "p_aux_u": p_aux_u, "q_aux_u": q_aux_u,
        }, pool.top

    def generate_variables_w7(self, pool, round_count, lower_bound, upper_bound):
        """
        w7 体系变量生成（MAP 布局，无参考实现，按 SM4 MAP 结构自行设计）：
        xin 完整状态 + S-box 输出 + gf(2)/gf(3) 辅助 + xout 复用 + 7 权重变量。
        vars 键：xin, xout, p, q, w, sbox_out, gf_out_x2, gf_out_x3, aux_u。
        AES/Rijndael 是 SPN 结构（无 Feistel 3-XOR），S-box 输入直接取 xin，
        故没有 SM4 w7 布局的 xor_out 与 state copy。
        """
        state_bits = self.STATE_BITS
        sbox_count = self.SBOX_COUNT
        wps = self.WEIGHT_VARS_PER_SBOX
        total_weight_vars = sbox_count * wps

        xin = []
        sbox_out = []
        p_vars = []
        q_vars = []
        gf_out_x2 = []
        gf_out_x3 = []
        xout = []

        for r in range(round_count):
            xin.append([])
            sbox_out.append([])
            p_vars.append([])
            q_vars.append([])
            gf_out_x2.append([])
            gf_out_x3.append([])

            # 完整状态位
            for i in range(state_bits):
                xin[r].append(pool.id(f"xin_{r}_{i}"))

            # p、q 变量
            for i in range(sbox_count):
                p_vars[r].append(pool.id(f"p_{r}_{i}"))
                q_vars[r].append(pool.id(f"q_{r}_{i}"))

            # S-box 输出与 gf(2)/gf(3) 辅助变量
            for i in range(state_bits):
                sbox_out[r].append(pool.id(f"so_{r}_{i}"))
            for i in range(state_bits):
                gf_out_x2[r].append(pool.id(f"gf2_{r}_{i}"))
            for i in range(state_bits):
                gf_out_x3[r].append(pool.id(f"gf3_{r}_{i}"))

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

        aux_u = alloc_aux(pool, round_count, total_weight_vars, lower_bound, upper_bound, "au")

        return {
            "xin": xin, "xout": xout, "p": p_vars, "q": q_vars,
            "w": w_vars, "sbox_out": sbox_out,
            "gf_out_x2": gf_out_x2, "gf_out_x3": gf_out_x3,
            "aux_u": aux_u,
        }, pool.top

    # =====================================================================
    # 轮函数约束骨架（初始子句 + S-box 层 + ShiftRows/MixColumns）
    # =====================================================================

    def generate_round_function_constraints(self, vars, round_count, file):
        self.write_initial_state_clause(vars, file)

        for r in range(round_count):
            for sbox_idx in range(self.SBOX_COUNT):
                self.generate_sbox_constraints(vars, r, sbox_idx, file)
            self.generate_shiftrows_and_mixcolumns_constraints(vars, r, file)

    def write_initial_state_clause(self, vars, file):
        """初始状态子句：s_in[0] 全正文字。"""
        clause = " ".join(str(x) for x in vars["s_in"][0]) + " 0\n"
        file.write(clause)

    def generate_sbox_constraints(self, vars, round_num, sbox_idx, file):
        """S-box 差分概率约束（espresso 数据）。"""
        s_in = vars["s_in"]
        s_out = vars["s_out"]
        p_var = vars["p"][round_num][sbox_idx]
        q_var = vars["q"][round_num][sbox_idx]

        input_vars = [s_in[round_num][sbox_idx * self.SBOX_BITS + i] for i in range(self.SBOX_BITS)]
        output_vars = [s_out[round_num][sbox_idx * self.SBOX_BITS + i] for i in range(self.SBOX_BITS)]

        write_sbox_clauses(self.esc_data, input_vars, output_vars, p_var, q_var, file)

    def generate_shiftrows_and_mixcolumns_constraints(self, vars, r, file):
        """ShiftRows + MixColumns 约束（各算法字节组织不同，子类实现）。"""
        raise NotImplementedError(f"{self.NAME} 未实现 ShiftRows+MixColumns")

    # ------------------------------------------------------------------
    # w7 体系轮函数（MAP 用，无参考实现，按 SM4 MAP 布局原则自行设计）
    # ------------------------------------------------------------------

    def generate_round_function_constraints_w7(self, vars, round_count, file):
        """w7 体系全部轮函数约束：初始子句 → S-box（含 w⟺p/q 等值）→ 线性层。"""
        self.write_initial_state_clause_w7(vars, file)

        for r in range(round_count):
            for sbox_idx in range(self.SBOX_COUNT):
                self.generate_sbox_constraints_w7(vars, r, sbox_idx, file)
            # 线性层输出到 xout[r]（p/q 布局输出到 s_in[r+1]）
            self.generate_shiftrows_and_mixcolumns_constraints(vars, r, file,
                                                               out_state=vars["xout"][r])

    def write_initial_state_clause_w7(self, vars, file):
        """初始状态子句：xin[0] 全正文字。"""
        clause = " ".join(str(x) for x in vars["xin"][0]) + " 0\n"
        file.write(clause)

    def generate_sbox_constraints_w7(self, vars, round_num, sbox_idx, file):
        """S-box 差分约束 + w 权重映射等值（w[0]⟺p，w[i≥1]⟺q）。"""
        xin = vars["xin"]
        sbox_out = vars["sbox_out"]
        p_var = vars["p"][round_num][sbox_idx]
        q_var = vars["q"][round_num][sbox_idx]
        w_var = vars["w"][round_num][sbox_idx]

        input_vars = [xin[round_num][sbox_idx * self.SBOX_BITS + i] for i in range(self.SBOX_BITS)]
        output_vars = [sbox_out[round_num][sbox_idx * self.SBOX_BITS + i] for i in range(self.SBOX_BITS)]

        write_sbox_clauses(self.esc_data, input_vars, output_vars, p_var, q_var, file)

        # 权重映射等值约束（w[0]⟺p、w[i≥1]⟺q）
        for i in range(self.WEIGHT_VARS_PER_SBOX):
            if i == 0:
                file.write(f"-{w_var[i]} {p_var} 0\n")
                file.write(f"{w_var[i]} -{p_var} 0\n")
            else:
                file.write(f"-{w_var[i]} {q_var} 0\n")
                file.write(f"{w_var[i]} -{q_var} 0\n")

    # ------------------------------------------------------------------
    # PLA 辅助（gf_mult / 4bit_xor，逻辑同参考 get_espresso_result_cnf）
    # ------------------------------------------------------------------

    def _gf_mult(self, file, input_vars, output_vars, times):
        """写 gf(2)/gf(3) 乘法 PLA 子句：AES_gf_x{times}_Espresso_Result.txt。"""
        path = os.path.join(self.cfg.espresso_dir(), f"AES_gf_x{times}_Espresso_Result.txt")
        write_pla_clauses(load_pla_lines(path), input_vars + output_vars, file)

    def _xor_4bit(self, file, vars):
        """写 4bit XOR PLA 子句：4bit_xor.txt（5 输入 1 输出）。"""
        path = os.path.join(self.cfg.espresso_dir(), "4bit_xor.txt")
        write_pla_clauses(load_pla_lines(path), vars, file)


class AESCipher(AESLikeCipher):
    NAME = "AES"
    STATE_BITS = 128
    WORD_BITS = 32
    SBOX_COUNT = 16
    SBOX_BITS = 8
    FULL_ROUNDS = 10
    HALF_BLOCK_WEIGHT_SIZE = 16
    SUPPORTS_W7 = True   # w7（MAP）为自行设计实现（无参考），见 AESLikeCipher 头注释
    COLUMNS = 4
    SHIFT_OFFSETS = [0, 1, 2, 3]  # ShiftRows 行偏移（转置后行序）

    # 各轮最好已知活跃 S-box 数（参考 ACTIVE_SBOX_KNOWN）
    KNOWN_ACTIVE_SBOXES = [0] + [1, 5, 9, 25, 26, 30, 34, 50, 51, 55]

    def generate_shiftrows_and_mixcolumns_constraints(self, vars, r, file, out_state=None):
        """ShiftRows + MixColumns 约束（逐字节移植参考，含 4x4 转置舞蹈）。
        out_state=None 时输出到 s_in[r+1]（p/q 布局）；w7 布局传 xout[r]。"""
        s_out = vars["s_out"] if "s_out" in vars else vars["sbox_out"]
        gf_out_x2 = vars["gf_out_x2"]
        gf_out_x3 = vars["gf_out_x3"]
        if out_state is None:
            out_state = vars["s_in"][r + 1]
        word_bits = self.WORD_BITS

        # 按行取字节 → 转置 → 行旋转 → 再转置
        data = [[s_out[r][i * word_bits + j * 8: i * word_bits + j * 8 + 8] for j in range(4)]
                for i in range(4)]
        data = [[data[j][i] for j in range(4)] for i in range(4)]
        tmp = [
            data[0],
            data[1][1:] + data[1][:1],
            data[2][2:] + data[2][:2],
            data[3][3:] + data[3][:3],
        ]
        shifted = [[tmp[j][i] for j in range(4)] for i in range(4)]

        for idx in range(4):
            tmp_data = shifted[idx]
            tmp_gf_out_x2 = [gf_out_x2[r][i * 8: (i + 1) * 8] for i in range(idx * 4, (idx + 1) * 4)]
            tmp_gf_out_x3 = [gf_out_x3[r][i * 8: (i + 1) * 8] for i in range(idx * 4, (idx + 1) * 4)]
            for i in range(4):
                self._gf_mult(file, tmp_data[i], tmp_gf_out_x2[i], 2)
                self._gf_mult(file, tmp_data[i], tmp_gf_out_x3[i], 3)
            tmp_mc_out = [out_state[i * 8: (i + 1) * 8] for i in range(idx * 4, (idx + 1) * 4)]
            for a, b, c, d, e in zip(tmp_gf_out_x2[0], tmp_gf_out_x3[1], tmp_data[2], tmp_data[3], tmp_mc_out[0]):
                self._xor_4bit(file, [a, b, c, d, e])
            for a, b, c, d, e in zip(tmp_data[0], tmp_gf_out_x2[1], tmp_gf_out_x3[2], tmp_data[3], tmp_mc_out[1]):
                self._xor_4bit(file, [a, b, c, d, e])
            for a, b, c, d, e in zip(tmp_data[0], tmp_data[1], tmp_gf_out_x2[2], tmp_gf_out_x3[3], tmp_mc_out[2]):
                self._xor_4bit(file, [a, b, c, d, e])
            for a, b, c, d, e in zip(tmp_gf_out_x3[0], tmp_data[1], tmp_data[2], tmp_gf_out_x2[3], tmp_mc_out[3]):
                self._xor_4bit(file, [a, b, c, d, e])
