import { mountPage } from './boot.js'
import SboxDetailView from '@/views/SboxDetailView.vue'
import { matchPath } from '@/pages.js'

// 详情页的 id 不在服务端模板里（一条路由要接住任意 id），
// 只能从地址栏解析 —— 这是多页站点处理动态路径的标准做法。
const { params } = matchPath(window.location.pathname)

mountPage('sbox-detail', SboxDetailView, { id: params.id || '' })
