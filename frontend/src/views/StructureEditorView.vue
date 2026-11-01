<script setup>
/**
 * 拖拽式轮函数结构编辑器。
 *
 * 交互模型：
 *   · 左侧组件面板：拖到画布 = 新增节点（HTML5 原生 DnD，零依赖）
 *   · 画布节点：按住拖动 = 移动位置；点选中 = 右侧改属性
 *   · 连线：先点一个输出端口（变蓝），再点目标输入端口 = 建立连接
 *   · 右侧属性面板：按 NODE_TYPES 里的 props 定义动态渲染控件
 *   · 底部中文解析：来自 core/explain.js，逐组件说明"它在差分分析里干什么"
 *
 * ⚠️ 响应式陷阱：store 里的 graph 是 shallowRef 包的一个 class 实例，
 *    改 node.x / push 一条边**不会**触发更新（实例内部不是响应式的）。
 *    所以每次改动都要 bump() 一下 rev，让依赖它的 computed 重新求值。
 *    忘记 bump 的症状：拖动后节点不跟着动（但数据其实已经改了）。
 */
import { computed, reactive, ref } from 'vue'
import { href } from '@/pages.js'

import {
  NODE_TYPES, CATEGORY_LABELS, NODE_W, NODE_H, HEADER_H, BODY_H,
  graphBlockBits, graphBlockSize,
} from '@/core/graph.js'
import {
  graph, selectedNodeId, templateId, sboxLib, sboxRev, log,
  loadTemplate, setGraph, explanation, clearResult, bumpGraph,
} from '@/stores/platform.js'
import { explainGraph } from '@/core/explain.js'
import { STRUCTURE_LABELS, UNSUPPORTED_STRUCTURES } from '@/core/params.js'
import { TEMPLATES, USER_TEMPLATE_IDS } from '@/core/graph.js'
import ExplainPanel from '@/components/ExplainPanel.vue'
import FoldPanel from '@/components/FoldPanel.vue'

/* ---------------------------------------------------------------- 响应式刷新计数 */

const rev = ref(0)
function bump() {
  rev.value++
  bumpGraph() // 同时通知 store：所有从 graph 派生的 computed（解析文案 / 建模规模…）都作废
  clearResult() // 结构变了，旧结果就不对应了 —— 必须清掉，否则指标和结构对不上
}

const nodes = computed(() => {
  rev.value
  return [...graph.value.nodes]
})
const edges = computed(() => {
  rev.value
  return [...graph.value.edges]
})

/* ---------------------------------------------------------------- 组件面板 */

const palette = computed(() =>
  Object.entries(NODE_TYPES).map(([type, def]) => ({
    type,
    ...def,
    propsCount: def.props.length,
  }))
)

const grouped = computed(() => {
  const out = {}
  for (const it of palette.value) {
    if (!out[it.category]) out[it.category] = []
    out[it.category].push(it)
  }
  return out
})

/* ---------------------------------------------------------------- 画布尺寸 */

const PAD_R = 60
const PAD_B = 60

const canvasSize = computed(() => {
  rev.value
  let w = 620
  let h = 420
  for (const n of graph.value.nodes) {
    w = Math.max(w, n.x + NODE_W + PAD_R)
    h = Math.max(h, n.y + NODE_H + PAD_B)
  }
  return { width: w, height: h }
})

/* ---------------------------------------------------------------- 拖拽新增 */

const dragging = ref(false)

function onPaletteDragStart(e, type) {
  e.dataTransfer.setData('text/x-node-type', type)
  e.dataTransfer.effectAllowed = 'copy'
  dragging.value = true
}

function onDragEnd() {
  dragging.value = false
}

function onCanvasDrop(e) {
  e.preventDefault()
  dragging.value = false
  const type = e.dataTransfer.getData('text/x-node-type')
  if (!type || !NODE_TYPES[type]) return

  const rect = e.currentTarget.getBoundingClientRect()
  // 减掉半个节点宽高，让鼠标落在节点中心
  const x = Math.max(0, Math.round(e.clientX - rect.left - NODE_W / 2))
  const y = Math.max(0, Math.round(e.clientY - rect.top - NODE_H / 2))

  const node = graph.value.addNode(type, x, y)
  selectedNodeId.value = node.id
  bump()
  log('info', `新增组件：${NODE_TYPES[type].label}（${type}）@ (${x}, ${y}）`)
}

/* ---------------------------------------------------------------- 拖动节点 */

const dragState = reactive({ id: '', dx: 0, dy: 0, moved: false })

function onNodeMouseDown(e, node) {
  // 端口上的按下另有用途（连线），不要触发移动
  if (e.target.classList.contains('port')) return
  const rect = e.currentTarget.getBoundingClientRect()
  dragState.id = node.id
  dragState.dx = e.clientX - rect.left
  dragState.dy = e.clientY - rect.top
  dragState.moved = false
  selectedNodeId.value = node.id

  window.addEventListener('mousemove', onNodeMouseMove)
  window.addEventListener('mouseup', onNodeMouseUp)
  e.preventDefault()
}

function onNodeMouseMove(e) {
  if (!dragState.id) return
  const canvas = document.getElementById('canvas-inner')
  if (!canvas) return
  const rect = canvas.getBoundingClientRect()
  const node = graph.value.getNode(dragState.id)
  if (!node) return
  const x = Math.max(0, Math.round(e.clientX - rect.left - dragState.dx))
  const y = Math.max(0, Math.round(e.clientY - rect.top - dragState.dy))
  if (x !== node.x || y !== node.y) {
    node.x = x
    node.y = y
    dragState.moved = true
    rev.value++
  }
}

function onNodeMouseUp() {
  dragState.id = ''
  window.removeEventListener('mousemove', onNodeMouseMove)
  window.removeEventListener('mouseup', onNodeMouseUp)
}

/* ---------------------------------------------------------------- 连线 */

const pendingFrom = ref(null) // {nodeId, portId}

function onPortClick(e, node, port, isInput) {
  e.stopPropagation()
  selectedNodeId.value = node.id

  if (isInput) {
    if (!pendingFrom.value) {
      log('warn', '请先点击「输出端口」（节点右侧的圆点）作为连线起点')
      return
    }
    if (pendingFrom.value.nodeId === node.id) {
      log('warn', '不能把节点连到自己')
      pendingFrom.value = null
      return
    }
    const from = graph.value.getNode(pendingFrom.value.nodeId)
    const edge = graph.value.addEdge(
      pendingFrom.value.nodeId, pendingFrom.value.portId, node.id, port.id,
    )
    if (edge) {
      log('info', `连线：${from ? NODE_TYPES[from.type].label : '?'}.${pendingFrom.value.portId}`
        + ` → ${NODE_TYPES[node.type].label}.${port.id}`)
    }
    pendingFrom.value = null
    bump()
    return
  }

  // 点输出端口：设为起点（再点一次取消）
  if (pendingFrom.value && pendingFrom.value.nodeId === node.id && pendingFrom.value.portId === port.id) {
    pendingFrom.value = null
    return
  }
  pendingFrom.value = { nodeId: node.id, portId: port.id }
}

/* ---------------------------------------------------------------- 选中与编辑 */

const selected = computed(() => {
  rev.value
  return selectedNodeId.value ? graph.value.getNode(selectedNodeId.value) : null
})

const selectedDef = computed(() => (selected.value ? NODE_TYPES[selected.value.type] : null))

/** 按 NODE_TYPES 里的 props 定义渲染控件，不硬编码任何字段 */
const propFields = computed(() => {
  // ⚠️ 必须显式读 rev：`selected` 每次都返回**同一个节点对象**（属性是就地改的），
  //    Vue 的 hasChanged 认为没变，就不会把这次失效往下传给 propFields ——
  //    结果是「画布上换了 S 盒，右侧下拉框却弹回旧值」（实测复现过）。
  rev.value
  // 同理，`sboxLib.list()` 不是响应式的：服务端 S 盒镜像晚到时
  // （boot.js 的 2s 上限过了才落地）靠它触发重算，否则下拉里少那些盒子。
  sboxRev.value
  const def = selectedDef.value
  const node = selected.value
  if (!def || !node) return []
  return def.props.map((p) => ({
    ...p,
    // ★ 把「这个字段属于哪个节点」钉进描述符。
    //   不能依赖 `selected.value`：原生 change 是**失焦时**才发，而失焦发生在
    //   新节点 mousedown（选中已切走）之后 —— 于是「改完 A 的属性、直接点 B」
    //   会把 A 字段的值写进 B 的 props（实测：改「输入明文」的分块数，
    //   结果落到「分支/分块」上，INPUT 一点没变）。带上 nodeId 就与选中状态无关了。
    nodeId: node.id,
    value: node.props[p.key],
    sboxOptions: p.type === 'sbox' ? sboxLib.list() : null,
  }))
})

function setProp(key, value, nodeId = null) {
  // 写入目标优先用字段自带的 nodeId（见 propFields 里的说明），
  // 没有才退回当前选中 —— 后者只在「按选中节点直接改」的调用里才对。
  const node = nodeId ? graph.value.getNode(nodeId) : selected.value
  if (!node) {
    log('warn', '目标节点已不在画布上，这次修改被丢弃')
    return
  }
  node.props[key] = value
  // 改「输入明文」的位宽 / 分块数会改变分组长度 —— 立刻同步，别让两者打架
  if (node.type === 'INPUT') syncBlockSize()
  bump()
}

function onPropInput(field, value) {
  let v = value
  if (field.type === 'number') {
    v = Math.round(Number(value))
    if (!Number.isFinite(v)) v = field.default
    if (field.min !== undefined) v = Math.max(field.min, v)
    if (field.max !== undefined) v = Math.min(field.max, v)
  } else if (field.type === 'boolean') {
    v = !!value
  }
  setProp(field.key, v, field.nodeId)
  const owner = field.nodeId ? graph.value.getNode(field.nodeId) : null
  const label = owner ? NODE_TYPES[owner.type].label : '(未知节点)'
  log('debug', `修改属性 ${label}.${field.label} = ${v}`)
}

function deleteSelected() {
  const node = selected.value
  if (!node) return
  const label = NODE_TYPES[node.type].label
  graph.value.removeNode(node.id)
  // 顺便清掉以它为一端的待定连线
  if (pendingFrom.value?.nodeId === node.id) pendingFrom.value = null
  selectedNodeId.value = ''
  bump()
  log('info', `删除组件：${label}`)
}

function deleteEdge(id) {
  graph.value.removeEdge(id)
  bump()
  log('info', '删除一条连线')
}

function clearCanvas() {
  if (!window.confirm('清空画布上的全部节点与连线？（可通过重新载入模板恢复）')) return
  graph.value.nodes = []
  graph.value.edges = []
  selectedNodeId.value = ''
  pendingFrom.value = null
  bump()
  log('warn', '画布已清空')
}

/**
 * 点画布空白处 = 取消选中，回到右侧的「算法元信息」面板。
 *
 * 为什么必须有：属性面板和元信息面板是**同一个 card 里的二选一**
 * （`v-if="!selected"`）。没有取消入口时，只要点过任何一个节点，
 * 「结构类型」「分组长度」就再也回不去了 —— 除非把节点删掉或清空画布。
 */
function deselect() {
  if (!selectedNodeId.value && !pendingFrom.value) return
  selectedNodeId.value = ''
  pendingFrom.value = null
}

function resetTemplate() {
  loadTemplate(templateId.value)
  syncBlockSize()
  bump()
  log('info', '已恢复到模板初始结构')
}

/* ---------------------------------------------------------------- 校验 */

const validation = computed(() => {
  rev.value
  try {
    const r = graph.value.validate?.()
    if (Array.isArray(r)) return { ok: r.length === 0, issues: r }
    if (r && typeof r === 'object') return { ok: r.ok !== false, issues: r.issues || r.errors || [] }
    return { ok: true, issues: [] }
  } catch (err) {
    return { ok: false, issues: [err.message] }
  }
})

/* ---------------------------------------------------------------- 边渲染 */

function edgePath(edge) {
  const a = graph.value.getNode(edge.from)
  const b = graph.value.getNode(edge.to)
  if (!a || !b) return ''
  const p1 = a.portPos(edge.fromPort, false)
  const p2 = b.portPos(edge.toPort, true)
  const dx = Math.max(28, Math.abs(p2.x - p1.x) * 0.45)
  return `M${p1.x},${p1.y} C${p1.x + dx},${p1.y} ${p2.x - dx},${p2.y} ${p2.x},${p2.y}`
}

function edgeMid(edge) {
  const a = graph.value.getNode(edge.from)
  const b = graph.value.getNode(edge.to)
  if (!a || !b) return { x: 0, y: 0 }
  const p1 = a.portPos(edge.fromPort, false)
  const p2 = b.portPos(edge.toPort, true)
  return { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 }
}

/* ---------------------------------------------------------------- 解析面板 */

const explainItems = computed(() => {
  const e = explanation.value
  if (!e) return []
  return e.paragraphs.map((p) => ({ h: p.h, p: p.p }))
})

const components = computed(() => explanation.value?.components || [])

const metaFields = computed(() => {
  rev.value // ← 同上：meta 是就地改的，不读 rev 改完不回显
  return [
    { k: 'name', label: '算法名称' },
    { k: 'standard', label: '标准来源' },
    { k: 'keySize', label: '密钥长度' },
    { k: 'rounds', label: '总轮数' },
  ]
})

/**
 * ★「结构类型」从前**界面上根本没有入口** —— 它只由 `graph.js` 的模板构建器写入。
 * 后果：用户手搭的 Feistel 永远带着 `spn` 标记 ——
 *   · 中文解析把它定性成「SPN：每轮对整个状态做 S 盒代换」，与画布上的图直接矛盾；
 *   · 引擎按 SPN 的单趟传播去算，不做左右分支迭代，「交叉」无从体现。
 * 现在它是一个可选字段，选什么就按什么算。
 */
const structureOptions = computed(() => STRUCTURE_LABELS)
const structure = computed(() => {
  rev.value
  const s = graph.value?.meta?.structure
  return STRUCTURE_LABELS[s] ? s : 'spn'
})

/**
 * 图标记的结构类型在模型里认得、但**没有引擎**（只可能来自导入的 JSON）。
 * 这种时候必须明说「按 SPN 算」，不能让它变成一个改了也没用的下拉项。
 */
const unsupportedStructure = computed(() => {
  rev.value
  const s = graph.value?.meta?.structure
  return UNSUPPORTED_STRUCTURES[s] || ''
})

/**
 * 分组长度不再是可以随手填的数字，而是从 INPUT 节点派生（位宽 × 分块数），
 * 免得出现「meta 写着 64bit、引擎按 32bit 算」的自相矛盾。
 * 想改分组长度 → 改「输入明文」节点，它才是真源头。
 */
const blockBits = computed(() => {
  rev.value
  return graphBlockBits(graph.value)
})
const blockSize = computed(() => {
  rev.value
  return graphBlockSize(graph.value)
})
const inputBlocks = computed(() => {
  rev.value
  const inp = graph.value?.nodes?.find((n) => n.type === 'INPUT')
  const n = Math.round(Number(inp?.props?.blocks))
  return Number.isFinite(n) && n >= 1 ? n : 1
})

/** 让 meta.blockSize 始终跟着画布上的 INPUT 走（导出与中文解析都读它） */
function syncBlockSize() {
  const m = graph.value?.meta
  if (!m) return
  const n = graphBlockSize(graph.value)
  if (m.blockSize !== n) m.blockSize = n
}

function setMeta(key, value) {
  const m = graph.value.meta
  if (!m) return
  if (key === 'structure') {
    m.structure = STRUCTURE_LABELS[value] ? value : 'spn'
  } else {
    m[key] = key === 'rounds' || key.endsWith('Size') ? Math.max(1, Math.round(Number(value)) || 1) : value
  }
  bump()
}

// 与算法选择页共用同一份清单（USER_TEMPLATE_IDS），避免两边选项不一致
const templates = computed(() =>
  USER_TEMPLATE_IDS.filter((id) => TEMPLATES[id]).map((id) => ({ id, name: TEMPLATES[id].name })),
)

function onTemplateChange(e) {
  loadTemplate(e.target.value)
  syncBlockSize()
  bump()
}
</script>

<template>
  <div class="page">
    <div class="head">
      <div>
        <h2 class="section-title">轮函数结构编辑器</h2>
        <p class="section-desc">
          平台按<b>这张图</b>去算差分/线性传播，不是拿一份写死的算法 ——
          改动会立即反映到分析页。
        </p>
      </div>
      <div class="row-wrap">
        <select class="select" style="width: 190px" :value="templateId" @change="onTemplateChange">
          <option v-for="t in templates" :key="t.id" :value="t.id">{{ t.name }}</option>
        </select>
        <button class="btn btn-sm" @click="resetTemplate">恢复模板</button>
        <button class="btn btn-sm btn-danger" @click="clearCanvas">清空</button>
        <a :href="href('differential')" class="btn btn-sm btn-primary">去分析 →</a>
      </div>
    </div>

    <div class="split-3">
      <!-- ============================================================ 组件面板 -->
      <div class="card col-scroll">
        <div class="card-head"><h2>组件</h2><span class="hint">拖到画布</span></div>
        <div class="card-body tight">
          <div v-for="(items, cat) in grouped" :key="cat" class="pal-group">
            <div class="pal-cat">{{ CATEGORY_LABELS[cat] || cat }}</div>
            <div
              v-for="it in items"
              :key="it.type"
              class="palette-item"
              draggable="true"
              :title="it.desc"
              @dragstart="onPaletteDragStart($event, it.type)"
              @dragend="onDragEnd"
            >
              <span class="pi-ic" :style="{ background: it.color }">{{ it.icon }}</span>
              <span class="pal-label">{{ it.label }}</span>
              <span class="pal-count">{{ it.propsCount }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- ============================================================ 画布 -->
      <div class="card">
        <div class="card-head">
          <h2>
            结构画布
            <span class="tag tag-mono">{{ nodes.length }} 节点 / {{ edges.length }} 连线</span>
          </h2>
          <div class="row-wrap">
            <span v-if="pendingFrom" class="tag tag-accent">
              连线中：再点一个输入端口（Esc 可取消）
            </span>
            <span v-else class="hint">点输出端口 → 点输入端口 = 连线 · 点画布空白处取消选中</span>
          </div>
        </div>

        <div
          class="canvas"
          :class="{ dropping: dragging }"
          @dragover.prevent
          @drop="onCanvasDrop"
          @click.self="deselect"
        >
          <div id="canvas-inner" class="canvas-inner" :style="{ width: canvasSize.width + 'px', height: canvasSize.height + 'px' }" @click.self="deselect">
            <!-- 连线 -->
            <svg class="wires" :width="canvasSize.width" :height="canvasSize.height">
              <defs>
                <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5"
                  markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                  <path d="M0,0 L10,5 L0,10 z" class="arrowhead" />
                </marker>
              </defs>
              <g v-for="e in edges" :key="e.id" class="wire">
                <path class="wire-path" :d="edgePath(e)" marker-end="url(#arrow)" />
                <circle
                  class="wire-del"
                  :cx="edgeMid(e).x" :cy="edgeMid(e).y" r="7"
                  @click="deleteEdge(e.id)"
                />
                <text class="wire-x" :x="edgeMid(e).x" :y="edgeMid(e).y + 3.5"
                  text-anchor="middle" @click="deleteEdge(e.id)">×</text>
              </g>
            </svg>

            <!-- 节点 -->
            <div
              v-for="n in nodes"
              :key="n.id"
              class="node"
              :class="{ sel: n.id === selectedNodeId, dragging: n.id === dragState.id }"
              :style="{ left: n.x + 'px', top: n.y + 'px' }"
              @mousedown="onNodeMouseDown($event, n)"
            >
              <div class="n-head" :style="{ background: NODE_TYPES[n.type]?.color || 'var(--accent)' }">
                <span class="ic">{{ NODE_TYPES[n.type]?.icon }}</span>
                <span class="n-title">{{ NODE_TYPES[n.type]?.label }}</span>
              </div>
              <div class="n-body">
                <div v-for="p in (NODE_TYPES[n.type]?.props || []).slice(0, 2)" :key="p.key">
                  {{ p.label }}: <b>{{ typeof n.props[p.key] === 'boolean' ? (n.props[p.key] ? '是' : '否') : n.props[p.key] }}</b>
                </div>
              </div>

              <!-- 输入端口（左侧）—— 用节点自己的 inputs（多字端口时是 W0…Wn-1） -->
              <span
                v-for="(port, i) in (n.inputs || [])"
                :key="'in' + port.id"
                class="port in"
                :class="{ linked: graph.edges.some((e) => e.to === n.id && e.toPort === port.id) }"
                :style="{ left: '-5px', top: (HEADER_H + ((i + 0.5) * (BODY_H / Math.max((n.inputs || []).length, 1)))) + 'px' }"
                :title="'输入端口 ' + port.label + '（点这里完成连线）'"
                @click="onPortClick($event, n, port, true)"
              ></span>

              <!-- 输出端口（右侧） -->
              <span
                v-for="(port, i) in (n.outputs || [])"
                :key="'out' + port.id"
                class="port out"
                :class="{ linked: graph.edges.some((e) => e.from === n.id && e.fromPort === port.id) }"
                :style="{ left: (NODE_W - 4) + 'px', top: (HEADER_H + ((i + 0.5) * (BODY_H / Math.max((n.outputs || []).length, 1)))) + 'px' }"
                :title="'输出端口 ' + port.label + '（点这里开始连线）'"
                @click="onPortClick($event, n, port, false)"
              ></span>
            </div>

            <div v-if="!nodes.length" class="canvas-empty">
              画布是空的。从左侧把「输入明文」等组件拖进来开始搭结构。
            </div>
          </div>
        </div>

        <!-- 校验 -->
        <div class="card-body tight" style="border-top: 1px solid var(--border)">
          <div v-if="validation.ok" class="alert alert-ok small">
            ✓ 结构校验通过，可以进行差分/线性分析
          </div>
          <div v-else class="alert alert-warn small">
            ⚠ 结构存在问题：{{ validation.issues.map((i) => i?.msg ?? i).join('；') }}
          </div>
        </div>
      </div>

      <!-- ============================================================ 属性面板 -->
      <div class="card col-scroll">
        <div class="card-head">
          <h2>属性</h2>
          <button v-if="selected" class="btn btn-sm btn-danger" @click="deleteSelected">删除</button>
        </div>

        <div v-if="!selected" class="card-body tight">
          <div class="empty" style="padding: 22px 8px">
            点击画布上的节点查看 / 修改它的参数。
          </div>

          <div class="sub-title">算法元信息</div>

          <!-- ★ 结构类型：决定引擎按哪条路算（SPN 单趟传播 / Feistel 分支迭代）。
               从前这个字段没有任何界面入口，手搭的 Feistel 只能带着 spn 标记。 -->
          <div class="field">
            <label>结构类型</label>
            <select
              class="select" :value="structure"
              @change="setMeta('structure', $event.target.value)"
            >
              <option v-for="(t, k) in structureOptions" :key="k" :value="k">{{ t }}</option>
            </select>
            <div class="faint small">
              {{ structure === 'feistel'
                ? '按左右两半迭代：引擎会真正沿这张图做「分割 → 分支 → 交叉 → 交换」'
                : '每轮对整个状态做代换 + 置换' }}
            </div>
            <!-- 导入的图可能带着没有引擎的结构标记：明说，别让它悄悄按 SPN 算 -->
            <div v-if="unsupportedStructure" class="alert alert-warn small" style="margin-top: 6px">
              这张图标记为「{{ unsupportedStructure }}」，但引擎还没有实现该结构 ——
              当前会按 SPN 计算。请在上面改选 SPN 或 Feistel。
            </div>
          </div>

          <div v-for="f in metaFields" :key="f.k" class="field">
            <label>{{ f.label }}</label>
            <!-- 同上：@input。元信息面板会在「选中某个节点」时整块卸载，
                 用 @change 的话，刚敲进去的值会随面板一起消失。 -->
            <input
              class="input" :value="graph.meta[f.k]"
              @input="setMeta(f.k, $event.target.value)"
            />
          </div>

          <!-- 分组长度由「输入明文」派生，不单独填 —— 免得两处写的不一样 -->
          <div class="field">
            <label>分组长度</label>
            <input class="input" :value="blockSize" readonly />
            <div class="faint small">
              = 输入位宽 {{ blockBits }} bit × 分块数 {{ inputBlocks }} 块（改「输入明文」节点即可）
            </div>
          </div>
        </div>

        <div v-else class="card-body tight">
          <div class="sel-head">
            <span class="pi-ic" :style="{ background: selectedDef.color }">{{ selectedDef.icon }}</span>
            <div>
              <b>{{ selectedDef.label }}</b>
              <div class="faint small mono">{{ selected.type }}</div>
            </div>
          </div>
          <p class="sel-desc">{{ selectedDef.desc }}</p>

          <div v-for="f in propFields" :key="f.key" class="field">
            <label>{{ f.label }}</label>

            <select
              v-if="f.type === 'select'" class="select"
              :value="f.value" @change="onPropInput(f, $event.target.value)"
            >
              <option v-for="o in f.options" :key="o.v" :value="o.v">{{ o.t }}</option>
            </select>

            <select
              v-else-if="f.type === 'sbox'" class="select"
              :value="f.value" @change="onPropInput(f, $event.target.value)"
            >
              <option v-for="o in f.sboxOptions" :key="o.id" :value="o.id">
                {{ o.name }}（{{ o.count }} 项{{ o.builtin ? ' · 内置' : (o.remote ? ' · S 盒库' : '') }}）
              </option>
            </select>

            <label v-else-if="f.type === 'boolean'" class="checkbox">
              <input type="checkbox" :checked="f.value" @change="onPropInput(f, $event.target.checked)" />
              <span>启用</span>
            </label>

            <!-- ⚠️ 数值/文本字段用 @input（敲下去就生效），不要用 @change：
                 change 只在失焦时发，而"改完这个节点的值、接着点另一个节点"
                 是真人最常见的动作 —— 那一刻失焦晚于选中切换，值就会跑错节点。 -->
            <input
              v-else-if="f.type === 'number'" class="input input-num" type="number"
              :min="f.min" :max="f.max" :value="f.value"
              @input="onPropInput(f, $event.target.value)"
            />

            <input
              v-else class="input" :value="f.value"
              @input="onPropInput(f, $event.target.value)"
            />

            <div v-if="f.hint" class="tip">{{ f.hint }}</div>
          </div>

          <div class="field">
            <label>建议</label>
            <div class="tip">{{ selectedDef.desc }}</div>
          </div>
        </div>
      </div>
    </div>

    <!-- ============================================================ 结构解析 -->
    <!--
      说明性内容默认收起。它是"复核用"的 —— 搭结构时要看的是画布和属性，
      不必每次滚动都路过一遍解析文字。空画布（没有节点）时整块不出现。
    -->
    <FoldPanel
      v-if="nodes.length"
      class="explain"
      title="中文解析 · 结构说明与逐组件解释"
      :hint="`${components.length} 个组件 · 按数据流顺序`"
    >
      <ExplainPanel bare :items="explainItems" />

      <div v-if="components.length" class="comp-list">
        <div class="sub-title">逐组件说明</div>
        <div v-for="c in components" :key="c.id" class="comp">
          <span class="comp-idx" :style="{ background: c.color }">{{ c.index }}</span>
          <div class="comp-main">
            <div class="comp-head">
              <b>{{ c.label }}</b>
              <span class="tag">{{ c.categoryLabel }}</span>
            </div>
            <p class="comp-desc">{{ c.desc }}</p>
            <p v-if="c.analysisRole" class="comp-role">{{ c.analysisRole }}</p>
            <div v-if="c.props.length" class="comp-props">
              <span v-for="p in c.props" :key="p.key" class="tag tag-mono">
                {{ p.label }}={{ p.value }}
              </span>
            </div>
          </div>
        </div>
      </div>
    </FoldPanel>
  </div>
</template>

<style scoped>
.head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  margin-bottom: 18px;
}

/* ---- 组件面板 ---- */

.pal-group + .pal-group {
  margin-top: 14px;
}

.pal-cat {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-faint);
  letter-spacing: 0.04em;
  margin: 0 0 6px 2px;
}

.pal-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pal-count {
  font-size: 10px;
  color: var(--text-faint);
  font-family: var(--mono);
}

/* ---- 画布 ---- */

.canvas-inner {
  position: relative;
  min-width: 100%;
}

.wires {
  position: absolute;
  inset: 0;
  pointer-events: none;
  overflow: visible;
}

.wire-path {
  fill: none;
  stroke: var(--border-strong);
  stroke-width: 1.6;
}

.arrowhead {
  fill: var(--border-strong);
}

.wire-del {
  fill: transparent;
  stroke: transparent;
  cursor: pointer;
  pointer-events: all;
}

.wire-x {
  fill: transparent;
  font-size: 11px;
  cursor: pointer;
  pointer-events: all;
  user-select: none;
}

.wire:hover .wire-path {
  stroke: var(--err);
}

.wire:hover .wire-del {
  fill: var(--err-soft);
  stroke: var(--err);
}

.wire:hover .wire-x {
  fill: var(--err);
}

.n-title {
  overflow: hidden;
  text-overflow: ellipsis;
}

.port {
  cursor: crosshair;
}

.port.in:hover,
.port.out:hover {
  background: var(--accent);
  transform: scale(1.35);
}

.canvas-empty {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: var(--text-faint);
  font-size: 13px;
  pointer-events: none;
}

/* ---- 属性面板 ---- */

.sel-head {
  display: flex;
  align-items: center;
  gap: 9px;
  padding-bottom: 11px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 11px;
}

.sel-desc {
  margin: 0 0 14px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-muted);
}

/* ---- 结构解析（折叠区） ---- */

/* 折叠区自带边框与留白，这里只补它与上方画布区的间距 */
.explain {
  margin-top: 12px;
}

.comp-list {
  margin-top: 2px;
}

.comp {
  display: flex;
  gap: 11px;
  padding: 8px 0;
  border-bottom: 1px dashed var(--border);
}

.comp:last-child {
  border-bottom: none;
}

.comp-idx {
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  color: #fff;
  font-size: 11px;
  font-weight: 700;
  font-family: var(--mono);
  flex: none;
}

.comp-main {
  flex: 1;
  min-width: 0;
}

.comp-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}

.comp-desc {
  margin: 0 0 4px;
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--text-muted);
}

.comp-role {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.75;
  color: var(--text);
  padding: 7px 10px;
  border-left: 2px solid var(--accent);
  background: var(--accent-soft);
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
}

.comp-props {
  margin-top: 7px;
  display: flex;
  gap: 5px;
  flex-wrap: wrap;
}
</style>
