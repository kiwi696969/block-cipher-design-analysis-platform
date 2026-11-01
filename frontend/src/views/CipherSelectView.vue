<script setup>
/**
 * 算法选择页。
 *
 * 每个模板都真实 build() 一次拿到 meta 与节点清单 —— 卡片上显示的
 * 轮数 / 结构 / 节点数都是从图里读出来的，不是写死的文案。
 * 这样以后改模板，卡片会跟着变，不会出现"卡片说 16 轮、实际 32 轮"。
 *
 * 改版要点（"工程化"）：
 *   · 卡片上只留**做决定需要的信息**：名字 + 结构标签 + 一行规模摘要；
 *   · 「组件构成 / 节点连线 / 声明变量」这类结构性细节收进卡片下方的折叠区，
 *     想看再展开 —— 它们是"复核用"的，不是"选择用"的；
 *   · 算法背景介绍（类 AES 是什么、空白画布怎么用）整段折叠，不再占半个屏幕。
 *
 * ⚠️ 测试契约：可点击的模板卡仍然是 `<button class="tpl">`，
 *    折叠区是它的**兄弟节点**而不是子节点 —— 否则 E2E 点卡片中心时
 *    会命中折叠标题栏，变成"展开详情"而不是"选中模板"。
 */
import { computed, onMounted, ref } from 'vue'
import { href } from '@/pages.js'

import { TEMPLATES, NODE_TYPES, USER_TEMPLATE_IDS } from '@/core/graph.js'
import { loadTemplate, templateId, sboxLib, sboxRev } from '@/stores/platform.js'
import FoldPanel from '@/components/FoldPanel.vue'

/** 每个模板构建一次，缓存起来（build() 有副作用吗？没有 —— 只是造图） */
const cards = ref([])

const SBOX_LABEL = { present: 'PRESENT', gift: 'GIFT', aes: 'AES', sm4: 'SM4', des1: 'DES S1', identity: '恒等', skipjack: 'Skipjack' }

function describe(tplId) {
  const tpl = TEMPLATES[tplId]
  let g
  try {
    g = tpl.build()
  } catch (err) {
    return { id: tplId, name: tpl.name, error: err.message }
  }
  const m = g.meta || {}
  const kinds = []
  for (const n of g.nodes) {
    const label = NODE_TYPES[n.type]?.label
    if (label && !kinds.includes(label)) kinds.push(label)
  }
  // 找出用到的 S 盒
  const sboxes = []
  for (const n of g.nodes) {
    if (n.type === 'SBOX' && n.props?.sboxId) sboxes.push(SBOX_LABEL[n.props.sboxId] || n.props.sboxId)
    if (n.type === 'TTRANS') sboxes.push('SM4')
  }
  return {
    id: tplId,
    name: tpl.name,
    // 空白画布没有预置结构 —— 卡片上要区别对待，不能套用「SPN」
    isBlank: tplId === 'blank',
    meta: m,
    nodes: g.nodes.length,
    edges: g.edges.length,
    kinds,
    sboxes: [...new Set(sboxes)],
    variables: g.variables?.length || 0,
  }
}

onMounted(() => {
  // 只列 USER_TEMPLATE_IDS 里的 —— 界面上是 SM4 / AES-128 / PRESENT-64 / 类 AES / 空白画布
  cards.value = USER_TEMPLATE_IDS.map(describe)
})

// 显式读 sboxRev：`sboxLib.list()` 不是响应式的，服务端镜像晚到时
// （boot.js 的 2s 上限过了才落地）得靠这个版本号触发重算。
const otherSboxes = computed(() => { sboxRev.value; return sboxLib.list() })

function pick(id) {
  const ok = loadTemplate(id)
  if (ok) window.location.assign(href('structure'))
}

const fmtInt = (n) => (Number.isFinite(Number(n)) ? Number(n).toLocaleString('zh-CN') : '-')
</script>

<template>
  <div class="page">
    <div class="head">
      <div>
        <h2 class="section-title">选择算法模板</h2>
        <p class="section-desc">
          模板是<b>完整的可分析结构</b>，不是示意图片。选中后会进入结构编辑器，
          可以在那里自由增删组件。
        </p>
      </div>
      <div class="row-wrap">
        <a :href="href('sbox')" class="btn btn-sm">管理 S 盒库</a>
      </div>
    </div>

    <!-- ---------------------------------------------------------------- 模板卡 -->
    <div class="grid-3">
      <div
        v-for="c in cards"
        :key="c.id"
        class="tpl-cell"
        :class="{ on: templateId === c.id, blank: c.id === 'blank' }"
      >
        <button class="tpl" @click="pick(c.id)">
          <div class="tpl-head">
            <h3>{{ c.name }}</h3>
            <span v-if="templateId === c.id" class="tag tag-ok">当前</span>
          </div>

          <div v-if="c.error" class="alert alert-err small">构建失败：{{ c.error }}</div>

          <template v-else>
            <p class="tpl-note">{{ c.meta.note || '—' }}</p>

            <div class="tpl-tags">
              <!-- 空白画布没有预置结构，别硬套一个「SPN」标签（会误导） -->
              <span v-if="c.isBlank" class="tag tag-accent">自定义结构</span>
              <span v-else class="tag">
                {{ c.meta.structure === 'feistel' ? '广义 Feistel' : 'SPN' }}
              </span>
              <span v-if="c.meta.standard" class="tag tag-accent">{{ c.meta.standard }}</span>
              <span v-if="c.meta.blockSize" class="tag">{{ c.meta.blockSize }} bit</span>
              <span v-if="c.meta.rounds" class="tag tag-violet">{{ c.meta.rounds }} 轮</span>
              <span v-for="s in c.sboxes" :key="s" class="tag tag-cyan">{{ s }}</span>
            </div>

            <div class="tpl-stat mono">
              节点 {{ c.nodes }} · 连线 {{ c.edges }} · 变量 {{ fmtInt(c.variables) }}
            </div>
          </template>
        </button>

        <!-- 结构性细节收进折叠区：复核时才展开 -->
        <FoldPanel
          v-if="!c.error"
          title="结构详情"
          :hint="`组件构成 · ${c.nodes} 节点`"
        >
          <dl class="kv">
            <dt>结构类型</dt>
            <dd>{{ c.isBlank ? '自定义' : (c.meta.structure === 'feistel' ? '广义 Feistel' : 'SPN') }}</dd>
            <dt>标准来源</dt>
            <dd>{{ c.meta.standard || '—' }}</dd>
            <dt>分组长度</dt>
            <dd>{{ c.meta.blockSize ? c.meta.blockSize + ' bit' : '—' }}</dd>
            <dt>密钥长度</dt>
            <dd>{{ c.meta.keySize ? c.meta.keySize + ' bit' : '—' }}</dd>
            <dt>总轮数</dt>
            <dd>{{ c.meta.rounds || '—' }}</dd>
            <dt>节点 / 连线</dt>
            <dd>{{ c.nodes }} / {{ c.edges }}</dd>
            <dt>声明变量</dt>
            <dd>{{ fmtInt(c.variables) }} 个</dd>
            <dt>使用的 S 盒</dt>
            <dd>{{ c.sboxes.length ? c.sboxes.join('、') : '—' }}</dd>
          </dl>

          <div class="sub-title" style="margin-top: 10px">组件构成</div>
          <div class="row-wrap">
            <span v-for="k in c.kinds" :key="k" class="tag">{{ k }}</span>
            <span v-if="!c.kinds.length" class="faint small">（空画布，尚无组件）</span>
          </div>
        </FoldPanel>
      </div>
    </div>

    <!-- ---------------------------------------------------------------- S 盒 -->
    <div class="card" style="margin-top: 12px">
      <div class="card-head">
        <h2>S 盒库</h2>
        <span class="hint">分析用哪个 S 盒，这里就是清单 —— 也可在「S 盒库」页导入自己的</span>
      </div>
      <div class="card-body tight">
        <div class="row-wrap">
          <a v-for="s in otherSboxes" :key="s.id" :href="href('sbox')" class="sbox-chip">
            <b>{{ s.name }}</b>
            <span class="small faint">
              {{ s.count }} 项 · {{ s.builtin ? '内置' : (s.remote ? 'S 盒库' : '自定义') }}
            </span>
          </a>
        </div>
      </div>
    </div>

    <!-- ---------------------------------------------------------------- 命名口径 -->
    <FoldPanel
      style="margin-top: 12px"
      title="命名口径与自定义画布"
      hint="哪些是完整算法 · 为什么叫「类 AES」"
    >
      <p class="note">
        <b>三个标准算法（SM4 / AES-128 / PRESENT-64）</b>都用专用引擎按真实轮函数计算：
        SM4 走 4×32bit 的 Feistel 迭代，AES-128 与 PRESENT-64 走 16 个单元的 SPN 引擎
        （AES 的列混淆是真 GF(2⁸) 运算，PRESENT 的 P 层是 ISO/IEC 29192-2 的位置换）。
        它们都能对上官方测试向量，数值可与文献对照。
      </p>
      <p class="note">
        <b>关于「类 AES」</b>：它是<b>结构相似</b>的教学模型（SPN + 8 bit S 盒 + 扩散层），
        blockSize 只有 32bit，<b>不是</b> AES 标准本身 —— 命名带「类」字就是为了提示这一点。
        要分析真正的 AES-128（128bit 状态、10 轮、真实密钥编排）请直接选 <b>AES-128</b> 模板。
      </p>
      <p class="note">
        想自己搭一套结构（比如真实 AES 的列混淆写法），选<b>「空白画布」</b>，
        在结构编辑器里从左侧拖组件进画布即可。可用的组件共 11 种，
        覆盖 S 盒替换、线性变换、异或轮密钥、置换、拆分/合并、位转置、
        整轮容器等差分分析需要的全部构件。
      </p>
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
  margin-bottom: 12px;
}

/* 卡片 + 折叠区是一个整体：外层只负责"当前 / 空白画布"的视觉区分 */
.tpl-cell {
  display: flex;
  flex-direction: column;
}

.tpl-cell.on .tpl {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.tpl-cell.blank .tpl {
  border-style: dashed;
}

.tpl-cell .fold {
  margin-top: -1px;
  border-top-left-radius: 0;
  border-top-right-radius: 0;
}

.tpl {
  display: block;
  width: 100%;
  text-align: left;
  padding: 11px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  color: inherit;
  font-family: inherit;
  font-size: 12.5px;
  cursor: pointer;
  transition: border-color 0.12s, background 0.12s;
}

.tpl:hover {
  border-color: var(--accent-border);
  background: var(--surface-2);
}

.tpl-cell .fold + * {
  margin-top: 0;
}

.tpl-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 6px;
}

.tpl-head h3 {
  margin: 0;
  font-size: 13.5px;
  font-weight: 650;
}

.tpl-note {
  margin: 0 0 9px;
  font-size: 12px;
  line-height: 1.65;
  color: var(--text-muted);
}

.tpl-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-bottom: 9px;
}

.tpl-stat {
  padding-top: 8px;
  border-top: 1px dashed var(--border);
  font-size: 11px;
  color: var(--text-faint);
}

.sbox-chip {
  display: inline-flex;
  flex-direction: column;
  gap: 1px;
  padding: 5px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  color: inherit;
  text-decoration: none;
  font-size: 12px;
  transition: border-color 0.12s, background 0.12s;
}

.sbox-chip:hover {
  text-decoration: none;
  border-color: var(--accent-border);
  background: var(--accent-soft);
}

.sbox-chip b {
  font-weight: 600;
}

.note {
  margin: 0 0 8px;
  font-size: 12px;
  line-height: 1.75;
  color: var(--text-muted);
}

.note:last-child {
  margin-bottom: 0;
}

.note b {
  color: var(--text);
}
</style>
