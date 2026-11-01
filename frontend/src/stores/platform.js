/**
 * 平台状态中枢。
 *
 * 设计要点（都是踩过坑之后定下的）：
 *
 * 1. **参数只在一处装配** —— 任何入口（运行分析 / 全轮扫描 / 教程示例）
 *    都必须走 `searchOptions()`。历史上两条路径用过不同的 beamWidth，
 *    同一个轮数给出两个数，用户以为平台有两套结果。
 *
 * 2. **默认值只写一次**（`PARAM_DEFAULTS`），并持久化到 localStorage。
 *
 * 3. **改图结构 = 换一个 CipherGraph 实例**，不原地改，
 *    避免"上一份分析结果挂在旧节点 id 上"这类脏状态。
 *
 * 4. **S 盒库在模块加载时就实例化** —— 引擎通过 globalThis.__SBOX_LIB__
 *    取 S 盒（见 graph.js / analysis.js）。晚一步就会报"找不到 S 盒"。
 */

import { computed, reactive, ref, shallowRef, watch } from 'vue'

import { CipherGraph, TEMPLATES, graphBlockBits, graphEngine } from '@/core/graph.js'
import { SBoxLibrary } from '@/core/sboxlib.js'
import {
  MODE, MODEL_SPEC,
  feistelCharacteristicSearch, sm4RoundProfile, feistelGraphProfile, analyze,
} from '@/core/analysis.js'
import { spnProfile } from '@/core/spnprofile.js'
import { SPN_CIPHERS } from '@/core/spnref.js'
import { buildModel, modelVerdict } from '@/core/model.js'
import { empiricalHitRate } from '@/core/empirical.js'
import { explainGraph, explainCharacteristic, explainSecurity } from '@/core/explain.js'
import {
  PARAM_DEFAULTS, buildSearchOptions, describeInitDiffs,
  teachingFlagsOf, roundRangeIssueOf, effectiveRangeOf,
  STRUCTURES, UNSUPPORTED_STRUCTURES,
} from '@/core/params.js'
import { parseHex } from '@/core/hex.js'
import { structureSignature } from '@/core/signature.js'
import {
  addSnapshot, removeSnapshot, snapshotOf, isValidSnapshot, COMPARE_MAX,
} from '@/core/compare.js'
import {
  bcaChannel, solveWithBca, buildFromBca, usableResponse, bestRows,
  BCA_ANALYSIS_TASK, BCA_ANALYSIS_MODE,
} from '@/core/bca-solve.js'
import { api } from '@/api/client.js'

/* ---------------------------------------------------------------- S 盒库 */

// 必须在任何引擎调用之前完成 —— 引擎靠 globalThis.__SBOX_LIB__ 取 S 盒
export const sboxLib = new SBoxLibrary()

/* ------------------------------------------------- S 盒库 ↔ 服务端同步 */

/**
 * 把 Django 里存的 S 盒（`/sbox/` 页与后台写入的）拉进前端 S 盒库，
 * 这样结构编辑器的 S 盒下拉才选得到它们。
 *
 * 方向是**单向：服务端 → 前端**。双向同步会立刻带来"两边不一致时听谁的"
 * 这个没法回答的问题；而 S 盒库页本来就是这一数据的唯一写入口，
 * 单向拉取既够用又不会产生幽灵数据。
 *
 * 只在启动时拉一次（结果缓存在模块里），S 盒库页增删后再用
 * `refreshSboxesFromServer()` 作废缓存重拉。
 *
 * **永不抛错** —— 后端没起来时页面照常渲染，只是下拉里只剩内置 S 盒。
 */
let sboxSync = null

/**
 * 服务端 S 盒镜像的版本号。
 *
 * 视图侧的下拉/列表取的是 `sboxLib.list()` —— 那不是响应式数据源，
 * 靠 `computed` 自己发现不了变化。所以每次镜像被刷新就 +1，
 * 由视图把这个值读进自己的 `computed` 里当依赖。
 *
 * 为什么必须有：boot.js 给同步套了 2s 上限（后端挂着不回时不能白屏），
 * 一旦超时，页面会先挂载、同步在之后才落地 —— 没有这个版本号，
 * 拉回来的 S 盒就永远进不了已经渲染好的下拉框。
 */
export const sboxRev = ref(0)

export function syncSboxesFromServer() {
  if (!sboxSync) {
    sboxSync = api.listSboxes(true)
      .then((data) => {
        const entries = []
        for (const row of data?.results || []) {
          let table = []
          try { table = parseHex(row.table_hex || '') } catch { continue }
          if (!table.length) continue
          entries.push({
            id: row.id,
            name: row.name,
            bits: row.bits,
            desc: row.note || `S 盒库 #${row.id}`,
            isBuiltin: !!row.is_builtin,
            table,
          })
        }
        const res = sboxLib.syncServer(entries)
        sboxRev.value++ // 通知已挂载的视图重读 sboxLib.list()
        // 只在"真的多了可选 S 盒"时记一条 —— 否则每次开页都刷一行噪音
        if (res.total > res.previous) {
          log('info', `S 盒库已同步：${res.total} 个来自服务端的 S 盒出现在结构编辑器下拉里。`)
        }
        return res
      })
      .catch((err) => {
        console.warn('[sbox] 服务端 S 盒同步失败（下拉里只有内置 S 盒）：', err.message)
        return { total: 0, skipped: 0, previous: 0, error: err.message }
      })
  }
  return sboxSync
}

/** S 盒库页增删了记录之后调用：作废缓存并重新拉取 */
export function refreshSboxesFromServer() {
  sboxSync = null
  return syncSboxesFromServer()
}

/* ---------------------------------------------------------------- 参数体系 */

// 默认值与装配逻辑都在 core/params.js（纯函数、可被 Node 直接测试）。
// 这里只负责：响应式包装 + localStorage 持久化 + 默认值单点导出。
export { PARAM_DEFAULTS }


const PARAM_KEY = 'cda_params'

function loadParams() {
  try {
    const raw = localStorage.getItem(PARAM_KEY)
    if (!raw) return { ...PARAM_DEFAULTS }
    const saved = JSON.parse(raw)
    // 只接受已知键，避免旧版本遗留字段污染新版本
    const merged = { ...PARAM_DEFAULTS }
    for (const k of Object.keys(PARAM_DEFAULTS)) {
      if (saved[k] !== undefined) merged[k] = saved[k]
    }
    return merged
  } catch {
    return { ...PARAM_DEFAULTS }
  }
}

export const params = reactive(loadParams())

export function saveParams() {
  try {
    localStorage.setItem(PARAM_KEY, JSON.stringify(params))
  } catch { /* 隐私模式下降级 */ }
}

export function resetParams() {
  Object.assign(params, PARAM_DEFAULTS)
  saveParams()
}

/** 给界面看的解析回执：解析出几个起点、写法是否合法（逻辑在 core/params.js） */
export const initDiffsInfo = computed(() => describeInitDiffs(params.initDiffs))


/* ---------------------------------------------------------------- 图状态 */

export const templateId = ref('sm4')

export const graph = shallowRef(TEMPLATES.sm4.build())
export const selectedNodeId = ref('')

/**
 * 结构修订号 —— **每个从 graph 派生的 computed 都要先读一下它**。
 *
 * 为什么必需：graph 是 shallowRef 包着的 class 实例，`node.props.x = v` 这类
 * **就地改动不会触发响应式**，`graph.value` 的引用也没变。于是 Vue 的依赖比较
 * 认为「值没变」，下游 computed 会一直返回陈旧缓存 ——
 * 症状就是「画布上换了 S 盒，右侧下拉框却弹回旧值」「中文解析文案不跟着更新」
 * 「建模规模不随结构变化」。这类 bug 不报错，只是显示和真实状态不一致，最难查。
 *
 * 所以：改完图调一次 bumpGraph()，让所有派生量重新求值。
 */
export const graphRev = ref(0)
export function bumpGraph() { graphRev.value++ }

export function loadTemplate(id) {
  const tpl = TEMPLATES[id]
  if (!tpl) return false
  templateId.value = id
  graph.value = tpl.build()
  selectedNodeId.value = ''
  clearResult()
  log('info', `已载入模板「${tpl.name}」：${graph.value.nodes.length} 个节点、`
    + `${graph.value.edges.length} 条连线，声明 ${graph.value.meta.rounds} 轮。`)
  return true
}

export function setGraph(g) {
  graph.value = g
  selectedNodeId.value = ''
  clearResult()
}

/** 教学对照开关（仅 τ / 线性化 S 盒）是否打开 —— 界面据此给出显式提醒 */
export const teachingFlags = computed(() => {
  graphRev.value // ← 就地改 graph 不会触发响应式，必须显式依赖修订号
  return teachingFlagsOf(graph.value)
})

/* ---------------------------------------------------------------- 日志 */

export const logs = ref([])
let logSeq = 0

const LOG_LIMIT = 2000

export function log(level, msg, data) {
  logs.value.push({
    id: ++logSeq,
    t: Date.now(),
    level,
    msg: String(msg ?? ''),
    data: typeof data === 'number' ? data : undefined,
  })
  if (logs.value.length > LOG_LIMIT) logs.value.splice(0, logs.value.length - LOG_LIMIT)
}

export function clearLogs() {
  logs.value = []
  logSeq = 0
}

/* ---------------------------------------------------------------- 运行状态 */

export const status = ref('idle')          // idle | running | done | error | aborted
/* 最近一次分析的**具体失败原因**。页面要直接显示它 —— 原来只有一句
   「通常是结构不连通、区间为空，或缺少 S 盒」的通用猜测，而真实原因
   往往是后端侧（锁被占、护栏超时、无可用求解器），用户只能去翻日志。 */
export const lastError = ref('')
export const mode = ref(MODE.DIFFERENTIAL) // differential | linear
export const progress = reactive({ value: 0, label: '', phase: '' })

export const result = shallowRef(null)
export const empirical = shallowRef(null)
export const empiricalRunning = ref(false)

export function clearResult() {
  result.value = null
  empirical.value = null
  status.value = 'idle'
  progress.value = 0
  progress.label = ''
  progress.phase = ''
  saveSession()
}

/* ---------------------------------------------------------------- 会话持久化 */

/**
 * 同一次浏览器会话内保住结果与日志（sessionStorage）。
 *
 * 为什么需要：结果页、日志页在导航栏里各有入口，但结果原本只活在内存里 ——
 * 用户跑完分析、刷新一下，结果页就变成"还没有结果"，很容易让人以为白跑了。
 * 参数早就持久化了，结果没理由不持久化。
 *
 * ⚠️ 但结果**必须对应它算出来的那个结构**，否则就是脏状态
 * （读一份属于旧结构的最优路径，比没有结果更糟）。所以存一份结构指纹，
 * 指纹对不上就整份丢弃。
 *
 * 指纹的实现见 `core/signature.js`（同一份口径也给对比栏用 ——
 * 从前这里自己写了一份，对比栏再要一份就必然漂移）。
 */
const SESSION_KEY = 'cda_session'
const SESSION_VERSION = 2

function saveSession() {
  try {
    const sig = structureSignature(graph.value)
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({
      v: SESSION_VERSION,
      sig,
      templateId: templateId.value,
      // ── 结构图本体 ──
      // 多页站点里每次跳转都是**整页加载**，模块级状态必然清零。
      // SPA 时代图靠内存活着，这里不落盘的话，
      // 「结构编辑页改完 → 跳到分析页」会发现改动没了（迁移时最容易漏掉的一步）。
      graph: graph.value?.toJSON?.() || null,
      result: result.value,
      // 结果必须对得上它算出来的那个结构。这里记的是**算结果那一刻**的指纹，
      // 恢复时拿它和当前图比对 —— 用 data.sig 是没用的，它恒等于当前图。
      resultSig: result.value ? sig : '',
      empirical: empirical.value,
      // 日志只留尾部：2000 条全存会逼近 sessionStorage 配额
      logs: logs.value.slice(-300),
    }))
  } catch {
    /* 超配额 / 隐私模式：静默降级，本会话内存里仍然可用 */
  }
}

function restoreSession() {
  let raw = ''
  try {
    raw = sessionStorage.getItem(SESSION_KEY) || ''
  } catch {
    return
  }
  if (!raw) return

  let data
  try {
    data = JSON.parse(raw)
  } catch {
    return
  }
  if (!data || data.v !== SESSION_VERSION) return

  // ① 结构图优先：有本体就用本体，这是多页形态下唯一能保住用户改动的方式。
  if (data.graph && Array.isArray(data.graph.nodes)) {
    try {
      graph.value = CipherGraph.fromJSON(data.graph)
      if (data.templateId) templateId.value = data.templateId
    } catch {
      // 图数据损坏：退回模板重建，至少页面可用
      graph.value = TEMPLATES[templateId.value]?.build?.() || graph.value
    }
  } else if (data.templateId && TEMPLATES[data.templateId]) {
    // ② 老会话（没有图本体）：按模板重建，并同步 templateId，
    //    否则用户换过模板（比如切到类 PRESENT）会重建回 SM4，指纹必然对不上。
    templateId.value = data.templateId
    graph.value = TEMPLATES[data.templateId].build()
  }

  // 日志与结构无关，先恢复 —— 即使结果作废，用户也该看得到上次的搜索过程
  if (Array.isArray(data.logs) && data.logs.length) {
    // 重新编号，保证 id 唯一（Vue 的 v-for key 依赖它）
    logs.value = data.logs.map((l) => ({
      id: ++logSeq,
      t: l.t || Date.now(),
      level: l.level || 'info',
      msg: String(l.msg ?? ''),
      data: typeof l.data === 'number' ? l.data : undefined,
    }))
  }

  if (data.result) {
    // ③ 结构对不上 → 结果整份丢弃。
    //    宁可不显示，也不显示属于别的结构的结果 —— 读一份旧结构的最优路径比没有更糟。
    if (data.resultSig && data.resultSig !== structureSignature(graph.value)) return

    // 注意：JSON 化后 char 变成普通对象，但所有读取路径都是字段访问、不调方法，
    // 所以无需还原成 Characteristic 实例（已验证 explain.js / empirical.js 均无方法调用）。
    result.value = data.result
    empirical.value = data.empirical || null
    status.value = 'done'
    log('info', '已恢复上次会话的结构、结果与日志（同一次浏览器会话内有效，跨页面跳转与刷新都不丢）')
  } else if (data.graph) {
    log('info', '已恢复上次会话里编辑的结构图')
  }
}

/**
 * 结构语义一变就落盘（节流）。
 *
 * 指纹只由「节点类型 + 属性 + 连线数」构成、不含坐标，
 * 所以拖动节点不会触发这里 —— 多页站点下位置本来也不必跨页保留。
 * 但勾选「仅 τ」这类**改属性**的操作会触发，必须马上写进 sessionStorage，
 * 否则用户改完跳去分析页，改动就白做了。
 */
let flushTimer = 0
function scheduleSave() {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = 0
    saveSession()
  }, 250)
}

watch(() => {
  graphRev.value // ← 必须读：属性是就地改的，不读修订号这个 watch 永远不触发
  return structureSignature(graph.value)
}, scheduleSave)


/* ---------------------------------------------------------------- 方案对比栏 */

/**
 * 最多 3 份结果快照，跨页面跳转与刷新都保留（sessionStorage，独立 key）。
 *
 * 为什么**不并进** `cda_session`：
 *   · 会话那份带 v2 版本号，往里头加字段就得升版本 → 用户手上的结果全被丢掉；
 *     而对比栏里恰好装着「上一次跑的结果」，丢掉它就等于这个功能不存在；
 *   · 对比栏要**跨模板、跨算法**存活（SM4 vs AES 才是它的主用途），
 *     语义上不属于「当前结构的会话快照」。结构变了也不该清空它 ——
 *     变结构正是要对比的那件事。
 */
const COMPARE_KEY = 'cda_compare'
const COMPARE_VERSION = 1

function loadCompare() {
  try {
    const raw = sessionStorage.getItem(COMPARE_KEY)
    if (!raw) return []
    const data = JSON.parse(raw)
    if (!data || data.v !== COMPARE_VERSION || !Array.isArray(data.items)) return []
    const items = data.items.filter(isValidSnapshot).slice(0, COMPARE_MAX)
    // 过滤掉形状不对的旧结构（升级后字段缺失）时不留哑记录 —— 宁可少一条
    return items
  } catch {
    return []
  }
}

export const compareSnaps = ref(loadCompare())

function saveCompare() {
  try {
    sessionStorage.setItem(COMPARE_KEY, JSON.stringify({
      v: COMPARE_VERSION, items: compareSnaps.value,
    }))
  } catch {
    /* 超配额 / 隐私模式：内存里仍然可用 */
  }
}

/**
 * 把**此刻的**结果加入对比栏。
 *
 * @returns {{action:string, index?:number}} action 交给界面决定提示文案；
 *   日志也在这里统一打 —— 加没加进去、为什么没加进去，用户都得看得到。
 */
export function addResultToCompare() {
  const snap = snapshotOf({
    graph: graph.value,
    templateId: templateId.value,
    result: result.value,
    empirical: empirical.value,
  })
  if (!snap) {
    log('warn', '没有可加入对比栏的结果 —— 先运行一次分析')
    return { action: 'invalid' }
  }

  const { list, action, index, prev } = addSnapshot(compareSnaps.value, snap)
  const label = `${snap.structureName} · ${snap.modeLabel} · 第 ${snap.startRound}~${snap.endRound} 轮`

  if (action === 'added' || action === 'replaced') {
    compareSnaps.value = list
    saveCompare()
  }

  if (action === 'added') {
    log('ok', `已加入对比栏（${list.length}/${COMPARE_MAX}）：${label}，`
      + `−log₂p = ${snap.weight.toFixed(2)}，活跃 ${snap.activeSboxes}`)
  } else if (action === 'replaced') {
    /* 同配置却给出不同数值 —— 这**必须**说出来。
       已知会触发的两种情况：时间预算触顶（搜索提前停）、界面束宽被自动抬高。
       静默覆盖会让人以为「平台每次给的数都不一样」。 */
    log('warn', `对比栏第 ${index + 1} 项被覆盖：同配置重跑得到不同数值`
      + `（${(prev ?? 0).toFixed(2)} → ${snap.weight.toFixed(2)}）—— `
      + '常见原因是时间预算触顶或束宽被自动抬高，可对比参数行确认')
  } else if (action === 'duplicate') {
    log('info', `这份配置已经在对比栏第 ${index + 1} 项，且数值相同 —— 没有重复添加`)
  } else if (action === 'full') {
    log('warn', `对比栏已满（${COMPARE_MAX} 项）—— 请先移除一项再加`)
  }
  return { action, index }
}

/** 移除一项 */
export function dropCompare(id) {
  const before = compareSnaps.value.length
  compareSnaps.value = removeSnapshot(compareSnaps.value, id)
  if (compareSnaps.value.length !== before) {
    saveCompare()
    log('info', '已从对比栏移除一项')
  }
}

/** 清空 */
export function clearCompare() {
  if (!compareSnaps.value.length) return
  compareSnaps.value = []
  saveCompare()
  log('info', '已清空对比栏')
}


/**
 * 🔑 唯一的参数装配入口。
 * 任何地方要调引擎，都在这里取参数，不要自己拼一份。
 *
 * 真正的装配逻辑在 `core/params.js` 的 buildSearchOptions()（纯函数、可测），
 * 这里只负责把响应式 state 喂进去。
 */
export function searchOptions(overrides = {}) {
  return buildSearchOptions({
    params,
    mode: mode.value,
    graph: graph.value,
    overrides,
  })
}

/** 区间是否倒挂（用于界面常驻告警，注意不要回写输入框） */
export const roundRangeIssue = computed(() => roundRangeIssueOf(params))

/** 实际生效的轮数区间（徽标展示用） */
export const effectiveRange = computed(() => effectiveRangeOf(params))

/* ---------------------------------------------------------------- 建模统计 */

export const modelInfo = computed(() => {
  graphRev.value // ← 结构变了就要重算规模，否则建模指标与画布对不上
  const r = effectiveRange.value
  return buildModel(graph.value, {
    mode: mode.value,
    startRound: r.start,
    endRound: r.end,
    rounds: r.rounds,
    blockBits: graphBlockBits(graph.value),
    auxVars: params.auxVars,
    guessRounds: params.guessRounds,
  })
})

export const modelGrade = computed(() => modelVerdict(modelInfo.value))

/* ---------------------------------------------------------------- 运行分析 */

/**
 * 按图的引擎分流跑一次特征搜索。
 *
 * 「运行分析」与「全轮扫描」共用它 —— 从前扫描固定走 SM4 专用引擎，
 * 于是对 SPN 图扫描出来的收敛曲线和单次运行的结果对不上。
 *
 * 三条路：
 *   'sm4'          → SM4 专用迭代引擎（只有内置模板带这个标记）
 *   'feistel-graph'→ 通用 Feistel 分支迭代（真正遍历用户图）
 *   'graph'        → 通用图传播（SPN 单趟传播）
 *
 * ⚠️ **分流规则只有这一份**，必须 export 出去给别的页面用。
 *    结果页的「三模型对比」曾经自己抄了一份 `feistel || mode === LINEAR` ——
 *    于是线性模式下所有图（含 SPN）都被送进 SM4 味的 Feistel 迭代引擎，
 *    和「运行分析」的数字对不上。同一语义两处实现，必然漂移。
 *
 * @returns {{best, perRound, path, reason}}
 */
/**
 * 把界面「起始差分 / 掩码」的四字向量落成 AES/PRESENT 的 16 个单元。
 *
 * 界面给的是「四字向量」（每个字 32bit，共 128bit），正好是 AES 的完整状态；
 * PRESENT 只取前 64bit。
 *
 * ⚠️ 从前通用图路径把「起始差分」当摆设（只有 SM4 引擎读它）—— 这里必须落地，
 *    否则用户填了起点、结果却按默认起点算，是同一个缺陷换个算法再犯一次。
 *    全零差分不构成特征：返回 null 交给默认起点集合，并由调用方记一条 warn。
 */
function cellsFromInitDiffs(initDiffs, cipher) {
  if (!Array.isArray(initDiffs) || !initDiffs.length) return null
  const vec = Array.isArray(initDiffs[0]) ? initDiffs[0] : initDiffs
  const words = vec.map((v) => Number(v) >>> 0)
  if (!words.some((w) => w !== 0)) return null
  const cellBits = cipher === 'present' ? 4 : 8
  const cells = []
  for (const w of words) {
    if (cellBits === 8) {
      cells.push((w >>> 24) & 0xff, (w >>> 16) & 0xff, (w >>> 8) & 0xff, w & 0xff)
    } else {
      for (let i = 0; i < 8; i++) cells.push((w >>> (28 - 4 * i)) & 0xf)
    }
    if (cells.length >= 16) break
  }
  return cells.slice(0, 16)
}

export function runProfile(opts, { startRound, endRound, rounds, onLog = () => {} }) {
  if (opts.engine === 'sm4') {
    const prof = sm4RoundProfile({ ...opts, onLog, startRound, endRound, rounds })
    return {
      best: prof.best || prof.chars?.[0] || null,
      perRound: prof.perRound || [],
      path: 'sm4',
    }
  }

  /* ★ 完整 AES-128 / PRESENT-64：走 spnprofile.js 的专用 SPN 单元引擎。
     ⚠️ 不能落到下面的通用图路径 —— 那条路径的状态是单个 32bit 字，
        128bit / 64bit 状态塞进去只会得到错的数（这正是本项目反复踩过的坑：
        界面选的是 AES，算出来的却是「32bit 类 AES 教学模型」）。 */
  if (opts.engine === 'aes' || opts.engine === 'present') {
    /* 搜索参数：界面上的「束宽 / 分支上限」原本是给 SM4 那条 Feistel 迭代调过的
       （默认 8），在 16 个单元的 SPN 上明显偏窄 —— 实测 PRESENT 14 轮宽 8 给出
       2^-175 这种远差于文献（2^-62）的松上界。这里取 max(界面值, 该算法实测默认值)，
       调大可生效、调小不会把结果弄差，且**每次都记一条日志**，不做静默调参。 */
    const dflt = SPN_CIPHERS[opts.engine].defaults || {}
    const uiBeam = Number(opts.beamWidth) || 8
    const beam = Math.max(uiBeam, dflt.beamWidth || 32)
    if (beam !== uiBeam) {
      onLog('info', `${opts.engine === 'aes' ? 'AES' : 'PRESENT'} SPN 引擎束宽取 ${beam}`
        + `（界面值 ${uiBeam} 低于该算法的实测合适值，已按默认下限抬高）`)
    }
    const prof = spnProfile({
      cipher: opts.engine,
      mode: opts.mode,
      startRound, endRound, rounds,
      beamWidth: beam,
      // 界面没显式设分支上限（params 里 0 = 自动）→ 用该算法的实测默认
      branchLimit: Number(opts.branchLimit) > 0 ? Number(opts.branchLimit) : undefined,
      model: opts.model,
      lambda: opts.lambda,
      snr: opts.snr,
      initCells: cellsFromInitDiffs(opts.initDiffs, opts.engine),
      onLog,
    })
    return {
      best: prof.best,
      perRound: prof.perRound || [],
      path: prof.path,
      ok: prof.ok,
      /* 引擎里**实际生效**的搜索参数 —— 界面值低于该算法实测下限时会被抬高，
         不把生效值带回去，结果页与对比栏就会显示一个不是本次真正用过的束宽。 */
      used: prof.meta
        ? {
          beamWidth: prof.meta.beamWidth,
          branchLimit: prof.meta.branchLimit,
          startVariants: prof.meta.startVariants,
        }
        : null,
    }
  }

  if (opts.structure === 'feistel') {
    const prof = feistelGraphProfile(graph.value, {
      mode: opts.mode,
      blockBits: opts.blockBits,
      startRound, endRound, rounds,
      model: opts.model, lambda: opts.lambda, snr: opts.snr, onLog,
      initDiffs: opts.initDiffs,   // ← 界面「起始差分」现在两条通用图路径都认
    })
    if (prof.best) return { best: prof.best, perRound: prof.perRound || [], path: 'feistel-graph' }
    onLog('warn', `Feistel 图迭代没跑起来（${prof.reason || '图结构不完整'}），改用通用图传播路径`)
  }

  const res = analyze(graph.value, {
    mode: opts.mode,
    startRound, endRound, rounds,
    blockBits: opts.blockBits,
    onLog,
    searchMode: opts.searchDepth === 'greedy' ? 'greedy' : 'bb',
    maxCandidates: opts.maxCandidates,
    timeBudgetMs: opts.timeBudgetMs,
    model: opts.model,
    lambda: opts.lambda,
    snr: opts.snr,
    // ⚠️ 从前这里漏了 initDiffs —— 界面填了「起始差分」，通用图路径依旧从
    //    最低位 1 起步（只有 SM4 专用引擎读它）。现在一路传到引擎。
    initDiffs: opts.initDiffs,
  })
  // ⚠️ 必须在「完整轮数」里选最优 —— 权重随轮数单调递增，
  //    在全部轮次里取最小会永远返回第 1 轮那条。
  const full = (res?.characteristics || []).filter((c) => c.rounds === rounds)
  const pool = full.length ? full : (res?.characteristics || [])
  return {
    best: pool.reduce((a, b) => (!a || b.weight < a.weight ? b : a), null),
    perRound: res?.perRound || [],
    path: 'graph',
    ok: res?.ok,
  }
}

let running = false

/**
 * 执行一次分析。
 * 全流程：装配参数 → 调引擎 → 归一化结果 → 建模统计 → 中文解析。
 */
export async function runAnalysis(overrides = {}) {
  if (running) return null
  /* `forceRun` 是本函数的控制位，不是搜索参数 —— 先摘掉，别让它混进
     `opts`（结果页「本次使用的参数」会把它列出来，看起来像个真实参数）。 */
  const { forceRun: wantRun, ...restOverrides } = overrides || {}
  running = true
  status.value = 'running'
  lastError.value = ''
  empirical.value = null

  progress.value = 0
  progress.phase = '准备'
  progress.label = '装配参数…'

  const opts = searchOptions(restOverrides)
  const r = { start: opts.startRound, end: opts.endRound, rounds: opts.endRound - opts.startRound + 1 }
  const spec = MODEL_SPEC[opts.model]
  const isLinear = opts.mode === MODE.LINEAR

  /* 引擎分流：图上带 `engine: 'sm4'` 的（内置 SM4 模板）走专用引擎，
     其余一律走通用图引擎 —— 也就是说「图怎么画，就怎么算」。
     ⚠️ 从前这里是 `mode === LINEAR || structure === 'feistel'`：
        前者让**所有**线性分析都跑 SM4 专用引擎（图被忽略），
        后者让所有 feistel 图被忽略 —— 两个都是真缺陷。 */
  const useSm4 = opts.engine === 'sm4'
  const useSpn = opts.engine === 'aes' || opts.engine === 'present'
  const useFeistelGraph = !useSm4 && !useSpn && opts.structure === 'feistel'

  // 图标记了没有引擎的结构（只可能来自导入的 JSON）：明说它按 SPN 算。
  // 不这样做的后果和「缺陷①」是同一类 —— 界面上的标记与真实计算对不上。
  const declared = graph.value?.meta?.structure
  if (!useSm4 && declared && !STRUCTURES.includes(declared)) {
    log('warn', `图标记的结构类型「${UNSUPPORTED_STRUCTURES[declared] || declared}」没有对应引擎，`
      + '已按 SPN 通用图传播计算 —— 请在结构编辑器里改选 SPN 或 Feistel')
  }

  log('info', `引擎：${useSm4 ? 'SM4 专用迭代（内置模板）'
    : useSpn ? `${opts.engine === 'aes' ? 'AES-128' : 'PRESENT-64'} 专用 SPN 单元引擎（内置模板）`
      : useFeistelGraph ? `Feistel 图迭代（分支宽度 ${opts.blockBits}bit）`
        : `通用图传播（词宽 ${opts.blockBits}bit）`}`)

  log('info', '─'.repeat(52))
  log('info', `开始${isLinear ? '线性' : '差分'}分析：第 ${r.start}~${r.end} 轮（跨 ${r.rounds} 轮）`)
  log('info', `搜索模型 ${spec.name}（${spec.short}）｜${spec.formula}`)
  log('info', `搜索策略 ${opts.searchDepth}｜束宽 ${opts.beamWidth}｜候选上限 ${opts.maxCandidates}`
    + `｜分支上限 ${opts.branchLimit ?? '自动'}｜时间预算 ${opts.timeBudgetMs} ms`)

  // 让浏览器有机会把上面这些日志画出来，再做重活
  await nextFrame()

  const t0 = performance.now()
  let char = null
  let perRound = []
  let error = ''
  let usedParams = null
  /** 后端求解的附加信息（已解到第几轮、是否命中缓存、哪些轮还是缺口） */
  let backend = null
  /** 本次是否被后端子进程护栏中止（超时 ≠ 失败，已落盘的轮次照样能显示） */
  let backendTimedOut = false

  try {
    /* ★ 结果只来自后端 BCA 的**全空间精确求解**。
     *
     * 浏览器内引擎（束搜索）给出的是权重上界 —— 5 轮起必然劣于全空间最优
     * （实测 30 vs 12），两个口径并排摆着只会让人以为算错了。页面现在只认
     * 后端这一份：kissat 从 0 往上判定到第一个 SAT，既是下界又可达，即真值。
     *
     * 没有后端实现的模板（PRESENT / 类-AES / 自定义图）或模型（映射 / 双权）
     * 在这里**直接报错**，绝不悄悄退回前端引擎 —— 那又会变成「界面显示的和
     * 实际算的不是一回事」，正是本项目反复踩过的那类缺陷。
     */
    const channel = bcaChannel({
      engine: opts.engine, model: opts.model, mode: opts.mode,
    })
    if (!channel.ok) throw new Error(channel.reason)

    /* 「起始差分」是**前端的起点族**参数：引擎从你给的这几个起点出发做束搜索。
     * 后端 BCA 走的是**整个输入差分空间**的全空间 SAT —— 它不接受起点，
     * 也不区分你填了什么。若放行，界面上写着 `0,0,0,1`、数字却是全空间最小值，
     * 就是「两个不同的问题共用一个数」（§4.37 那类错）。所以直接挡住。 */
    if (Array.isArray(opts.initDiffs) && opts.initDiffs.length) {
      throw new Error('后端 BCA 做的是**整个输入差分空间**的全空间搜索，不接受指定起点：'
        + `「起始差分」里填的 ${String(params.initDiffs).trim()} 不会被使用，`
        + '拿回来的是全空间最小权重 —— 与「从指定起点出发」不是同一个问题。'
        + '请清空「起始差分」；若要看某个具体起点，请用 /bca/ 页查看原始记录后手工对照。')
    }

    /* 后端只实现了**标准算法本体**（SM4 / AES 的官方结构）。
     * 图一旦被改过（仅 τ、换 S 盒、改线性层、加节点…），后端算的仍然是标准算法 ——
     * 界面上你看到的是「改过的图」，拿回来的却是「没改过的数」，这是最难发现的一类错。
     * 所以用结构指纹挡住：与内置模板不一致就拒绝走后端，而不是静默给个别的答案。 */
    const tpl = TEMPLATES[templateId.value]
    if (tpl && tpl.build
      && structureSignature(graph.value) !== structureSignature(tpl.build())) {
      throw new Error('这张图已被修改过（结构 / S 盒 / 轮函数与内置模板不一致），'
        + `而后端 BCA 只实现了标准 ${channel.cipher} —— 它会按标准算法算，`
        + '不会按你改过的结构算。请先恢复模板，或把改动提交给后端实现后再跑。')
    }

    /* 轮号语义必须对齐：BCA 的 `R{n}-P{w}` 是「第 1 轮累计到第 n 轮」的绝对值。
       起始轮 > 1 时前端会在同一段上再算一遍，与后端口径不同 —— 这里直接挡住，
       免得界面上出现一个"第 5–10 轮"却报告"1–10 轮累计权重"的数。 */
    if (Number(r.start) !== 1) {
      throw new Error('后端 BCA 的轮号是「从第 1 轮累计到第 N 轮」的绝对值，'
        + `起始轮必须为 1（当前填的是第 ${r.start} 轮）。`
        + '请把「起始轮」改为 1；要看「第 5 轮起」的表现，用逐轮表里的第 5~N 行。')
    }

    progress.phase = '后端求解'
    progress.label = `提交 ${channel.cipher} / ${channel.model} 任务…`
    progress.value = 10

    /* 线性必须**真跑**：线性权重是「搜完逐盒查 |LAT| 回填」的，只存在于 summary 里；
       `cache` / 命中覆盖的 `auto` 通道返回 `summary: null`，只剩 AS 阶段的活跃盒数。
       拿那个数当 −log₂p 会把线性强度说小好几 bit（SM4 4 轮：1 vs 6）。 */
    const solveMode = channel.attack === 'linear' ? 'run' : BCA_ANALYSIS_MODE

    log('info', '─'.repeat(52))
    log('info', `后端 BCA 精确求解：${channel.cipher} / ${channel.model} / ${channel.attack}`)
    log('info', `轮数区间 ${r.start}–${r.end}｜任务 ${BCA_ANALYSIS_TASK}｜模式 ${solveMode}`)
    log('info', '全空间 SAT：概率权重从 0 往上判定到第一个可满足 —— 给出的是真值，不是上界')

    await nextFrame()

    const payloadBase = {
      cipher: channel.cipher,
      model: channel.model,
      attack: channel.attack,
      rounds: [r.start, r.end],
      task: BCA_ANALYSIS_TASK,
    }

    /* ── 先用只读通道把「已经解出来的轮」立刻画出来，再让后端在后台继续推进 ──
     *
     * 为什么：`run` 是同步长请求，32 轮一定跑满 120s 护栏才返回。期间页面只有
     * 一个停在 29% 的进度条，演示时看起来像卡死 —— 而真实情况是后端早在预热时
     * 就把 1~8 轮解完了，这些数一直躺在 results.csv 里。
     *
     * `cache` 只读产物、不碰求解器（实测 336ms）。有记录就先渲染已解轮次，
     * 其余轮次由页面标「还未求解」；同时**不等待**地发一个 `run` 让后端继续
     * 往后推进（断点续跑，已完成的轮次不会重算）。下次点击/刷新就能读到更多。
     *
     * ⚠️ 线性不走这条捷径：线性权重只在一次完整求解的 `summary` 里，
     *    `cache` 返回 `summary: null`，拿它渲染会报「没有线性权重」。
     */
    let resp = null
    /* `forceRun` = 用户在「第 N–M 轮还未求解」提示条上点了「继续求解」。
       这时才真的发长请求去推进；平时「运行分析」只读已有记录（0.6s 秒出）。
       区分这两件事很重要：后端同一时刻只允许一个搜索进程，自动长跑会把
       随后切到线性/别的算法的请求全判成 busy。 */
    const forceRun = Boolean(wantRun)
    if (!forceRun && channel.attack !== 'linear' && solveMode !== 'cache') {
      const peek = await api.bcaRun({ ...payloadBase, mode: 'cache' }).catch(() => null)
      /* 只看请求区间内的轮次：CSV 里可能还有超出 end 的行（预热时多跑过几轮），
         拿它们冒充「区间全覆盖」会让页面少标几行「还未求解」。 */
      const solved = peek?.ok
        ? [...bestRows(peek.records).keys()]
          .filter((x) => x >= r.start && x <= r.end)
          .sort((a, b) => a - b)
        : []
      if (solved.length) {
        resp = peek
        const full = solved.length === r.rounds
        log('info', `已有记录：第 ${solved[0]}–${solved[solved.length - 1]} 轮（共 ${solved.length} 轮）`
          + '先显示出来')
        if (!full) {
          progress.label = `已显示 ${solved.length}/${r.rounds} 轮`
          log('warn', `第 ${solved[solved.length - 1] + 1}–${r.end} 轮**还未求解**。`
            + '要推进到更多轮次，点结果上方的「继续求解剩余轮次」——'
            + '那会真的让后端跑，时间取决于从哪一轮开始（全空间 SAT 越往后越慢）。')
        }
      }
    }

    if (!resp) {
      resp = await solveWithBca({
        cipher: channel.cipher,
        model: channel.model,
        attack: channel.attack,
        rounds: [r.start, r.end],
        task: BCA_ANALYSIS_TASK,
        mode: solveMode,
        run: api.bcaRun,
        progress: api.bcaProgress,
        onProgress: (p) => {
          const done = (p?.finished || []).filter((x) => x >= r.start && x <= r.end)
          // 只画到 85%：最后一段留给"整理结果"，否则进度条先满再等很难看
          progress.value = Math.min(85, 10 + Math.round((done.length / Math.max(1, r.rounds)) * 75))
          progress.label = done.length
            ? `后端已完成 ${done.length}/${r.rounds} 轮（第 ${done[done.length - 1]} 轮）`
            : '等待后端落盘第一轮…'
        },
      })
    }

    if (!resp?.ok) {
      /* ⚠️ **超时不等于失败**：见 `usableResponse` 的注释 —— 32 轮一定撞上 120s
         护栏，`partial` 里就是已落盘的轮次。把它当失败抛掉，页面就成了"点了没反应"，
         而真相是"跑到了第 8 轮"。 */
      const usable = usableResponse(resp)
      if (!usable) {
        throw new Error(resp?.error
          || `后端求解失败（reason=${resp?.reason || 'unknown'}）`)
      }
      backendTimedOut = usable.timedOut
      log('warn', `后端在 ${usable.timeout ?? resp?.timeout ?? '?'}s 护栏处被中止：`
        + '只拿回已落盘的轮次，剩下的标「还未求解」。'
        + '再点一次「运行分析」会从断点继续（已完成的轮次不会重算）。')
      resp = usable.data
    }

    progress.value = 90
    progress.label = '整理逐轮结果…'

    const built = buildFromBca(resp, { startRound: r.start, endRound: r.end })
    char = built.char
    perRound = built.perRound
    backend = {
      task: built.task,
      complete: built.complete,
      solvedThrough: built.solvedThrough,
      pendingRounds: built.pendingRounds,
      cached: Boolean(resp.cached),
      respMode: resp.mode || null,
      summary: built.summary,
      /* 连点两次时第二次拿不到锁，改为跟随已在跑的那次 —— 结果来源要说清是
         「沿用进行中的任务」，否则用户会以为这一下点出了新结果。 */
      followed: Boolean(resp.followed),
      stalled: Boolean(resp.stalled),
      /* 超时中止要**如实标出来**：界面写「部分求解」但不解释为什么停在第 8 轮，
         用户会以为后端算不动了；真实原因是护栏到了、断点还在。 */
      timedOut: backendTimedOut,
    }

    if (resp.followed) {
      log('info', '已有一个后端搜索在跑，本次**跟随它的进度**读回结果'
        + '（同一任务同一模型，不会重复求解）。')
    }

    if (!char) {
      /* 线性「一条都没解出来」多半不是没跑过，而是这次没拿回 summary
         （护栏中止 / 请求范围太大）—— 说清原因，别让人以为后端坏了。 */
      error = built.linearMissingSummary
        ? '这次只拿到搜索阶段的记录，没有线性权重的回填值（−log₂p 是搜完逐盒查 |LAT| 得来的，'
          + '它只在一次完整求解的 summary 里）。请缩小轮数区间、或再点一次「运行分析」重跑这一段'
          + '（断点续跑，已完成的格会跳过）。'
        : `后端还没有第 ${r.start}–${r.end} 轮的任何结果（这个区间一次都没跑过）。`
          + '任务已经提交过后端，跑完再点一次「运行分析」即可读回已落盘的轮次。'
    } else if (built.pendingRounds.length) {
      log('warn', `后端只求解到第 ${built.solvedThrough} 轮：`
        + `第 ${built.pendingRounds[0]}–${built.pendingRounds[built.pendingRounds.length - 1]} 轮`
        + '**还未求解**（全空间 SAT 是逐轮递增的，越往后越慢）。'
        + '本轮只报告已解到的部分，不拿它当整段区间的结论。')
    } else {
      const from = resp.followed ? '沿用进行中的任务' : (resp.cached ? '命中已有记录' : '本次实跑')
      log('info', `后端返回 ${built.perRound.length} 轮全部已求解（${from}）`)
    }
  } catch (err) {
    error = err?.message || String(err)
    log('error', `分析异常：${error}`)
  }

  const elapsedMs = performance.now() - t0
  progress.value = 100
  progress.phase = '完成'

  if (error) {
    status.value = 'error'
    lastError.value = error
    progress.label = '失败'
    log('error', error)
    running = false
    return null
  }

  // ── 归一化 ──
  /* ⚠️ 只统计**已求解**的轮次：后端可能只跑到第 8 轮就还在继续，perRound 里
     第 9~32 轮是 `pending` 占位。把它们算进平均、或拿最后一行的 null 当累计
     权重，都会得到 NaN 或一个凭空缩小的"平均每轮权重"。 */
  const solvedRows = perRound.filter((x) => !x.pending)
  const finalRound = solvedRows.length ? solvedRows[solvedRows.length - 1] : null
  const cumulativeWeight = finalRound ? finalRound.weight : (char ? char.weight : null)
  const cumActive = finalRound ? finalRound.cumActive : (char ? char.activeSboxes : null)
  /** 实际解到的轮数（不是请求的轮数）—— 分子分母必须同源 */
  const solvedRounds = char?.rounds ?? r.rounds
  const solvedEnd = char?.endRound ?? r.end

  const metrics = {
    elapsedMs,
    rounds: solvedRounds,
    startRound: r.start,
    endRound: solvedEnd,
    /* 计划区间的轮数：页面要能说清「请求了 32 轮、已解到 8 轮」 */
    requestedRounds: r.rounds,
    requestedEnd: r.end,
    weight: cumulativeWeight,
    bitsPerRound: Number.isFinite(cumulativeWeight) && solvedRounds
      ? cumulativeWeight / solvedRounds
      : null,
    activeSboxes: cumActive,
    activePerRound: Number.isFinite(cumActive) && solvedRounds
      ? cumActive / solvedRounds
      : null,
    dataComplexity: char.dataComplexity ?? null,
    timeComplexity: char.timeComplexity ?? null,
    memoryComplexity: char.memoryComplexity ?? null,
    keyGuesses: char.keyGuesses ?? null,
    // 「命中率」：单轮命中率 = 每轮走在预测差分上的比例，2^-(每轮权重)
    perRoundHitRate: Number.isFinite(cumulativeWeight) && solvedRounds
      ? Math.pow(2, -cumulativeWeight / solvedRounds)
      : null,
    mapWeight: char.mapWeight ?? null,
    diffusionWeight: char.diffusionWeight ?? null,
    dualScore: char.dualScore ?? null,
    mapSizeLog10: char.mapSizeLog10 ?? null,
    // 时间预算是否触顶 —— 后端求解没有这个预算，恒 false（字段保留，页面不用改）
    budgetHit: false,
  }

  const model = buildModel(graph.value, {
    mode: opts.mode,
    startRound: r.start,
    endRound: r.end,
    rounds: r.rounds,
    blockBits: opts.blockBits,
    auxVars: params.auxVars,
    guessRounds: opts.guessRounds,
  })

  result.value = {
    at: Date.now(),
    mode: opts.mode,
    /* `usedParams` 覆盖的是「引擎实际用的」值（界面值可能被算法下限抬高）。
       放在后面覆盖，结果页与对比栏读到的就是本次真正生效的束宽/分支上限。 */
    params: usedParams ? { ...opts, ...usedParams } : { ...opts },
    metrics,
    model,
    char,
    perRound,
    spec,
    /* 后端求解的元信息：解到第几轮、是否命中缓存、哪些轮还是缺口。
       结果页据此决定显示"精确值"还是"还未求解"。 */
    backend,
    empirical: null,
  }

  const weightText = Number.isFinite(cumulativeWeight) ? cumulativeWeight.toFixed(2) : '—'
  const avgText = Number.isFinite(metrics.bitsPerRound) ? metrics.bitsPerRound.toFixed(2) : '—'
  log('ok', `后端精确求解完成：第 ${r.start}–${solvedEnd} 轮 −log₂p = ${weightText}，`
    + `${cumActive ?? '—'} 个活跃 S 盒，平均 ${avgText} bit/轮，`
    + `用时 ${elapsedMs.toFixed(0)} ms${backend?.cached ? '（命中已有记录）' : ''}`)
  if (backend && !backend.complete) {
    log('warn', `区间 ${r.start}–${r.end} 只解到第 ${solvedEnd} 轮，`
      + `第 ${backend.pendingRounds[0]}–${backend.pendingRounds[backend.pendingRounds.length - 1]} 轮`
      + '还未求解（页面显示「还未求解」，不把上界当前值）')
  }

  status.value = 'done'
  progress.label = '已完成'
  running = false
  saveSession()
  return result.value
}

/**
 * 全轮扫描：从当前起始轮起，逐轮增加长度，画一条收敛曲线。
 *
 * ★ 与「运行分析」走同一条后端链路 —— 从前这里自己调前端引擎，于是对同一组
 *   参数，扫描曲线上的点和结果页的数字可能来自两个不同的求解器（一个上界、
 *   一个真值）。现在两边都只认后端 BCA 的精确值。
 *
 * 只发**一次**请求（要整段 1..hi）：BCA 本来就是逐轮递增求解的，逐点发请求
 * 会把同一批 CNF 重复解一遍，代价和收益完全不成比例。
 */
export async function scanAllRounds({ step = 2, from = null, to = null, onTick = null } = {}) {
  const r = effectiveRange.value
  const lo = from ?? Math.max(r.start, 4)
  const hi = to ?? r.end
  const opts = searchOptions()
  const threshold = Number(params.weightThreshold) || 0

  log('info', `─ 全轮扫描：${lo} → ${hi}（步长 ${step}）`)

  const channel = bcaChannel({
    engine: opts.engine, model: opts.model, mode: opts.mode,
  })
  if (!channel.ok) {
    log('error', channel.reason)
    return []
  }
  if (Number(r.start) !== 1) {
    log('error', '后端 BCA 的轮号是「从第 1 轮累计到第 N 轮」的绝对值，'
      + `起始轮必须为 1（当前是第 ${r.start} 轮），扫描未执行`)
    return []
  }

  let resp = await solveWithBca({
    cipher: channel.cipher,
    model: channel.model,
    attack: channel.attack,
    rounds: [1, hi],
    task: BCA_ANALYSIS_TASK,
    mode: channel.attack === 'linear' ? 'run' : BCA_ANALYSIS_MODE,
    run: api.bcaRun,
    progress: api.bcaProgress,
    onProgress: (p) => {
      const done = (p?.finished || []).filter((x) => x >= 1 && x <= hi)
      log('debug', `后端进度：已完成 ${done.length}/${hi} 轮`)
    },
  })

  if (!resp?.ok) {
    /* 同 runAnalysis：护栏中止但已落盘部分照样画出来，别让一次超时清空整张扫描表 */
    const usable = usableResponse(resp)
    if (!usable) {
      log('error', `后端扫描失败：${resp?.error || resp?.reason || '未知原因'}`)
      return []
    }
    log('warn', `后端在 ${usable.timeout ?? '?'}s 护栏处被中止，只画已落盘的轮次`)
    resp = usable.data
  }

  const built = buildFromBca(resp, { startRound: 1, endRound: hi })
  const byRound = new Map(built.perRound.map((x) => [x.round, x]))
  const out = []

  for (let rounds = lo; rounds <= hi; rounds += step) {
    const row = byRound.get(rounds)
    if (!row || row.pending) continue

    const item = {
      rounds,
      endRound: rounds,
      weight: row.weight,
      bitsPerRound: row.weight / rounds,
      activeSboxes: row.activeSboxes,
      elapsedMs: 0,   // 后端不逐轮回报耗时；留着字段免得页面改结构
    }
    out.push(item)
    log('debug', `${String(rounds).padStart(2)} 轮 → −log₂p=${row.weight.toFixed(2)}`
      + `（${item.bitsPerRound.toFixed(2)} bit/轮）`)
    if (onTick) onTick(item)

    // 权重阈值：超过就停止加轮（这就是"权重"这个自定义项的用途）
    if (threshold > 0 && row.weight > threshold) {
      log('warn', `累计权重 ${row.weight.toFixed(2)} 已超过阈值 ${threshold}，提前结束扫描`)
      break
    }

    // 让出主线程，界面不至于卡死
    await nextFrame()
  }

  const missing = built.pendingRounds.filter((x) => x >= lo && x <= hi)
  if (missing.length) {
    log('warn', `第 ${missing[0]}–${missing[missing.length - 1]} 轮后端还未求解，`
      + '扫描曲线到已有轮次为止')
  }
  log('ok', `全轮扫描完成：共 ${out.length} 个轮数点`)
  return out
}

/* ---------------------------------------------------------------- 抽样命中率 */

/**
 * 用真实加密抽样验证当前最优特征。
 * 只在轮数较少时有意义 —— 大轮数会诚实返回"不可行"。
 */
export async function runEmpirical({ samples = 200000 } = {}) {
  const res = result.value
  if (!res?.char) {
    log('warn', '请先运行一次分析，再进行抽样验证')
    return null
  }
  if (empiricalRunning.value) return null

  // 抽样验证要拿**真实加密**去比对，而真实加密目前只有 SM4 的参考实现。
  // 自定义结构没有对应的前向加密，硬跑只会得到「命中 0 次」这种看起来像
  // 「特征算错了」的假结论 —— 所以这里直接拒绝，而不是编一个数字。
  if (searchOptions().engine !== 'sm4') {
    log('warn', '抽样验证目前只对标准 SM4 有意义（用真实 SM4 加密比对明密文对）。'
      + '自定义结构请改用逐轮统计与中文解析来校验。')
    return null
  }

  empiricalRunning.value = true
  log('info', `抽样验证：用真实 SM4 加密随机明文对，检验最优特征的实际命中率`)

  await nextFrame()

  try {
    const rep = empiricalHitRate(res.char, {
      samples,
      maxBits: 30,
      onProgress: (done, total) => {
        progress.value = Math.round((done / total) * 100)
        progress.label = `抽样 ${done}/${total}`
      },
    })
    empirical.value = rep

    if (rep.feasible) {
      log(rep.level === 'good' ? 'ok' : 'warn',
        `${rep.rounds} 轮经验命中率：${(rep.measured * 100).toFixed(4)}%`
        + `（理论 ${(rep.expected * 100).toFixed(4)}%，样本 ${rep.samples}，命中 ${rep.hits} 次）`)
      log('info', rep.verdict)
    } else {
      log('warn', rep.reason || rep.verdict)
    }
    return rep
  } catch (err) {
    log('error', `抽样验证失败：${err?.message || err}`)
    return null
  } finally {
    empiricalRunning.value = false
    progress.value = 0
    progress.label = ''
    saveSession()
  }
}

/* ---------------------------------------------------------------- 解析（派生） */

export const explanation = computed(() => {
  graphRev.value // ← 否则删/加节点、改属性后中文解析文案不更新（实测过：删掉 S 盒节点文案不变）
  return explainGraph(graph.value)
})

export const characteristicExplain = computed(() =>
  result.value ? explainCharacteristic(result.value.char, currentSboxStats.value) : null)

export const securityExplain = computed(() =>
  result.value
    ? explainSecurity(result.value.char, currentSboxStats.value, modelInfo.value)
    : [])

export const currentSboxStats = computed(() => {
  const sb = sboxLib.getSBoxByRef('sm4')
  return sb ? sboxLib.stats(sb) : null
})

/* ---------------------------------------------------------------- 导入 / 导出 */

const EXPORT_VERSION = 1

export function exportProject() {
  const payload = {
    format: 'cipher-analysis-project',
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    templateId: templateId.value,
    graph: graph.value.toJSON(),
    params: { ...params },
    mode: mode.value,
    result: result.value
      ? {
        at: result.value.at,
        metrics: result.value.metrics,
        perRound: result.value.perRound,
        characteristic: {
          mode: result.value.char?.mode,
          startRound: result.value.char?.startRound,
          endRound: result.value.char?.endRound,
          rounds: result.value.char?.rounds,
          weight: result.value.char?.weight,
          activeSboxes: result.value.char?.activeSboxes,
          inputState: result.value.char?.inputState,
          outputState: result.value.char?.outputState,
          mapWeight: result.value.char?.mapWeight,
          diffusionWeight: result.value.char?.diffusionWeight,
          dualScore: result.value.char?.dualScore,
        },
      }
      : null,
    logs: logs.value.slice(-300),
  }
  log('info', '已导出工程 JSON（含结构、参数、结果与最近 300 条日志）')
  return payload
}

export function importProject(data) {
  if (!data || typeof data !== 'object') throw new Error('文件内容不是合法 JSON 对象')
  if (data.format !== 'cipher-analysis-project') {
    throw new Error('不是本平台导出的工程文件（缺少 format 标识）')
  }
  if (Number(data.version) > EXPORT_VERSION) {
    throw new Error(`工程文件版本 v${data.version} 高于当前支持的 v${EXPORT_VERSION}，请升级后再试`)
  }

  clearResult()

  if (data.graph) {
    setGraph(CipherGraph.fromJSON(data.graph))
    templateId.value = data.templateId || 'custom'
  }
  if (data.params) {
    Object.assign(params, { ...PARAM_DEFAULTS, ...data.params })
    saveParams()
  }
  if (['differential', 'linear'].includes(data.mode)) mode.value = data.mode

  log('ok', `已导入工程：${data.graph?.meta?.name || '未命名'}，`
    + `${data.graph?.nodes?.length || 0} 个节点`)
  if (data.result) {
    log('info', `文件内含一份历史结果（−log₂p = ${data.result.metrics?.weight?.toFixed?.(2) ?? '?'}），`
      + '仅供查看，未重新计算 —— 需要最新数据请点「运行分析」。')
  }
  return true
}

/** 下载 JSON 到本地 */
export function downloadJSON(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  // 立刻 revoke 在部分浏览器会打断下载，延后一点
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

/* ---------------------------------------------------------------- 工具 */

/** 让出一帧，好让 Vue 把 loading 状态画出来再干重活 */
function nextFrame() {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => setTimeout(resolve, 0))
    else setTimeout(resolve, 0)
  })
}

export const isFeistel = computed(() => {
  graphRev.value // ← meta.structure 也是就地改的
  return graph.value?.meta?.structure === 'feistel'
})

export const modeLabel = computed(() => (mode.value === MODE.LINEAR ? '线性分析' : '差分分析'))

/* ---------------------------------------------------------------- 启动时恢复 */

// 放在文件末尾：此时所有 const 都已初始化（restoreSession 内部要用到
// logs / result / graph 等），避免踩 TDZ。
restoreSession()
