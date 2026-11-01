import { mountPage } from './boot.js'
import AnalysisView from '@/views/AnalysisView.vue'

// 差分与线性共用同一个视图，靠 mode 区分（写两份必然走样）
mountPage('differential', AnalysisView, { mode: 'differential' })
