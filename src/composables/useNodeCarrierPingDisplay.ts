import type { MaybeRefOrGetter } from 'vue'
import type { ChinaCarrierKey } from '@/composables/useNodeCarrierPingStats'
import type { NodePingHistoryPoint } from '@/composables/useNodePingStats'
import { computed, toValue } from 'vue'
import { useNodeCarrierPingStats } from '@/composables/useNodeCarrierPingStats'
import { useAppStore } from '@/stores/app'
import { formatDateTime } from '@/utils/helper'

export interface CarrierPingBar {
  key: string
  className: string
  tooltip: string
}

export interface CarrierPingDisplay {
  key: ChinaCarrierKey
  label: string
  dotClass: string
  taskNames: string[]
  latencyDisplay: string
  lossDisplay: string
  latencyBars: CarrierPingBar[]
  lossBars: CarrierPingBar[]
  latencyTooltip: string
  lossTooltip: string
}

interface UseNodeCarrierPingDisplayOptions {
  enabled?: MaybeRefOrGetter<boolean>
}

const EMPTY_PING_BAR_COUNT = 20

const CARRIER_DOT_CLASSES: Record<ChinaCarrierKey, string> = {
  unicom: 'bg-rose-500',
  telecom: 'bg-blue-500',
  mobile: 'bg-emerald-500',
}

// 与 useNodePingDisplay 保持同一套 signal 色阶（含色觉辅助纹理）。
function getLatencyToneClass(latency: number): string {
  if (latency <= 60)
    return 'bg-signal-1'
  if (latency <= 100)
    return 'bg-signal-2'
  if (latency <= 160)
    return 'bg-signal-3 ping-signal-pattern-2'
  if (latency <= 200)
    return 'bg-signal-4 ping-signal-pattern-3'
  return 'bg-signal-5 ping-signal-pattern-4'
}

function getLossToneClass(loss: number): string {
  if (loss <= 1)
    return 'bg-signal-1'
  if (loss <= 3)
    return 'bg-signal-2'
  if (loss <= 6)
    return 'bg-signal-3 ping-signal-pattern-2'
  if (loss <= 9)
    return 'bg-signal-4 ping-signal-pattern-3'
  return 'bg-signal-5 ping-signal-pattern-4'
}

function buildHistoryBars(
  carrierLabel: string,
  carrierKey: ChinaCarrierKey,
  history: NodePingHistoryPoint[],
  metric: 'latency' | 'loss',
): CarrierPingBar[] {
  return history.map((point, index) => {
    const value = point[metric]
    const valueText = value === null
      ? '无采样数据'
      : metric === 'latency'
        ? `${Math.round(value)} ms`
        : `${value.toFixed(1)}%`

    return {
      key: `${carrierKey}-${metric}-${point.time}-${index}`,
      className: value === null
        ? 'bg-muted-foreground/15'
        : metric === 'latency'
          ? getLatencyToneClass(value)
          : getLossToneClass(value),
      tooltip: `${carrierLabel}\n${formatDateTime(point.time, 'HH:mm:ss')}\n${valueText}`,
    }
  })
}

function buildEmptyBars(carrierKey: ChinaCarrierKey, metric: 'latency' | 'loss', tooltip: string): CarrierPingBar[] {
  return Array.from({ length: EMPTY_PING_BAR_COUNT }, (_, index) => ({
    key: `${carrierKey}-${metric}-empty-${index}`,
    className: 'bg-muted-foreground/10',
    tooltip,
  }))
}

export function useNodeCarrierPingDisplay(
  uuid: MaybeRefOrGetter<string>,
  options: UseNodeCarrierPingDisplayOptions = {},
) {
  const appStore = useAppStore()

  const pingStatsEnabled = computed(() => {
    if (toValue(options.enabled) === false)
      return false
    if (appStore.publicSettings?.record_enabled === false)
      return false
    return appStore.publicSettings?.ping_record_preserve_time !== 0
  })

  const pingStatsHours = computed(() => {
    const preserveTime = appStore.publicSettings?.ping_record_preserve_time
    if (typeof preserveTime === 'number' && preserveTime > 0)
      return Math.min(preserveTime, 1)
    return 1
  })

  const carrierStats = useNodeCarrierPingStats(uuid, {
    hours: pingStatsHours,
    enabled: pingStatsEnabled,
  })

  const carrierDisplays = computed<CarrierPingDisplay[]>(() => carrierStats.carriers.value.map((carrier) => {
    const label = appStore.lang === 'zh-CN' ? carrier.labelZh : carrier.labelEn
    const taskHint = carrier.taskNames.length
      ? carrier.taskNames.join(' / ')
      : appStore.lang === 'zh-CN'
        ? `未匹配${carrier.labelZh} Ping 任务`
        : `No ${carrier.labelEn} ping task matched`

    const emptyReason = carrierStats.loading.value
      ? (appStore.lang === 'zh-CN' ? '加载中' : 'Loading')
      : carrierStats.error.value
        ? (appStore.lang === 'zh-CN' ? '加载失败' : 'Load failed')
        : !pingStatsEnabled.value
            ? (appStore.lang === 'zh-CN' ? '未启用 Ping 记录' : 'Ping records disabled')
            : taskHint

    const latencyBars = carrier.stats.history.length
      ? buildHistoryBars(label, carrier.key, carrier.stats.history, 'latency')
      : buildEmptyBars(carrier.key, 'latency', emptyReason)
    const lossBars = carrier.stats.history.length
      ? buildHistoryBars(label, carrier.key, carrier.stats.history, 'loss')
      : buildEmptyBars(carrier.key, 'loss', emptyReason)

    const latencyDisplay = carrier.hasLatency
      ? `${Math.round(carrier.stats.avgLatency)} ms`
      : carrierStats.loading.value
        ? (appStore.lang === 'zh-CN' ? '加载中' : 'Loading')
        : '-'
    const lossDisplay = carrier.stats.hasData
      ? `${carrier.stats.avgLoss.toFixed(1)}%`
      : carrierStats.loading.value
        ? (appStore.lang === 'zh-CN' ? '加载中' : 'Loading')
        : '-'

    const latencyTooltip = carrier.hasLatency
      ? `${taskHint}\n${appStore.lang === 'zh-CN' ? '平均延迟' : 'Average latency'} ${Math.round(carrier.stats.avgLatency)} ms`
      : taskHint
    const volatility = carrier.stats.avgVolatility > 0
      ? `，${appStore.lang === 'zh-CN' ? '平均波动' : 'volatility'} ${carrier.stats.avgVolatility.toFixed(2)}`
      : ''
    const lossTooltip = carrier.stats.hasData
      ? `${taskHint}\n${appStore.lang === 'zh-CN' ? '平均丢包' : 'Average loss'} ${carrier.stats.avgLoss.toFixed(1)}%${volatility}`
      : taskHint

    return {
      key: carrier.key,
      label,
      dotClass: CARRIER_DOT_CLASSES[carrier.key],
      taskNames: carrier.taskNames,
      latencyDisplay,
      lossDisplay,
      latencyBars,
      lossBars,
      latencyTooltip,
      lossTooltip,
    }
  }))

  return {
    carrierDisplays,
    loading: carrierStats.loading,
    error: carrierStats.error,
  }
}
