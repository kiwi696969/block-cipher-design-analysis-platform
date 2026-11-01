<script setup>
/**
 * 折叠面板 —— 说明性内容的统一入口。
 *
 * 本平台的定位是**分析工具**：工作页面上只常驻"当前任务需要的东西"，
 * 算法背景、组件构成、中文解析这类内容按需展开，默认收起。
 *
 * 为什么用原生 <details>/<summary> 而不是自己写开关：
 *   · 零 JS 状态，SSR / 静态渲染都不会闪；
 *   · 浏览器的「页内查找」（Ctrl+F）能命中折叠内容并自动展开；
 *   · 键盘可达、屏幕阅读器语义正确 —— 自己用 div 写要补一堆 aria。
 *
 * ⚠️ 一条测试契约：折叠状态下 `<summary>` 的文本仍然会出现在页面
 *    innerText 里，而面板正文不会。所以**标题必须能独立说明白这块是什么**
 *    （E2E 有断言在查「中文解析」这个词）。
 */
defineProps({
  title: { type: String, required: true },
  /** 标题右侧的灰字补充，如条数、口径 */
  hint: { type: String, default: '' },
  /** 默认是否展开。说明性内容一律默认收起。 */
  open: { type: Boolean, default: false },
})
</script>

<template>
  <details class="fold" :open="open">
    <summary class="fold-head">
      <span>{{ title }}</span>
      <span v-if="hint" class="fold-hint">{{ hint }}</span>
    </summary>
    <div class="fold-body">
      <slot />
    </div>
  </details>
</template>
