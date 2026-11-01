<script setup>
// 多页形态下 404 页也要能自己回到总览：用的是原生链接，不是客户端路由
import { href } from '@/pages.js'
</script>

<template>
  <div class="card">
    <div class="card-body" style="text-align: center; padding: 56px 20px">
      <div class="code mono">404</div>
      <h2 style="margin: 8px 0 6px; font-size: 17px">页面不存在</h2>
      <p class="muted" style="margin: 0 0 20px">
        当前地址没有对应的前端路由。如果你是从旧书签进来的，对应页面可能已经调整过。
      </p>
      <a class="btn btn-primary" :href="href('home')">回到总览</a>
    </div>
  </div>
</template>

<style scoped>
.code {
  font-size: 40px;
  font-weight: 700;
  color: var(--border-strong);
  letter-spacing: 0.04em;
}
</style>
