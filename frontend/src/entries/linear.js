import { mountPage } from './boot.js'
import AnalysisView from '@/views/AnalysisView.vue'

mountPage('linear', AnalysisView, { mode: 'linear' })
