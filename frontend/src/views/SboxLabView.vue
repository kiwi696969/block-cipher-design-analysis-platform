<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { go } from '@/pages.js'
import { api } from '@/api/client'
import { parseHex, bytesToHex, validateSbox } from '@/core/hex'
import { PRESETS } from '@/core/presets'
import { refreshSboxesFromServer, sboxLib, syncSboxesFromServer } from '@/stores/platform.js'

const items = ref([])
const loading = ref(true)
const listError = ref('')

/**
 * 库里哪些记录真的进了结构编辑器的 S 盒下拉（存服务端主键）。
 *
 * 与内置表内容完全相同的会被 sboxlib 去重跳过 —— 那不是缺口（画布里
 * 用同名内置项就行），所以界面上两种状态分开显示，别让用户以为同步坏了。
 */
const canvasReady = ref(new Set())

function readCanvasReady() {
  canvasReady.value = new Set(Object.values(sboxLib.server).map((b) => b.remoteId))
}

/** 增删都走同一步：列表刷新 + 重新同步前端 S 盒库 */
async function reloadAll() {
  await Promise.all([load(), refreshSboxesFromServer().then(readCanvasReady)])
}

const formOpen = ref(false)
const submitting = ref(false)
const formError = ref('')
const formOk = ref('')

/**
 * 提交/删除成功后的常驻提示。
 *
 * 必须与 `formOk` 分开：`formOk` 属于表单面板内部，而保存成功后面板会收起
 * 并 `resetForm()` 清空表单状态 —— 之前把成功文案写进 `formOk`，
 * 结果是「文案刚设好就被 resetForm 抹掉，用户根本看不到已保存」。
 */
const notice = ref('')

const form = reactive({ name: '', note: '', tableHex: '', isBuiltin: false })

/** 实时校验表单里的十六进制，把问题当场反馈给用户，而不是等后端 400。 */
const parsed = computed(() => {
  const raw = form.tableHex.trim()
  if (!raw) return { bytes: [], check: null, error: '' }
  try {
    const bytes = parseHex(raw)
    return { bytes, check: validateSbox(bytes), error: '' }
  } catch (err) {
    return { bytes: [], check: null, error: err.message }
  }
})

const canSubmit = computed(
  () => form.name.trim() !== '' && parsed.value.check?.ok === true && !submitting.value
)

async function load() {
  loading.value = true
  listError.value = ''
  try {
    const data = await api.listSboxes()
    items.value = data.results
  } catch (err) {
    listError.value = err.message
  } finally {
    loading.value = false
  }
}

function applyPreset(preset) {
  form.name = preset.name
  form.note = preset.note
  form.tableHex = preset.hex.match(/.{1,32}/g).join('\n')
  formError.value = ''
  formOk.value = ''
}

function resetForm() {
  form.name = ''
  form.note = ''
  form.tableHex = ''
  form.isBuiltin = false
  formError.value = ''
  formOk.value = ''
}

async function submit() {
  if (!canSubmit.value) return
  submitting.value = true
  formError.value = ''
  formOk.value = ''
  try {
    const payload = {
      name: form.name.trim(),
      note: form.note.trim(),
      table_hex: bytesToHex(parsed.value.bytes, ''),
      is_builtin: form.isBuiltin,
    }
    const created = await api.createSbox(payload)
    resetForm()
    formOpen.value = false
    // 顺序要紧：先 resetForm 再写 notice，反了就会被 resetForm 清掉
    notice.value = `已保存「${created.name}」（${created.size} 项），可在「结构编辑器」的 S 盒下拉里选用`
    await reloadAll()
  } catch (err) {
    formError.value = err.data?.error || err.data?.detail || err.message
  } finally {
    submitting.value = false
  }
}

async function remove(item) {
  if (!window.confirm(`确定删除「${item.name}」？该操作不可撤销。`)) return
  try {
    await api.deleteSbox(item.id)
    notice.value = `已删除「${item.name}」，画布的 S 盒下拉里也会同步移除`
    await reloadAll()
  } catch (err) {
    listError.value = `删除失败：${err.message}`
  }
}

onMounted(async () => {
  // boot.js 启动时已经拉过一次；这里 await 的只是它 —— 好读到结果再渲染那一列
  await syncSboxesFromServer()
  readCanvasReady()
  await load()
})
</script>

<template>
  <div>
    <div class="head">
      <div>
        <h2 class="section-title">S 盒实验室</h2>
        <p class="section-desc">
          导入并管理用于差分／线性分析的 S 盒。数据提交前会在浏览器端做置换性校验，
          <b>保存后会自动同步到「结构编辑器」的 S 盒下拉列表</b>。
        </p>
      </div>
      <button class="btn btn-primary" @click="formOpen = !formOpen">
        {{ formOpen ? '收起表单' : '＋ 导入 S 盒' }}
      </button>
    </div>

    <div v-if="notice" class="alert alert-ok" style="margin-bottom: 16px">{{ notice }}</div>

    <div v-if="formOpen" class="card" style="margin-bottom: 16px">
      <div class="card-head">
        <h2>导入新 S 盒</h2>
        <span class="hint">也可直接从参考值填充</span>
      </div>
      <div class="card-body">
        <div class="presets">
          <span class="muted" style="font-size: 12.5px">参考值：</span>
          <button v-for="p in PRESETS" :key="p.name" class="btn btn-sm" @click="applyPreset(p)">
            {{ p.name }}
          </button>
        </div>

        <div class="form-grid">
          <div class="field">
            <label for="f-name">名称</label>
            <input id="f-name" v-model="form.name" class="input" placeholder="例如 SM4-Sbox" />
          </div>
          <div class="field">
            <label for="f-note">备注</label>
            <input id="f-note" v-model="form.note" class="input" placeholder="选填" />
          </div>
        </div>

        <div class="field">
          <label for="f-table">查找表（十六进制）</label>
          <textarea
            id="f-table"
            v-model="form.tableHex"
            class="textarea"
            rows="8"
            spellcheck="false"
            placeholder="d6 90 e9 fe cc e1 3d b7 …&#10;支持空格、逗号、换行、0x 前缀作为分隔"
          ></textarea>
          <div class="tip">
            <template v-if="parsed.error">
              <span style="color: var(--err)">✕ {{ parsed.error }}</span>
            </template>
            <template v-else-if="parsed.check && parsed.check.ok">
              <span style="color: var(--ok)">
                ✓ 解析出 {{ parsed.bytes.length }} 项，构成置换，可提交
              </span>
            </template>
            <template v-else-if="parsed.check">
              <span style="color: var(--err)">✕ {{ parsed.check.errors.join('；') }}</span>
            </template>
            <template v-else> 长度需为 2 的幂（16 / 256），且取值必须是置换 </template>
          </div>
          <div v-if="parsed.check?.warnings?.length" class="tip" style="color: var(--warn)">
            ⚠ {{ parsed.check.warnings.join('；') }}
          </div>
        </div>

        <label class="checkbox">
          <input v-model="form.isBuiltin" type="checkbox" />
          <span>标记为内置（仅供筛选用，不影响计算）</span>
        </label>

        <div v-if="formError" class="alert alert-err" style="margin: 12px 0">
          {{ formError }}
        </div>

        <div class="row" style="margin-top: 14px">
          <button class="btn btn-primary" :disabled="!canSubmit" @click="submit">
            {{ submitting ? '提交中…' : '保存' }}
          </button>
          <button class="btn" @click="resetForm">清空</button>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <h2>已存 S 盒</h2>
        <span class="hint">{{ loading ? '加载中…' : `共 ${items.length} 条` }}</span>
      </div>

      <div v-if="listError" class="card-body">
        <div class="alert alert-err">{{ listError }}</div>
      </div>

      <div v-else-if="!loading && items.length === 0" class="empty">
        还没有数据。点右上角「导入 S 盒」，或用参考值一键填充 SM4 / AES / PRESENT 的 S 盒。
      </div>

      <table v-else class="table">
        <thead>
          <tr>
            <th style="width: 60px">ID</th>
            <th>名称</th>
            <th style="width: 100px">规模</th>
            <th style="width: 110px">数据长度</th>
            <th style="width: 90px">来源</th>
            <th style="width: 110px">画布</th>
            <th style="width: 150px"></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in items" :key="item.id">
            <td class="num">{{ item.id }}</td>
            <td>
              <a href="#" @click.prevent="go('sbox-detail', { id: item.id })">{{ item.name }}</a>
            </td>
            <td class="num">{{ item.size }} 项</td>
            <td class="num">{{ item.table_hex_len }} hex 字符</td>
            <td>
              <span class="tag" :class="item.is_builtin ? 'tag-accent' : ''">
                {{ item.is_builtin ? '内置' : '自定义' }}
              </span>
            </td>
            <td>
              <span
                v-if="canvasReady.has(item.id)"
                class="tag tag-ok"
                title="已同步进前端 S 盒库，结构编辑器的 S 盒下拉里可以选到它"
              >画布可选</span>
              <span
                v-else
                class="tag"
                title="内容与某个内置 S 盒完全相同，画布下拉里用同名的内置项即可"
              >同内置</span>
            </td>
            <td>
              <div class="row">
                <button class="btn btn-sm" @click="go('sbox-detail', { id: item.id })">查看</button>
                <button class="btn btn-sm btn-danger" @click="remove(item)">删除</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.presets {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 16px;
  padding-bottom: 14px;
  border-bottom: 1px dashed var(--border);
}

.form-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 0 16px;
}

.checkbox {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--text-muted);
  cursor: pointer;
}

.tip {
  margin-top: 5px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-faint);
}
</style>
