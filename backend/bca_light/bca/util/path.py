"""
SAT 解 → 差分路径提取（details/path/ 完善）。

kissat 解是带符号 var id 列表（正=true）。vars 字典已按变量名分好组
（变量 id 顺序同参考实现），直接把每个 var id 查赋值表即可解码，
无需再经 IDPool 映射变量名。

支持的变量布局（键结构各算法不同，按存在性自动识别）：
- SM4 pq（r_in）：状态 = r_in[r] 尾词（WORD_BITS 位）；S-box 输入 s_in、
  输出 s_out；终态 r_in[round_count]（完整状态）
- SM4 w7（xin + xor_out）：状态 = xin[r]（完整状态）；输入 xor_out（Feistel
  3-XOR 输出）、输出 sbox_out；终态 xout[round_count-1]
- AES/Rijndael w7（xin，无 xor_out）：SPN 结构无 Feistel 3-XOR，S-box 输入
  直接取 xin 字节切片；输出 sbox_out；终态 xout[round_count-1]
- AES/Rijndael pq（s_in）：状态 = s_in[r]（完整状态）；S-box 输入/输出均为
  s_in/s_out 的字节切片；终态 s_in[round_count]
- DBlock pq/w7（x_state）：S-box 输入由状态经 P_n(reverse(x_state[r+1]))
  置换得到（同轮函数约束的字节组织）；终态 x_state[round_count+1]

输出：每轮 状态 + 每 S-box (p, q, 输入差, 输出差) + 活跃 S-box 列表。
"""


def extract_rounds(model, vars, round_count, cipher):
    """SAT 解（带符号 var id 列表）→ (每轮路径 dict 列表, 终态 hex 串)。"""
    assign = {abs(v): v > 0 for v in (model or [])}

    def val(var):
        return 1 if assign.get(var, False) else 0

    def bits_hex(vlist, width=None):
        num = 0
        for i, b in enumerate(vlist):
            num |= (b & 1) << i
        return "0x%0*X" % (width or max(1, (len(vlist) + 3) // 4), num)

    def words_hex(vlist):
        wb = cipher.WORD_BITS
        return " ".join(bits_hex(vlist[w * wb:(w + 1) * wb], wb // 4)
                        for w in range((len(vlist) + wb - 1) // wb))

    wb, sb, sc = cipher.WORD_BITS, cipher.SBOX_BITS, cipher.SBOX_COUNT

    # 布局识别：状态键 / S-box 输入键 / 输出键 / 终态来源
    if "r_in" in vars:
        state_key, in_key, out_key = "r_in", "s_in", "s_out"
        final_key, final_idx = "r_in", round_count
    elif "xin" in vars:
        if "xor_out" in vars:  # SM4 w7：S-box 输入 = Feistel 3-XOR 输出
            state_key, in_key, out_key = "xin", "xor_out", "sbox_out"
        else:  # AES/Rijndael w7：S-box 输入直接取 xin（SPN 无 3-XOR）
            state_key, in_key, out_key = "xin", "xin", "sbox_out"
        final_key, final_idx = "xout", round_count - 1
    elif "s_in" in vars:
        state_key, in_key, out_key = "s_in", "s_in", "s_out"
        final_key, final_idx = "s_in", round_count
    else:  # DBlock：x_state，输入经 P_n(reverse(x_state[r+1])) 置换
        state_key, in_key, out_key = "x_state", None, "s_out"
        final_key, final_idx = "x_state", round_count + 1
        perm = cipher.P_PERMUTATION

    rounds = []
    for r in range(round_count):
        sboxes = []
        for i in range(sc):
            if in_key is not None:
                in_bits = [val(v) for v in vars[in_key][r][i * sb:(i + 1) * sb]]
            else:  # DBlock：输入字节 = x_state[r+1] 第 (sc-1-P[i]) 字节
                src = vars["x_state"][r + 1]
                start = (sc - 1 - perm[i]) * sb
                in_bits = [val(v) for v in src[start:start + sb]]
            out_bits = [val(v) for v in vars[out_key][r][i * sb:(i + 1) * sb]]
            sboxes.append({
                "p": val(vars["p"][r][i]),
                "q": val(vars["q"][r][i]),
                "din": bits_hex(in_bits, sb // 4),
                "dout": bits_hex(out_bits, sb // 4),
            })
        rounds.append({
            "round": r + 1,
            "state": words_hex([val(v) for v in vars[state_key][r]]),
            "sboxes": sboxes,
            "active": [i for i, s in enumerate(sboxes) if s["q"]],
        })

    final_hex = words_hex([val(v) for v in vars[final_key][final_idx]])
    return rounds, final_hex


def format_path(rounds, final_state):
    """每轮路径 dict 列表 → 可读文本。"""
    lines = []
    for e in rounds:
        lines.append(f"Round {e['round']}:")
        lines.append(f"  state = {e['state']}")
        for i, s in enumerate(e["sboxes"]):
            lines.append(f"  sbox {i}: p={s['p']} q={s['q']}  in={s['din']} out={s['dout']}")
        lines.append(f"  active = {e['active']}")
    lines.append(f"final state = {final_state}")
    return "\n".join(lines) + "\n"
