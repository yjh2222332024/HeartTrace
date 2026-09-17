<script setup>
// ── 数据洞察面板：ChatLab 指标全维度可视化（ECharts 高级沙龙美学）──────────
// 数据源 GET /api/insight/:sessionId（后端聚合 + 小时缓存）
import { ref, computed, onMounted, watch } from 'vue'
import {
  ArrowLeft, RefreshCw, MessageCircle, Clock, Zap, Flame,
  ExternalLink, Sparkles
} from 'lucide-vue-next'
import ChartCard from './ChartCard.vue'

const props = defineProps({
  session: { type: Object, required: true }, // { id, name }
})
const emit = defineEmits(['back', 'browse'])

const loading = ref(true)
const error = ref('')
const data = ref(null)
const generatedAt = ref('')

const resolvedSessionId = computed(() => {
  return props.session?.id || props.session?.sessionId || props.session?.name || ''
})

async function load() {
  const sid = resolvedSessionId.value
  if (!sid) {
    error.value = '未指定有效会话'
    loading.value = false
    return
  }
  loading.value = true
  error.value = ''
  try {
    const j = await fetch(`/api/insight/${encodeURIComponent(sid)}`).then(r => r.json())
    if (j.ok) {
      data.value = j.data
      generatedAt.value = j.generatedAt || ''
    } else {
      error.value = j.error || '加载数据洞察失败'
    }
  } catch (err) {
    error.value = '无法连接后端服务：' + (err.message || '网络异常')
  } finally {
    loading.value = false
  }
}

watch(() => resolvedSessionId.value, load)
onMounted(load)

const isWarn = x => x && x.__warning
const warnKeys = computed(() =>
  data.value ? Object.keys(data.value).filter(k => isWarn(data.value[k])) : []
)

// ── 核心摘要指标计算 ────────────────────────────────────
const totalMessagesCount = computed(() => {
  const items = data.value?.daily?.items || []
  return items.reduce((acc, r) => acc + (r.messageCount || 0), 0)
})

const totalDaysCount = computed(() => {
  const items = data.value?.daily?.items || []
  return items.filter(r => r.messageCount > 0).length
})

const peakHourItem = computed(() => {
  const items = data.value?.hour?.items || []
  if (!items.length) return null
  return items.reduce((a, b) => b.messageCount > a.messageCount ? b : a, items[0])
})

const peakHourLabel = computed(() => {
  if (!peakHourItem.value || peakHourItem.value.messageCount === 0) return '暂无'
  return `${peakHourItem.value.hour}:00`
})

const peakHourCount = computed(() => {
  return peakHourItem.value ? peakHourItem.value.messageCount : 0
})

const medianResponseTimeLabel = computed(() => {
  const items = data.value?.response?.items || []
  if (!items.length) return '暂无'
  const valid = items.map(i => i.medianSeconds).filter(v => typeof v === 'number' && v > 0)
  if (!valid.length) return '秒级即时'
  const avgMed = Math.round(valid.reduce((a, b) => a + b, 0) / valid.length)
  if (avgMed < 60) return `${avgMed} 秒`
  return `${(avgMed / 60).toFixed(1)} 分钟`
})

const responseSyncEvaluation = computed(() => {
  const items = data.value?.response?.items || []
  if (!items.length) return '暂无互动时延'
  const valid = items.map(i => i.medianSeconds).filter(v => typeof v === 'number' && v > 0)
  if (!valid.length) return '即时高频同步'
  const avgMed = Math.round(valid.reduce((a, b) => a + b, 0) / valid.length)
  if (avgMed <= 45) return '秒回高频 · 极高共鸣'
  if (avgMed <= 180) return '3分钟内响应 · 高度同频'
  if (avgMed <= 600) return '10分钟内响应 · 节奏平稳'
  return '从容长程异步交流'
})

const activityBalanceLabel = computed(() => {
  const items = data.value?.activity?.items || []
  if (items.length < 2) return '100%'
  const p1 = Math.round(items[0]?.percentage || 50)
  const p2 = Math.round(items[1]?.percentage || 50)
  return `${p1}% : ${p2}%`
})

const activityBalanceSub = computed(() => {
  const items = data.value?.activity?.items || []
  if (items.length < 2) return '单向输出为主'
  const diff = Math.abs((items[0]?.percentage || 50) - (items[1]?.percentage || 50))
  if (diff <= 10) return '双向奔赴 · 情绪供给极其平衡'
  if (diff <= 25) return '良性来回 · 互动节奏健康'
  return '一方分享倾角较为明显'
})

// ── 图表配置 ────────────────────────────────────────────

// 1. 每日消息趋势（30 天，补齐空档日）
const maxDailyCount = computed(() => {
  const rows = data.value?.daily?.items || []
  if (!rows.length) return 0
  return Math.max(...rows.map(r => r.messageCount), 0)
})

const dailyOption = computed(() => {
  const rows = data.value?.daily?.items || []
  if (!rows.length) return null
  const map = new Map(rows.map(r => [r.date, r.messageCount]))
  const days = []
  let d = new Date(rows[0].date + 'T00:00:00')
  const end = new Date(rows[rows.length - 1].date + 'T00:00:00')
  while (d <= end) {
    const key = d.toISOString().slice(0, 10)
    days.push({ date: key, cnt: map.get(key) || 0 })
    d = new Date(d.getTime() + 86400000)
  }
  const maxItem = days.reduce((a, b) => b.cnt > a.cnt ? b : a, days[0])

  return {
    grid: { left: 42, right: 20, top: 32, bottom: 26 },
    tooltip: {
      trigger: 'axis',
      backgroundColor: 'rgba(255, 255, 255, 0.96)',
      borderColor: '#f0d3dc',
      borderWidth: 1,
      padding: [10, 14],
      textStyle: { color: '#3d4350', fontSize: 12 },
      extraCssText: 'box-shadow: 0 8px 24px rgba(78, 20, 39, 0.12); border-radius: 12px; backdrop-filter: blur(8px);',
      formatter: params => {
        const item = params[0]
        const count = item.value
        let tag = ''
        if (count >= 25) tag = '🔥 深度长谈日'
        else if (count >= 10) tag = '💬 稳定热络日'
        else if (count > 0) tag = '✨ 日常轻互动'
        else tag = '🍃 静默无新消息'
        return `<div style="font-weight:600;margin-bottom:4px;color:#2f3440">${item.axisValue}</div>
                <div style="display:flex;align-items:center;gap:6px;">
                  <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#b84a68"></span>
                  <span style="color:#5c6270">消息数量：</span>
                  <strong style="color:#b84a68;font-size:14px">${count} 条</strong>
                </div>
                <div style="font-size:11px;color:#9b6f7d;margin-top:4px">${tag}</div>`
      }
    },
    xAxis: {
      type: 'category',
      data: days.map(x => x.date.slice(5)),
      axisLine: { lineStyle: { color: '#eddde2' } },
      axisTick: { show: false },
      axisLabel: { fontSize: 11, color: '#8c7582' },
    },
    yAxis: {
      type: 'value',
      minInterval: 1,
      axisLabel: { fontSize: 11, color: '#8c7582' },
      splitLine: { lineStyle: { color: '#f7edf0', type: 'dashed' } },
    },
    series: [{
      name: '消息量',
      type: 'line',
      smooth: 0.42,
      showSymbol: false,
      symbol: 'circle',
      symbolSize: 8,
      itemStyle: {
        color: '#b84a68',
        borderColor: '#ffffff',
        borderWidth: 2.5,
        shadowColor: 'rgba(184, 74, 104, 0.4)',
        shadowBlur: 6
      },
      lineStyle: {
        color: '#b84a68',
        width: 3,
        shadowColor: 'rgba(184, 74, 104, 0.3)',
        shadowBlur: 10,
        shadowOffsetY: 5
      },
      areaStyle: {
        color: {
          type: 'linear',
          x: 0, y: 0, x2: 0, y2: 1,
          colorStops: [
            { offset: 0, color: 'rgba(184, 74, 104, 0.28)' },
            { offset: 0.65, color: 'rgba(216, 108, 138, 0.08)' },
            { offset: 1, color: 'rgba(255, 255, 255, 0.01)' }
          ]
        }
      },
      markPoint: maxItem && maxItem.cnt > 0 ? {
        data: [{ type: 'max', name: '单日峰值' }],
        symbol: 'pin',
        symbolSize: 42,
        itemStyle: {
          color: '#b84a68',
          shadowColor: 'rgba(184, 74, 104, 0.45)',
          shadowBlur: 8
        },
        label: {
          fontSize: 10,
          fontWeight: 'bold',
          color: '#fff',
          offset: [0, -2]
        }
      } : undefined,
      data: days.map(x => x.cnt),
    }],
  }
})

// 2. 回复速度对比（中位数 vs 平均值，单位：分钟）
const responseOption = computed(() => {
  const rows = data.value?.response?.items || []
  if (!rows.length) return null
  const min = s => Math.round((s / 60) * 10) / 10
  return {
    grid: { left: 44, right: 18, top: 40, bottom: 26 },
    tooltip: {
      trigger: 'axis',
      backgroundColor: 'rgba(255, 255, 255, 0.96)',
      borderColor: '#f0d3dc',
      borderWidth: 1,
      padding: [10, 14],
      textStyle: { color: '#3d4350', fontSize: 12 },
      extraCssText: 'box-shadow: 0 8px 24px rgba(78, 20, 39, 0.12); border-radius: 12px; backdrop-filter: blur(8px);',
      formatter: params => {
        let str = `<div style="font-weight:600;margin-bottom:6px;color:#2f3440">${params[0].name}</div>`
        params.forEach(p => {
          const isMedian = p.seriesName.includes('中位数')
          const desc = isMedian ? '秒级常态即时响应' : '包含隔夜与离线时差'
          str += `<div style="display:flex;align-items:center;justify-content:space-between;gap:16px;margin:4px 0;">
                    <span style="display:flex;align-items:center;gap:6px;color:#5c6270">
                      <span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${p.color}"></span>
                      ${p.seriesName} <small style="color:#9da7b8">(${desc})</small>
                    </span>
                    <strong style="color:#2f3440">${p.value} 分钟</strong>
                  </div>`
        })
        return str
      }
    },
    legend: {
      top: 2,
      right: 10,
      itemWidth: 12,
      itemHeight: 9,
      textStyle: { fontSize: 11, color: '#6d5a64' }
    },
    xAxis: {
      type: 'category',
      data: rows.map(r => r.name),
      axisLine: { lineStyle: { color: '#eddde2' } },
      axisTick: { show: false },
      axisLabel: { fontSize: 12, color: '#4a3d44', fontWeight: 600 },
    },
    yAxis: {
      type: 'value',
      axisLabel: { fontSize: 11, color: '#8c7582', formatter: '{value}分' },
      splitLine: { lineStyle: { color: '#f7edf0', type: 'dashed' } },
    },
    series: [
      {
        name: '常态中位数',
        type: 'bar',
        barMaxWidth: 22,
        barGap: '35%',
        itemStyle: {
          borderRadius: [6, 6, 0, 0],
          color: {
            type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [{ offset: 0, color: '#b84a68' }, { offset: 1, color: '#d86c8a' }]
          },
          shadowColor: 'rgba(184, 74, 104, 0.22)',
          shadowBlur: 6
        },
        data: rows.map(r => min(r.medianSeconds)),
      },
      {
        name: '总体平均值',
        type: 'bar',
        barMaxWidth: 22,
        itemStyle: {
          borderRadius: [6, 6, 0, 0],
          color: {
            type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [{ offset: 0, color: '#e59a68' }, { offset: 1, color: '#f2be9b' }]
          },
          shadowColor: 'rgba(229, 154, 104, 0.22)',
          shadowBlur: 6
        },
        data: rows.map(r => min(r.avgSeconds)),
      },
    ],
  }
})

// 3. 24 小时时段分布
const hourOption = computed(() => {
  const rows = data.value?.hour?.items || []
  if (!rows.length) return null
  const maxVal = Math.max(...rows.map(r => r.messageCount), 1)

  return {
    grid: { left: 42, right: 18, top: 32, bottom: 26 },
    tooltip: {
      trigger: 'axis',
      backgroundColor: 'rgba(255, 255, 255, 0.96)',
      borderColor: '#f0d3dc',
      borderWidth: 1,
      padding: [10, 14],
      textStyle: { color: '#3d4350', fontSize: 12 },
      extraCssText: 'box-shadow: 0 8px 24px rgba(78, 20, 39, 0.12); border-radius: 12px; backdrop-filter: blur(8px);',
      formatter: p => {
        const hour = parseInt(p[0].name, 10)
        const val = p[0].value
        let hint = ''
        if (hour >= 0 && hour <= 4) hint = '🌙 深夜微醺 · 走心长聊'
        else if (hour >= 7 && hour <= 9) hint = '☀️ 晨起问候 · 开启一天'
        else if (hour >= 11 && hour <= 13) hint = '🍲 午间闲聊 · 饭点分享'
        else if (hour >= 17 && hour <= 19) hint = '🌇 傍晚放学下班 · 节奏交汇'
        else if (hour >= 20 && hour <= 23) hint = '✨ 黄金热聊 · 亲密升温'
        else hint = '🌿 日常间隙/自处时段'

        return `<div style="font-weight:600;margin-bottom:4px;color:#2f3440">${p[0].name}:00 时段</div>
                <div style="color:#b84a68;font-size:14px;font-weight:700;">${val} 条消息</div>
                <div style="font-size:11px;color:#8c7582;margin-top:4px;">${hint}</div>`
      }
    },
    xAxis: {
      type: 'category',
      data: rows.map(r => `${r.hour}`),
      axisLine: { lineStyle: { color: '#eddde2' } },
      axisTick: { show: false },
      axisLabel: {
        fontSize: 10,
        color: '#8c7582',
        interval: 2, // 每隔 3 小时显示一次刻度标签 (0, 3, 6, 9, 12, 15, 18, 21)
        formatter: v => `${v}:00`
      }
    },
    yAxis: {
      type: 'value',
      minInterval: 1,
      axisLabel: { fontSize: 11, color: '#8c7582' },
      splitLine: { lineStyle: { color: '#f7edf0', type: 'dashed' } },
    },
    series: [{
      type: 'bar',
      data: rows.map(r => {
        const isPeak = r.messageCount >= maxVal * 0.6 && r.messageCount > 0
        return {
          value: r.messageCount,
          itemStyle: {
            borderRadius: [5, 5, 0, 0],
            color: isPeak ? {
              type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
              colorStops: [{ offset: 0, color: '#b84a68' }, { offset: 1, color: '#8b2643' }]
            } : {
              type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
              colorStops: [{ offset: 0, color: '#e8a4b8' }, { offset: 1, color: '#f3c7d3' }]
            }
          }
        }
      }),
      barMaxWidth: 14,
    }],
  }
})

// 4. 星期分布（周一 ~ 周日）
const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
const weekdayOption = computed(() => {
  const rows = [...(data.value?.weekday?.items || [])].sort((a, b) => a.weekday - b.weekday)
  if (!rows.length) return null
  const total = rows.reduce((s, r) => s + r.messageCount, 0) || 1

  return {
    grid: { left: 42, right: 18, top: 32, bottom: 26 },
    tooltip: {
      trigger: 'axis',
      backgroundColor: 'rgba(255, 255, 255, 0.96)',
      borderColor: '#f0d3dc',
      borderWidth: 1,
      padding: [10, 14],
      textStyle: { color: '#3d4350', fontSize: 12 },
      extraCssText: 'box-shadow: 0 8px 24px rgba(78, 20, 39, 0.12); border-radius: 12px; backdrop-filter: blur(8px);',
      formatter: p => {
        const name = p[0].name
        const val = p[0].value
        const pct = ((val / total) * 100).toFixed(1)
        const isWeekend = name === '周六' || name === '周日'
        return `<div style="font-weight:600;margin-bottom:4px;color:#2f3440">${name} ${isWeekend ? '🎉 周末时光' : '💼 工作日'}</div>
                <div style="color:#987ebf;font-size:14px;font-weight:700;">${val} 条消息 (${pct}%)</div>`
      }
    },
    xAxis: {
      type: 'category',
      data: rows.map(r => WEEKDAYS[r.weekday - 1] || r.weekday),
      axisLine: { lineStyle: { color: '#eddde2' } },
      axisTick: { show: false },
      axisLabel: { fontSize: 11, color: '#8c7582' },
    },
    yAxis: {
      type: 'value',
      minInterval: 1,
      axisLabel: { fontSize: 11, color: '#8c7582' },
      splitLine: { lineStyle: { color: '#f7edf0', type: 'dashed' } },
    },
    series: [{
      type: 'bar',
      data: rows.map(r => {
        const isWeekend = r.weekday === 6 || r.weekday === 7
        return {
          value: r.messageCount,
          itemStyle: {
            borderRadius: [6, 6, 0, 0],
            color: isWeekend ? {
              type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
              colorStops: [{ offset: 0, color: '#e59a68' }, { offset: 1, color: '#f3be9b' }]
            } : {
              type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
              colorStops: [{ offset: 0, color: '#987ebf' }, { offset: 1, color: '#baa0e4' }]
            }
          }
        }
      }),
      barMaxWidth: 20,
    }],
  }
})

// 5. 消息占比（30 天）
const activityColors = [
  {
    type: 'linear', x: 0, y: 0, x2: 1, y2: 1,
    colorStops: [{ offset: 0, color: '#b84a68' }, { offset: 1, color: '#d86c8a' }]
  },
  {
    type: 'linear', x: 0, y: 0, x2: 1, y2: 1,
    colorStops: [{ offset: 0, color: '#e59a68' }, { offset: 1, color: '#f2be9b' }]
  },
  {
    type: 'linear', x: 0, y: 0, x2: 1, y2: 1,
    colorStops: [{ offset: 0, color: '#68a698' }, { offset: 1, color: '#92c2b7' }]
  },
  {
    type: 'linear', x: 0, y: 0, x2: 1, y2: 1,
    colorStops: [{ offset: 0, color: '#987ebf' }, { offset: 1, color: '#baa0e4' }]
  }
]

const activityOption = computed(() => {
  const rows = data.value?.activity?.items || []
  if (!rows.length) return null
  const total = rows.reduce((s, r) => s + r.messageCount, 0)
  return {
    tooltip: {
      trigger: 'item',
      backgroundColor: 'rgba(255, 255, 255, 0.96)',
      borderColor: '#f0d3dc',
      borderWidth: 1,
      padding: [10, 14],
      textStyle: { color: '#3d4350', fontSize: 12 },
      extraCssText: 'box-shadow: 0 8px 24px rgba(78, 20, 39, 0.12); border-radius: 12px; backdrop-filter: blur(8px);',
      formatter: p => {
        return `<div style="font-weight:600;margin-bottom:4px;color:#2f3440">${p.name}</div>
                <div style="display:flex;align-items:center;gap:6px;">
                  <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${p.color}"></span>
                  <span style="color:#5c6270">消息条数：</span>
                  <strong style="color:#2f3440">${p.value} 条</strong>
                </div>
                <div style="color:#8c7582;font-size:11px;margin-top:4px;">占比：<strong style="color:#b84a68">${p.percent}%</strong></div>`
      }
    },
    legend: {
      bottom: 6,
      itemWidth: 12,
      itemHeight: 10,
      textStyle: { fontSize: 11, color: '#5c6270' },
      formatter: name => {
        const item = rows.find(r => r.name === name)
        return item ? `${name}  ${item.percentage || 0}%` : name
      }
    },
    series: [{
      type: 'pie',
      radius: ['52%', '74%'],
      center: ['50%', '45%'],
      avoidLabelOverlap: false,
      itemStyle: {
        borderRadius: 8,
        borderColor: '#ffffff',
        borderWidth: 3,
      },
      data: rows.map((r, i) => ({
        name: r.name,
        value: r.messageCount,
        itemStyle: { color: activityColors[i % activityColors.length] }
      })),
      label: {
        show: true,
        position: 'center',
        formatter: () => `{val|${total}}\n{sub|近30天总条数}`,
        rich: {
          val: { fontSize: 22, fontWeight: 700, color: '#3d4350', lineHeight: 28 },
          sub: { fontSize: 11, color: '#8c7582', lineHeight: 16 }
        }
      },
      emphasis: {
        scale: true,
        scaleSize: 6,
      }
    }],
  }
})

// 6. 高频词（近 30 天）
const keywordOption = computed(() => {
  const rows = data.value?.keywords?.items || []
  if (!rows.length) return null
  const first = rows[0]
  const keys = Object.keys(first)
  const labelKey = keys.find(k => typeof first[k] === 'string') || keys[0]
  const valueKey = keys.find(k => typeof first[k] === 'number') || keys[1]
  const top = rows.slice(0, 10).reverse()
  return {
    grid: { left: 70, right: 28, top: 16, bottom: 20 },
    tooltip: {
      trigger: 'axis',
      backgroundColor: 'rgba(255, 255, 255, 0.96)',
      borderColor: '#f0d3dc',
      borderWidth: 1,
      padding: [8, 12],
      textStyle: { color: '#3d4350', fontSize: 12 },
      extraCssText: 'box-shadow: 0 8px 24px rgba(78, 20, 39, 0.12); border-radius: 10px;',
    },
    xAxis: {
      type: 'value',
      axisLabel: { fontSize: 10, color: '#9aa7b8' },
      splitLine: { lineStyle: { color: '#f7edf0', type: 'dashed' } }
    },
    yAxis: {
      type: 'category',
      data: top.map(r => r[labelKey]),
      axisLine: { lineStyle: { color: '#eddde2' } },
      axisTick: { show: false },
      axisLabel: { fontSize: 12, color: '#4a3d44' },
    },
    series: [{
      type: 'bar',
      data: top.map(r => r[valueKey]),
      barMaxWidth: 16,
      itemStyle: {
        borderRadius: [0, 6, 6, 0],
        color: {
          type: 'linear', x: 0, y: 0, x2: 1, y2: 0,
          colorStops: [{ offset: 0, color: '#d86c8a' }, { offset: 1, color: '#b84a68' }]
        },
      },
    }],
  }
})
</script>

<template>
  <div class="insight">
    <!-- 顶栏 -->
    <header class="insight-header">
      <button class="back-btn" title="返回对话" @click="emit('back')">
        <ArrowLeft :size="18" />
      </button>
      <div class="header-copy">
        <div class="header-title-row">
          <strong>数据洞察 · {{ session.name }}</strong>
          <span class="window-tag">近 30 天样本</span>
        </div>
        <div class="header-status">
          <span v-if="loading" class="status-loading">
            <span class="pulse-dot"></span>
            正在全量汇总并解构聊天记录指标…
          </span>
          <span v-else-if="generatedAt" class="status-done">
            指标已完成实时计算 · 生成于 {{ generatedAt.slice(11, 16) }}
          </span>
        </div>
      </div>
      <button class="refresh-btn" :disabled="loading" title="重新汇总" @click="load">
        <RefreshCw :size="14" :class="{ 'spin-icon': loading }" />
        <span>{{ loading ? '计算中…' : '刷新数据' }}</span>
      </button>
    </header>

    <!-- 异常提示 -->
    <div v-if="error" class="insight-error">
      <div class="error-icon">⚠️</div>
      <div class="error-msg">{{ error }}</div>
      <button class="retry-btn" @click="load">重试</button>
    </div>

    <!-- 统计项警告（单项失败不拖垮整体面板） -->
    <div v-if="warnKeys.length" class="insight-warns">
      <span v-for="k in warnKeys" :key="k" class="warn-chip">{{ data[k].__warning }}</span>
    </div>

    <!-- 核心指标速览卡片栏 -->
    <section class="insight-summary-grid">
      <div class="summary-card">
        <div class="summary-icon icon-msg">
          <MessageCircle :size="18" />
        </div>
        <div class="summary-meta">
          <span class="summary-label">近 30 天消息量</span>
          <div v-if="loading" class="skel-val-pill"></div>
          <strong v-else class="summary-value">{{ totalMessagesCount }} <small>条</small></strong>
          <span class="summary-sub">{{ totalDaysCount }} 个活跃互动日</span>
        </div>
      </div>

      <div class="summary-card">
        <div class="summary-icon icon-time">
          <Clock :size="18" />
        </div>
        <div class="summary-meta">
          <span class="summary-label">黄金热聊时段</span>
          <div v-if="loading" class="skel-val-pill"></div>
          <strong v-else class="summary-value">{{ peakHourLabel }}</strong>
          <span class="summary-sub">{{ peakHourCount }} 条消息集中</span>
        </div>
      </div>

      <div class="summary-card">
        <div class="summary-icon icon-speed">
          <Zap :size="18" />
        </div>
        <div class="summary-meta">
          <span class="summary-label">常态回复时延</span>
          <div v-if="loading" class="skel-val-pill"></div>
          <strong v-else class="summary-value">{{ medianResponseTimeLabel }}</strong>
          <span class="summary-sub">{{ responseSyncEvaluation }}</span>
        </div>
      </div>

      <div class="summary-card">
        <div class="summary-icon icon-ratio">
          <Flame :size="18" />
        </div>
        <div class="summary-meta">
          <span class="summary-label">互动投入均衡度</span>
          <div v-if="loading" class="skel-val-pill"></div>
          <strong v-else class="summary-value">{{ activityBalanceLabel }}</strong>
          <span class="summary-sub">{{ activityBalanceSub }}</span>
        </div>
      </div>
    </section>

    <!-- 图表网格：每项绑定专属骨架加载动效与高级视觉样式 -->
    <div class="chart-grid">
      <ChartCard
        title="每日消息趋势（近 30 天）"
        subtitle="每日互动频次起伏与情绪共振峰值"
        :badge="maxDailyCount ? `单日峰值 ${maxDailyCount} 条` : ''"
        :option="dailyOption"
        :loading="loading"
        skeleton-type="line"
        :empty="isWarn(data?.daily) ? data.daily.__warning : '近 30 天暂无消息记录'"
        empty-sub="会话产生新消息后将自动绘制起伏趋势曲线"
        :height="240"
      />

      <ChartCard
        title="回复速度对比（分钟）"
        subtitle="常态即时响应 vs 全天候等待时差"
        badge="秒回中位数 vs 均值"
        :option="responseOption"
        :loading="loading"
        skeleton-type="bar"
        :empty="isWarn(data?.response) ? data.response.__warning : '暂未统计到往返对话'"
        empty-sub="需双方产生多轮来回问答后计算响应时延"
        :height="240"
      />

      <ChartCard
        title="24 小时时段分布"
        subtitle="全天候互动生物钟与作息重合度"
        :badge="peakHourLabel !== '暂无' ? `高频时段 ${peakHourLabel}` : ''"
        :option="hourOption"
        :loading="loading"
        skeleton-type="bar"
        :empty="isWarn(data?.hour) ? data.hour.__warning : '暂无时段分布数据'"
        empty-sub="覆盖 0:00 至 23:00 全天作息"
        :height="220"
      />

      <ChartCard
        title="星期分布（周一 ~ 周日）"
        subtitle="工作日节律与周末休闲互动倾向"
        badge="工作日 vs 周末"
        :option="weekdayOption"
        :loading="loading"
        skeleton-type="bar"
        :empty="isWarn(data?.weekday) ? data.weekday.__warning : '暂无星期数据'"
        empty-sub="分析日常与假期对聊天密度的影响"
        :height="220"
      />

      <ChartCard
        title="消息占比（近 30 天）"
        subtitle="双方情绪供给与互动主动性份额"
        badge="份额构成"
        :option="activityOption"
        :loading="loading"
        skeleton-type="pie"
        :empty="isWarn(data?.activity) ? data.activity.__warning : '暂无角色占比数据'"
        empty-sub="展示双方发言条数与投入百分比"
        :height="220"
      />

      <ChartCard
        title="高频词重心（近 30 天）"
        subtitle="对话高频出现的关切主题词"
        badge="词频提炼"
        :option="keywordOption"
        :loading="loading"
        skeleton-type="horizontal"
        :empty="isWarn(data?.keywords) ? data.keywords.__warning : '分词扩展未安装（可选）'"
        empty-sub="ChatLab 本地分词需下载中文词典扩展；当前互动频率、作息时段与回复指标已全量就绪"
        :height="220"
      />
    </div>

    <!-- 底部跳转原文引导 -->
    <div class="insight-footer">
      <button class="browse-link" @click="emit('browse')">
        <span>打开聊天记录浏览器，核验上下文与原文</span>
        <ExternalLink :size="14" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.insight {
  flex: 1;
  overflow-y: auto;
  padding: 22px 28px 40px;
  background: linear-gradient(180deg, #fdf8fa 0%, #fbf9fb 320px);
}

/* ── 顶栏 ── */
.insight-header {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-bottom: 20px;
}
.back-btn {
  width: 36px;
  height: 36px;
  border-radius: 11px;
  border: 1px solid #ebd9df;
  background: #ffffff;
  color: #7a5566;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  flex: none;
  transition: all 0.15s ease;
  box-shadow: 0 2px 6px rgba(45, 20, 30, 0.03);
}
.back-btn:hover {
  background: #fdf2f5;
  border-color: #dfb8c4;
  color: #8b2643;
}
.header-copy {
  flex: 1;
  min-width: 0;
}
.header-title-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.header-title-row strong {
  font-size: 16px;
  color: #2e333e;
  font-weight: 700;
  letter-spacing: -0.01em;
}
.window-tag {
  font-size: 11px;
  font-weight: 600;
  color: #a84260;
  background: #fdecf1;
  border: 1px solid #f6d1dc;
  padding: 1px 7px;
  border-radius: 999px;
}
.header-status {
  margin-top: 2px;
  font-size: 11.5px;
}
.status-loading {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: #b84a68;
  font-weight: 500;
}
.status-done {
  color: #8c97a8;
}
.pulse-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #b84a68;
  animation: pulsePing 1.2s cubic-bezier(0, 0, 0.2, 1) infinite;
}
@keyframes pulsePing {
  0% { transform: scale(0.9); opacity: 0.8; }
  50% { transform: scale(1.4); opacity: 0.3; }
  100% { transform: scale(0.9); opacity: 0.8; }
}

.refresh-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  border: 1px solid #ebd9df;
  background: #ffffff;
  color: #7a5566;
  border-radius: 10px;
  padding: 8px 14px;
  font-size: 12.5px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s ease;
  box-shadow: 0 2px 6px rgba(45, 20, 30, 0.03);
}
.refresh-btn:hover:not(:disabled) {
  background: #fdf2f5;
  border-color: #dfb8c4;
  color: #8b2643;
}
.refresh-btn:disabled {
  opacity: 0.6;
  cursor: default;
}
.spin-icon {
  animation: spin 1s linear infinite;
}

/* ── 异常提示 ── */
.insight-error {
  display: flex;
  align-items: center;
  gap: 10px;
  background: #fff3f5;
  border: 1px solid #fed1da;
  color: #ba3856;
  border-radius: 12px;
  padding: 10px 16px;
  font-size: 12.5px;
  margin-bottom: 16px;
}
.error-msg { flex: 1; font-weight: 500; }
.retry-btn {
  background: #ffffff;
  border: 1px solid #f9bdcb;
  color: #ba3856;
  border-radius: 6px;
  padding: 3px 10px;
  font-size: 11.5px;
  cursor: pointer;
}

.insight-warns {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 16px;
}
.warn-chip {
  font-size: 11.5px;
  color: #9a6828;
  background: #fdf5e8;
  border: 1px solid #f6e2be;
  border-radius: 8px;
  padding: 4px 10px;
}

/* ── 顶部 4 维核心指标摘要卡 ── */
.insight-summary-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 14px;
  margin-bottom: 18px;
}
.summary-card {
  background: #ffffff;
  border: 1px solid #f2e2e7;
  border-radius: 14px;
  padding: 14px 16px;
  display: flex;
  align-items: center;
  gap: 12px;
  box-shadow: 0 2px 10px rgba(45, 20, 30, 0.02);
  transition: all 0.2s ease;
}
.summary-card:hover {
  transform: translateY(-1px);
  box-shadow: 0 4px 14px rgba(184, 74, 104, 0.06);
  border-color: #ebd0d9;
}
.summary-icon {
  width: 38px;
  height: 38px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex: none;
}
.icon-msg { background: #fdf0f4; color: #b84a68; }
.icon-time { background: #fef4ec; color: #d67a3a; }
.icon-speed { background: #f1f7f5; color: #4b8b7e; }
.icon-ratio { background: #f5f0fb; color: #7f58b0; }

.summary-meta {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.summary-label {
  font-size: 11.5px;
  color: #8c97a8;
  margin-bottom: 2px;
  font-weight: 500;
}
.summary-value {
  font-size: 17px;
  font-weight: 700;
  color: #2e333e;
  letter-spacing: -0.02em;
  line-height: 1.25;
}
.summary-value small {
  font-size: 11px;
  font-weight: 500;
  color: #8c97a8;
  margin-left: 2px;
}
.summary-sub {
  font-size: 11px;
  color: #9da7b7;
  margin-top: 3px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.skel-val-pill {
  width: 60px;
  height: 18px;
  border-radius: 4px;
  background: linear-gradient(90deg, #f7e6eb, #fdf0f4, #f7e6eb);
  background-size: 200% 100%;
  animation: skelShimmer 1.5s ease-in-out infinite;
  margin: 3px 0 4px;
}
@keyframes skelShimmer {
  0% { background-position: -200% 0; }
  100% { background-position: 200% 0; }
}

/* ── 图表网格 ── */
.chart-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}

/* ── 底部引导 ── */
.insight-footer {
  margin-top: 24px;
  text-align: center;
}
.browse-link {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid #f0d5de;
  background: #ffffff;
  color: #a84260;
  font-size: 13px;
  font-weight: 500;
  padding: 8px 18px;
  border-radius: 999px;
  cursor: pointer;
  transition: all 0.2s ease;
  box-shadow: 0 2px 8px rgba(45, 20, 30, 0.03);
}
.browse-link:hover {
  background: #fdf2f5;
  border-color: #dfb8c4;
  color: #8b2643;
  transform: translateY(-1px);
}

@media (max-width: 1080px) {
  .insight-summary-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (max-width: 820px) {
  .insight {
    padding: 16px;
  }
  .insight-summary-grid {
    grid-template-columns: 1fr;
  }
  .chart-grid {
    grid-template-columns: 1fr;
  }
}
</style>
