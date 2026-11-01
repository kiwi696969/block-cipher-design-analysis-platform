<script setup>
import { computed, onMounted, ref } from 'vue'
import { go } from '@/pages.js'
import { api } from '@/api/client'
import { parseHex, toMatrix, validateSbox, bytesToHex } from '@/core/hex'
import { SBox } from '@/core/sbox.js'
import HeatmapGrid from '@/components/HeatmapGrid.vue'
import MetricCard from '@/components/MetricCard.vue'

// 多页形态下 id 由入口脚本从地址栏解析后作为 prop 传进来（见 src/entries/sbox-detail.js）
const props = defineProps({
  id: { type: [String, Number], required: true },
})

const item = ref(null)
const bytes = ref([])
const error = ref('')
const loading = ref(true)

const cols = computed(() => (bytes.value.length > 16 ? 16 : 4))
const matrix = computed(() => toMatrix(bytes.value, cols.value))

/** 位宽：4（PRESENT 这类）或 8（SM4/AES 这类） */
const bits = computed(() => {
  const n = bytes.value.length
  return n > 0 && (n & (n - 1)) === 0 ? Math.log2(n) : 0
})

/** 坐标的十六进制位数 */
const hexWidth = computed(() => (bits.value === 4 ? 1 : 2))

/**
 * 分析对象。取不到就返回 null —— DDT/LAT 只在"取值确实落在 4/8 bit 值域内"
 * 时才有意义，长度不是 2 的幂、或元素超出值域时宁可整块不显示，
 * 也不要拿一段含糊的数据算出一组看起来很像回事的指标。
 */
const box = computed(() => {
  const b = bits.value
  if (!b) return null
  if (bytes.value.some((v) => v >= 1 << b)) return null
  const sb = new SBox(bytes.value.slice(), b, b, item.value?.name || 'SBox')
  // 大盒（如 16×16，全表 DDT 为 65536×65536 ≈ 4.3G cell）建不起全表 →
  // 整块指标不显示，也不要让 computed 抛异常把页面带崩（见 sbox.js 的 SBOX_TABLE_CAP）。
  if (!sb.fullTableFeasible()) return null
  return sb
})

const du = computed(() => box.value?.differentialUniformity() || null)
const linearity = computed(() => box.value?.linearity() || null)
const nonlinearity = computed(() => (box.value ? box.value.nonlinearity() : null))
const branch = computed(() => box.value?.diffBranchNumber() || null)
const ddt = computed(() => box.value?.getDDT() || null)
const lat = computed(() => box.value?.getLAT() || null)

/** diffBranchNumber 在"除平凡项外 DDT 全为 0"时会返回哨兵值 1<<30 */
const branchText = computed(() => {
  const v = branch.value?.value
  return v == null || v >= 1 << 30 ? '—' : v
})

const hexAt = (v) => '0x' + Number(v).toString(16).toUpperCase().padStart(hexWidth.value, '0')

const stats = computed(() => {
  if (!bytes.value.length) return []
  const check = validateSbox(bytes.value)
  const fixed = bytes.value.filter((v, i) => v === i).length
  return [
    ['规模', `${bytes.value.length} 项`],
    ['位宽', `${bits.value} bit`],
    ['是否置换', check.isPermutation ? '是（双射）' : '否'],
    ['不动点 S(x)=x', `${fixed} 个`],
    ['S(0)', `0x${(bytes.value[0] ?? 0).toString(16).padStart(2, '0')}`],
  ]
})

const check = computed(() => (bytes.value.length ? validateSbox(bytes.value) : null))

/* ------------------------------------------------------------ 导出代码 */

const exportLang = ref('c')
const exportText = computed(() => (box.value ? box.value.exportCode(exportLang.value) : ''))
const copied = ref(false)

async function copyExport() {
  if (!exportText.value) return
  try {
    await navigator.clipboard.writeText(exportText.value)
    copied.value = true
    setTimeout(() => { copied.value = false }, 1600)
  } catch {
    // 剪贴板在非安全上下文会被拒 —— 下方文本框可以直接手动全选复制
    copied.value = false
  }
}

onMounted(async () => {
  try {
    const data = await api.getSbox(props.id)
    item.value = data
    bytes.value = parseHex(data.table_hex)
  } catch (err) {
    error.value = err.status === 404 ? '该 S 盒不存在（可能已被删除）' : err.message
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <div>
    <button class="btn btn-sm" style="margin-bottom: 16px" @click="go('sbox')">
      ← 返回列表
    </button>

    <div v-if="loading" class="muted">加载中…</div>

    <div v-else-if="error" class="alert alert-err">{{ error }}</div>

    <template v-else-if="item">
      <h2 class="section-title">{{ item.name }}</h2>
      <p class="section-desc">{{ item.note || '（无备注）' }}</p>

      <div v-if="box" class="card">
        <div class="card-head">
          <h2>安全指标</h2>
          <span class="hint">全部实时计算，不落库</span>
        </div>
        <div class="card-body">
          <div class="metrics-grid">
            <MetricCard
              label="差分均匀度 DU"
              :value="du.value"
              hint="DDT 中除平凡项外的最大值。越小越好，4 bit 盒理论下界为 4"
              :sub="`DDT[${hexAt(du.inputDiff)}][${hexAt(du.outputDiff)}]`"
              color="var(--accent)"
            />
            <MetricCard
              label="非线性度 NL"
              :value="nonlinearity"
              hint="= 2^(n−1) − 线性度。越大说明离仿射函数越远，8 bit 盒上限为 120"
              :sub="`2^${bits - 1} − ${linearity.value}`"
              color="var(--violet)"
            />
            <MetricCard
              label="线性度"
              :value="linearity.value"
              hint="LAT 中除平凡项外的最大绝对值。越小越好"
              :sub="`|LAT|[${hexAt(linearity.inputMask)}][${hexAt(linearity.outputMask)}]`"
              color="var(--cyan)"
            />
            <MetricCard
              label="差分分支数"
              :value="branchText"
              hint="使 DDT 非零的 (Δin, Δout) 中，汉明重量之和的最小值"
              :sub="branchText === '—' ? '除平凡项外无非零项' : `${hexAt(branch.inputDiff)} → ${hexAt(branch.outputDiff)}`"
              color="var(--amber)"
            />
          </div>
          <div v-if="check && !check.ok" class="alert alert-err small" style="margin-top: 14px">
            {{ check.errors.join('；') }}
          </div>
          <div v-else-if="check && check.warnings.length" class="alert alert-warn small" style="margin-top: 14px">
            {{ check.warnings.join('；') }}
          </div>
        </div>
      </div>

      <div v-else class="alert alert-warn">
        这份数据不构成可分析的 S 盒（长度须为 2 的幂、取值须落在 <code>0 … 2^n−1</code> 内），
        因此 DDT / LAT 与安全指标不予计算。
      </div>

      <div class="card">
        <div class="card-head">
          <h2>基本属性</h2>
          <span class="tag" :class="item.is_builtin ? 'tag-accent' : ''">
            {{ item.is_builtin ? '内置' : '自定义' }}
          </span>
        </div>
        <div class="card-body">
          <div class="kv">
            <div v-for="[k, v] in stats" :key="k" class="kv-item">
              <span class="kv-key">{{ k }}</span>
              <span class="kv-val mono">{{ v }}</span>
            </div>
          </div>
        </div>
      </div>

      <div v-if="box" class="card">
        <div class="card-head">
          <h2>差分分布表 DDT</h2>
          <span class="hint">行 = 输入差分 Δin，列 = 输出差分 Δout；计数 = #&#123;x : S(x)⊕S(x⊕Δin) = Δout&#125;</span>
        </div>
        <div class="card-body">
          <HeatmapGrid
            :matrix="ddt"
            kind="ddt"
            :hex-width="hexWidth"
            :highlight="{ row: du.inputDiff, col: du.outputDiff }"
          />
          <p class="small muted" style="margin-top: 12px">
            琥珀色框标出最大项 <span class="mono">DDT[{{ hexAt(du.inputDiff) }}][{{ hexAt(du.outputDiff) }}] = {{ du.value }}</span>。
            第 0 行与第 0 列是平凡项，未计入色阶 —— 否则真正的差异会被压成一片空白。
            差分概率 = 计数 ÷ {{ bytes.length }}，本盒最好的一条差分特征概率为
            <span class="mono">{{ (du.value / bytes.length).toFixed(6) }}</span>。
          </p>
        </div>
      </div>

      <div v-if="box" class="card">
        <div class="card-head">
          <h2>线性逼近表 LAT</h2>
          <span class="hint">行 = 输入掩码 a，列 = 输出掩码 b；LAT[a][b] = #&#123;x : a·x = b·S(x)&#125; − 2^(n−1)</span>
        </div>
        <div class="card-body">
          <HeatmapGrid
            :matrix="lat"
            kind="lat"
            :hex-width="hexWidth"
            :highlight="{ row: linearity.inputMask, col: linearity.outputMask }"
          />
          <p class="small muted" style="margin-top: 12px">
            色阶取的是 <span class="mono">|LAT|</span>（该表有正有负，看的是相关强度）。
            琥珀色框标出最大项
            <span class="mono">|LAT|[{{ hexAt(linearity.inputMask) }}][{{ hexAt(linearity.outputMask) }}] = {{ linearity.value }}</span>，
            对应相关系数 <span class="mono">{{ (linearity.value / (1 << (bits - 1))).toFixed(4) }}</span>、
            偏差 <span class="mono">{{ (linearity.value / (1 << bits)).toFixed(4) }}</span>。
          </p>
        </div>
      </div>

      <div v-if="box" class="card">
        <div class="card-head">
          <h2>导出为代码</h2>
          <span class="hint">可直接粘进 C 实现或 Python 脚本</span>
        </div>
        <div class="card-body">
          <div class="export-bar">
            <select v-model="exportLang" class="select">
              <option value="c">C（uint8_t 数组）</option>
              <option value="python">Python 列表</option>
              <option value="json">JSON</option>
            </select>
            <button class="btn btn-sm" @click="copyExport">
              {{ copied ? '已复制' : '复制' }}
            </button>
          </div>
          <textarea class="textarea mono" rows="10" readonly :value="exportText"></textarea>
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <h2>真值表</h2>
          <span class="hint">
            行首为输入高{{ cols === 16 ? '半字节' : '位' }}，列为低{{ cols === 16 ? '半字节' : '位' }}
          </span>
        </div>
        <div class="card-body">
          <div class="grid-wrap">
            <table class="sbox-grid">
              <thead>
                <tr>
                  <th class="corner"></th>
                  <th v-for="c in cols" :key="c" class="col-head">
                    {{ (c - 1).toString(16).toUpperCase() }}
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(row, i) in matrix" :key="i">
                  <th class="row-head">{{ (i * cols).toString(16).padStart(2, '0').toUpperCase() }}</th>
                  <td v-for="(cell, j) in row" :key="j" class="cell">{{ cell.toUpperCase() }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <h2>原始数据</h2>
          <span class="hint">{{ bytesToHex(bytes, '').length }} 个 hex 字符</span>
        </div>
        <div class="card-body">
          <textarea class="textarea" rows="8" readonly :value="bytesToHex(bytes, '')"></textarea>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.metrics-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
  gap: 12px;
}

.kv {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px 24px;
}

.kv-item {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  padding-bottom: 8px;
  border-bottom: 1px dashed var(--border);
}

.kv-key {
  color: var(--text-muted);
  font-size: 12.5px;
}

.kv-val {
  font-size: 13px;
  font-weight: 550;
}

.export-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}

.export-bar .select {
  width: auto;
  min-width: 180px;
}

.grid-wrap {
  overflow-x: auto;
}

.sbox-grid {
  border-collapse: collapse;
  font-family: var(--mono);
  font-size: 11.5px;
}

.sbox-grid th,
.sbox-grid td {
  width: 30px;
  height: 26px;
  text-align: center;
  border: 1px solid var(--border);
}

.col-head,
.row-head,
.corner {
  background: var(--surface-2);
  color: var(--text-faint);
  font-weight: 600;
  font-size: 10.5px;
}

.cell {
  color: var(--text);
  background: var(--surface);
}

.cell:hover {
  background: var(--accent-soft);
  color: var(--accent-hover);
}
</style>
