<script setup>
// ── ECharts 轻封装：标题 + 专属骨架加载动效 + 优雅空态 + 自适应容器 ─────────────
import { onMounted, onBeforeUnmount, ref, shallowRef, watch, nextTick } from 'vue'
import * as echarts from 'echarts/core'
import { BarChart, LineChart, PieChart } from 'echarts/charts'
import { GridComponent, TooltipComponent, LegendComponent, GraphicComponent, MarkPointComponent, MarkLineComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'

echarts.use([
  BarChart, LineChart, PieChart,
  GridComponent, TooltipComponent, LegendComponent, GraphicComponent, MarkPointComponent, MarkLineComponent,
  CanvasRenderer
])

const props = defineProps({
  title: { type: String, default: '' },
  subtitle: { type: String, default: '' },
  badge: { type: String, default: '' },
  option: { type: Object, default: null },
  height: { type: Number, default: 230 },
  empty: { type: String, default: '' }, // 空态主文案
  emptySub: { type: String, default: '' }, // 空态补充说明
  loading: { type: Boolean, default: false }, // 加载动效控制
  skeletonType: { type: String, default: 'line' }, // 'line' | 'bar' | 'pie' | 'rank'
})

const el = ref(null)
const chart = shallowRef(null)
let ro = null

function init() {
  if (!el.value || chart.value) return
  chart.value = echarts.init(el.value)
  if (props.option) chart.value.setOption(props.option)
  ro = new ResizeObserver(() => chart.value?.resize())
  ro.observe(el.value)
}

onMounted(() => {
  if (props.option && !props.loading) init()
})

watch(() => props.option, async opt => {
  if (!opt || props.loading) return
  await nextTick()
  if (!chart.value) init()
  else chart.value.setOption(opt, true)
})

watch(() => props.loading, async isLoading => {
  if (!isLoading && props.option) {
    await nextTick()
    if (!chart.value) init()
    else chart.value.setOption(props.option, true)
  }
})

onBeforeUnmount(() => {
  ro?.disconnect()
  chart.value?.dispose()
  chart.value = null
})
</script>

<template>
  <div class="chart-card">
    <div class="chart-header">
      <div class="header-left">
        <h3 v-if="title" class="chart-title">{{ title }}</h3>
        <span v-if="subtitle" class="chart-subtitle">{{ subtitle }}</span>
      </div>
      <span v-if="badge" class="chart-badge">{{ badge }}</span>
    </div>

    <!-- 加载中：定制骨架屏加载动效 -->
    <div v-if="loading" class="chart-loading-box" :style="{ height: height + 'px' }">
      <!-- 曲线趋势骨架 -->
      <div v-if="skeletonType === 'line'" class="skel-line-canvas">
        <svg class="skel-svg" viewBox="0 0 420 150" preserveAspectRatio="none">
          <defs>
            <linearGradient id="skel-line-grad" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stop-color="#b84a68" stop-opacity="0.12" />
              <stop offset="50%" stop-color="#d86c8a" stop-opacity="0.4" />
              <stop offset="100%" stop-color="#b84a68" stop-opacity="0.12" />
            </linearGradient>
            <linearGradient id="skel-area-grad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="#b84a68" stop-opacity="0.14" />
              <stop offset="100%" stop-color="#ffffff" stop-opacity="0" />
            </linearGradient>
          </defs>
          <line x1="10" y1="30" x2="410" y2="30" class="skel-grid-line" />
          <line x1="10" y1="70" x2="410" y2="70" class="skel-grid-line" />
          <line x1="10" y1="110" x2="410" y2="110" class="skel-grid-line" />
          <path d="M 10 120 Q 70 30, 140 85 T 270 45 T 410 100 L 410 145 L 10 145 Z" fill="url(#skel-area-grad)" class="skel-wave-area" />
          <path d="M 10 120 Q 70 30, 140 85 T 270 45 T 410 100" fill="none" stroke="url(#skel-line-grad)" stroke-width="2.5" stroke-linecap="round" class="skel-wave-stroke" />
        </svg>
      </div>

      <!-- 柱状分布骨架 -->
      <div v-else-if="skeletonType === 'bar'" class="skel-bar-canvas">
        <div class="skel-bar-col" v-for="(h, i) in [32, 60, 42, 85, 68, 48, 92, 38]" :key="i">
          <div class="skel-bar-pill" :style="{ height: h + '%', animationDelay: (i * 0.12) + 's' }"></div>
        </div>
      </div>

      <!-- 环形占比骨架 -->
      <div v-else-if="skeletonType === 'pie'" class="skel-pie-canvas">
        <div class="skel-donut">
          <div class="skel-donut-inner">
            <span class="skel-donut-dot"></span>
          </div>
        </div>
      </div>

      <!-- 横向排行骨架 -->
      <div v-else class="skel-rank-canvas">
        <div class="skel-rank-row" v-for="(w, i) in [86, 68, 52, 36]" :key="i">
          <div class="skel-rank-tag"></div>
          <div class="skel-rank-bar" :style="{ width: w + '%', animationDelay: (i * 0.14) + 's' }"></div>
        </div>
      </div>

      <!-- 优雅加载状态徽标 -->
      <div class="skel-status-pill">
        <div class="skel-spinner"></div>
        <span>正在全量汇总聊天互动指标…</span>
      </div>
    </div>

    <!-- 真实空数据态 -->
    <div v-else-if="!option" class="chart-empty" :style="{ minHeight: (height ? height - 36 : 170) + 'px' }">
      <div class="empty-icon-wrap">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          <path d="M8 10h.01M12 10h.01M16 10h.01" />
        </svg>
      </div>
      <div class="empty-main">{{ empty || '暂无数据' }}</div>
      <div v-if="emptySub" class="empty-desc">{{ emptySub }}</div>
    </div>

    <!-- 真实图表挂载区 -->
    <div v-else ref="el" class="chart-render-el" :style="{ height: height + 'px' }" />
  </div>
</template>

<style scoped>
.chart-card {
  background: #ffffff;
  border: 1px solid #f2e2e7;
  border-radius: 16px;
  padding: 16px 18px 12px;
  min-width: 0;
  box-shadow: 0 3px 12px rgba(45, 20, 30, 0.025);
  display: flex;
  flex-direction: column;
  transition: all 0.25s ease;
}
.chart-card:hover {
  box-shadow: 0 6px 20px rgba(184, 74, 104, 0.06);
  border-color: #ebd0d9;
}

.chart-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
  flex: none;
}
.header-left {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}
.chart-title {
  margin: 0;
  font-size: 13.5px;
  font-weight: 700;
  color: #3e4452;
  letter-spacing: -0.01em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.chart-subtitle {
  font-size: 11px;
  color: #9aa3b2;
  font-weight: 400;
}
.chart-badge {
  font-size: 11px;
  font-weight: 600;
  color: #b84a68;
  background: #fdf2f5;
  border: 1px solid #f6dbe2;
  border-radius: 6px;
  padding: 2px 7px;
  flex: none;
}

/* ── 骨架屏加载容器 ── */
.chart-loading-box {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  width: 100%;
  overflow: hidden;
  border-radius: 10px;
  background: linear-gradient(180deg, #fdfafb, #fbf7f8);
}

/* 曲线骨架 */
.skel-line-canvas {
  width: 100%;
  height: 80%;
  padding: 6px 12px;
  display: flex;
  align-items: center;
}
.skel-svg {
  width: 100%;
  height: 100%;
}
.skel-grid-line {
  stroke: #f3e6ea;
  stroke-width: 1;
  stroke-dasharray: 4 4;
}
.skel-wave-stroke {
  animation: wavePulse 1.8s ease-in-out infinite alternate;
}
.skel-wave-area {
  animation: waveOpacity 1.8s ease-in-out infinite alternate;
}

/* 柱状骨架 */
.skel-bar-canvas {
  width: 100%;
  height: 75%;
  padding: 0 24px;
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 8px;
}
.skel-bar-col {
  flex: 1;
  height: 100%;
  display: flex;
  align-items: flex-end;
  justify-content: center;
}
.skel-bar-pill {
  width: 16px;
  border-radius: 5px 5px 0 0;
  background: linear-gradient(180deg, #eec7d3, #f5e4ea);
  animation: barBreathing 1.4s ease-in-out infinite alternate;
}

/* 环形骨架 */
.skel-pie-canvas {
  width: 100%;
  height: 75%;
  display: flex;
  align-items: center;
  justify-content: center;
}
.skel-donut {
  width: 105px;
  height: 105px;
  border-radius: 50%;
  background: conic-gradient(from 0deg, #d86c8a, #f2c7d3, #e59a68, #d86c8a);
  display: flex;
  align-items: center;
  justify-content: center;
  animation: rotateDonut 3s linear infinite;
  box-shadow: 0 4px 14px rgba(184, 74, 104, 0.12);
}
.skel-donut-inner {
  width: 66px;
  height: 66px;
  border-radius: 50%;
  background: #ffffff;
  display: flex;
  align-items: center;
  justify-content: center;
}
.skel-donut-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #b84a68;
  opacity: 0.6;
  animation: pulseDot 1.2s ease-in-out infinite alternate;
}

/* 排行骨架 */
.skel-rank-canvas {
  width: 100%;
  height: 75%;
  padding: 12px 20px;
  display: flex;
  flex-direction: column;
  justify-content: space-around;
  gap: 8px;
}
.skel-rank-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.skel-rank-tag {
  width: 32px;
  height: 12px;
  border-radius: 4px;
  background: #f0dde3;
}
.skel-rank-bar {
  height: 14px;
  border-radius: 0 6px 6px 0;
  background: linear-gradient(90deg, #eec7d3, #f7e6ec);
  animation: rankBreathing 1.5s ease-in-out infinite alternate;
}

/* 状态徽标 */
.skel-status-pill {
  position: absolute;
  bottom: 12px;
  display: flex;
  align-items: center;
  gap: 7px;
  background: rgba(255, 255, 255, 0.92);
  border: 1px solid #f2dae1;
  border-radius: 999px;
  padding: 4px 12px;
  box-shadow: 0 2px 8px rgba(184, 74, 104, 0.08);
  backdrop-filter: blur(4px);
}
.skel-status-pill span {
  font-size: 11.5px;
  font-weight: 500;
  color: #a84260;
}
.skel-spinner {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  border: 1.8px solid #edd3db;
  border-top-color: #b84a68;
  animation: spin 0.8s linear infinite;
}

/* ── 空态 ── */
.chart-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 18px 20px;
  text-align: center;
}
.empty-icon-wrap {
  width: 44px;
  height: 44px;
  border-radius: 12px;
  background: #fbf5f7;
  border: 1px solid #f5e4ea;
  color: #ba8c9b;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 2px;
}
.empty-main {
  font-size: 12.5px;
  font-weight: 600;
  color: #6e7686;
}
.empty-desc {
  font-size: 11px;
  color: #9da7b7;
  max-width: 240px;
  line-height: 1.45;
}

.chart-render-el {
  width: 100%;
}

/* ── 关键帧动效 ── */
@keyframes wavePulse {
  0% { opacity: 0.5; stroke-width: 2px; }
  100% { opacity: 1; stroke-width: 3.2px; }
}
@keyframes waveOpacity {
  0% { opacity: 0.4; }
  100% { opacity: 0.9; }
}
@keyframes barBreathing {
  0% { opacity: 0.45; transform: scaleY(0.92); }
  100% { opacity: 1; transform: scaleY(1); }
}
@keyframes rankBreathing {
  0% { opacity: 0.5; }
  100% { opacity: 1; }
}
@keyframes rotateDonut {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}
@keyframes pulseDot {
  0% { transform: scale(0.7); opacity: 0.3; }
  100% { transform: scale(1.4); opacity: 1; }
}
@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>
