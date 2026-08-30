import type { MaybeRefOrGetter } from 'vue'
import type { MetricLossPoint, NodePingStatsState, PingRecord, SharedPingRecordsState } from '@/composables/useNodePingStats'
import type { PingMetricTaskStats, PingTaskInfo } from '@/utils/rpc'
import { computed, onScopeDispose, ref, shallowRef, toValue, watch } from 'vue'
import {
  buildPingHistory,
  getPercentile,
  getSharedPingRecordsEntry,
  loadSharedPingRecords,
  normalizeTaskId,
  PING_RECORD_REFRESH_INTERVAL_MS,
  retainSharedPingRecordsEntry,
} from '@/composables/useNodePingStats'
import { PING_SUMMARY_MAX_COUNT } from '@/constants/load'
import { loadPublicPingTasks } from '@/services/metrics.service'

export type ChinaCarrierKey = 'unicom' | 'telecom' | 'mobile'

export interface NodeCarrierPingStatsState {
  key: ChinaCarrierKey
  labelZh: string
  labelEn: string
  taskNames: string[]
  stats: NodePingStatsState
  hasLatency: boolean
}

const CHINA_CARRIER_DEFINITIONS: Array<{
  key: ChinaCarrierKey
  labelZh: string
  labelEn: string
  matchers: RegExp[]
}> = [
  {
    key: 'unicom',
    labelZh: '联通',
    labelEn: 'Unicom',
    matchers: [/联通/, /china\s*unicom/i, /\bunicom\b/i, /\bcucc\b/i, /\bcuvip\b/i, /\b9929\b/, /\b10099\b/],
  },
  {
    key: 'telecom',
    labelZh: '电信',
    labelEn: 'Telecom',
    matchers: [/电信/, /china\s*telecom/i, /\btelecom\b/i, /\bctcc\b/i, /\bchinanet\b/i, /\bcn2\b/i, /\bctgnet\b/i],
  },
  {
    key: 'mobile',
    labelZh: '移动',
    labelEn: 'Mobile',
    matchers: [/移动/, /china\s*mobile/i, /\bmobile\b/i, /\bcmcc\b/i, /\bcmi\b/i, /\bcmin2\b/i],
  },
]

const FULL_LOSS_EPSILON = 1e-6
const PUBLIC_TASKS_TTL_MS = 5 * 60_000

const publicPingTasks = shallowRef<PingTaskInfo[]>([])
let publicPingTasksLoadedAt = 0
let publicPingTasksPromise: Promise<void> | null = null

function ensurePublicPingTasks(): void {
  if (publicPingTasksPromise || Date.now() - publicPingTasksLoadedAt < PUBLIC_TASKS_TTL_MS)
    return

  publicPingTasksPromise = loadPublicPingTasks()
    .then((tasks) => {
      publicPingTasks.value = Array.isArray(tasks) ? tasks : []
      publicPingTasksLoadedAt = Date.now()
    })
    .catch(() => {})
    .finally(() => {
      publicPingTasksPromise = null
    })
}

function getCarrierForTaskName(taskName: string): ChinaCarrierKey | null {
  for (const definition of CHINA_CARRIER_DEFINITIONS) {
    if (definition.matchers.some(matcher => matcher.test(taskName)))
      return definition.key
  }
  return null
}

function average(values: number[]): number {
  if (!values.length)
    return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function weightedAverage(values: Array<{ value: number, weight: number }>): number {
  const weightedValues = values.filter(item => item.weight > 0)
  const totalWeight = weightedValues.reduce((sum, item) => sum + item.weight, 0)
  if (!totalWeight)
    return 0
  return weightedValues.reduce((sum, item) => sum + item.value * item.weight, 0) / totalWeight
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function createEmptyStats(): NodePingStatsState {
  return {
    avgLatency: 0,
    avgLoss: 0,
    avgVolatility: 0,
    history: [],
    hasData: false,
  }
}

function createEmptyCarrierStats(): NodeCarrierPingStatsState[] {
  return CHINA_CARRIER_DEFINITIONS.map(definition => ({
    key: definition.key,
    labelZh: definition.labelZh,
    labelEn: definition.labelEn,
    taskNames: [],
    stats: createEmptyStats(),
    hasLatency: false,
  }))
}

interface CarrierTaskIndex {
  taskIds: Map<ChinaCarrierKey, Set<number>>
  taskNames: Map<ChinaCarrierKey, string[]>
}

/** 汇总 Metric 统计与公开 Ping 任务两个来源的任务名，按运营商归类任务 ID。 */
function buildCarrierTaskIndex(metricStats: PingMetricTaskStats[] | undefined): CarrierTaskIndex {
  const taskIds = new Map<ChinaCarrierKey, Set<number>>()
  const taskNames = new Map<ChinaCarrierKey, string[]>()

  function register(carrier: ChinaCarrierKey, taskId: number, taskName: string): void {
    if (!Number.isFinite(taskId))
      return
    const ids = taskIds.get(carrier) ?? new Set<number>()
    if (ids.has(taskId))
      return
    ids.add(taskId)
    taskIds.set(carrier, ids)
    const names = taskNames.get(carrier) ?? []
    if (!names.includes(taskName))
      names.push(taskName)
    taskNames.set(carrier, names)
  }

  for (const task of publicPingTasks.value) {
    if (!Number.isFinite(task.id) || typeof task.name !== 'string')
      continue
    const carrier = getCarrierForTaskName(task.name)
    if (carrier)
      register(carrier, task.id, task.name)
  }

  for (const stat of metricStats ?? []) {
    if (typeof stat.name !== 'string' || !stat.name)
      continue
    const carrier = getCarrierForTaskName(stat.name)
    if (carrier)
      register(carrier, normalizeTaskId(stat.task_id), stat.name)
  }

  return { taskIds, taskNames }
}

function buildLegacyCarrierStats(records: PingRecord[]): { stats: NodePingStatsState, hasLatency: boolean } {
  if (!records.length)
    return { stats: createEmptyStats(), hasLatency: false }

  const history = buildPingHistory(records)
  const taskRecords = new Map<number, PingRecord[]>()

  for (const record of records) {
    const currentRecords = taskRecords.get(record.task_id) ?? []
    currentRecords.push(record)
    taskRecords.set(record.task_id, currentRecords)
  }

  const latencyValues: number[] = []
  const lossValues: number[] = []
  const volatilityValues: number[] = []

  for (const recordsByTask of taskRecords.values()) {
    const validValues = recordsByTask
      .map(record => record.value)
      .filter(value => value >= 0)

    if (validValues.length)
      latencyValues.push(average(validValues))

    lossValues.push((recordsByTask.length - validValues.length) / recordsByTask.length * 100)

    if (validValues.length > 1) {
      const p50 = getPercentile(validValues, 0.5)
      const p99 = getPercentile(validValues, 0.99)
      if (isFiniteNumber(p50) && isFiniteNumber(p99) && p50 > FULL_LOSS_EPSILON)
        volatilityValues.push(p99 / p50)
    }
  }

  const hasLatency = latencyValues.length > 0
  return {
    stats: {
      avgLatency: hasLatency ? average(latencyValues) : 0,
      avgLoss: average(lossValues),
      avgVolatility: average(volatilityValues),
      history,
      hasData: true,
    },
    hasLatency,
  }
}

function buildMetricCarrierStats(
  records: PingRecord[],
  metricStats: PingMetricTaskStats[],
  lossPoints: MetricLossPoint[],
): { stats: NodePingStatsState, hasLatency: boolean } {
  const statsWithSamples = metricStats.filter(stat => stat.total > 0)
  if (!statsWithSamples.length && !records.length)
    return { stats: createEmptyStats(), hasLatency: false }

  const history = buildPingHistory(records.filter(record => record.value >= 0), lossPoints)

  const latencyValues = statsWithSamples
    .flatMap(stat => stat.valid > 0 && isFiniteNumber(stat.avg)
      ? [{ value: stat.avg, weight: stat.valid }]
      : [])
  const latestLatencyValues = statsWithSamples
    .map(stat => stat.latest)
    .filter(isFiniteNumber)
  const lossValues = statsWithSamples
    .filter(stat => !stat.loss_approximate && isFiniteNumber(stat.loss))
    .map(stat => ({ value: stat.loss, weight: stat.total }))
  const volatilityValues = statsWithSamples
    .filter(stat => stat.valid > 0 && isFiniteNumber(stat.p99_p50_ratio))
    .map(stat => ({ value: stat.p99_p50_ratio!, weight: stat.valid }))

  const hasLatency = latencyValues.length > 0 || latestLatencyValues.length > 0
  return {
    stats: {
      avgLatency: latencyValues.length ? weightedAverage(latencyValues) : average(latestLatencyValues),
      avgLoss: weightedAverage(lossValues),
      avgVolatility: weightedAverage(volatilityValues),
      history,
      hasData: true,
    },
    hasLatency,
  }
}

function buildCarrierStatsFromState(state: SharedPingRecordsState, nodeUuid: string): NodeCarrierPingStatsState[] {
  const { taskIds, taskNames } = buildCarrierTaskIndex(state.metricStats)
  const nodeRecords = state.recordsByClient.get(nodeUuid) ?? []

  return CHINA_CARRIER_DEFINITIONS.map((definition) => {
    const ids = taskIds.get(definition.key) ?? new Set<number>()
    const names = taskNames.get(definition.key) ?? []

    if (!ids.size) {
      return {
        key: definition.key,
        labelZh: definition.labelZh,
        labelEn: definition.labelEn,
        taskNames: [],
        stats: createEmptyStats(),
        hasLatency: false,
      }
    }

    const carrierRecords = nodeRecords.filter(record => ids.has(record.task_id))

    const { stats, hasLatency } = state.source === 'metric'
      ? buildMetricCarrierStats(
          carrierRecords,
          (state.metricStats ?? []).filter(stat => ids.has(normalizeTaskId(stat.task_id))),
          (state.metricLossPoints ?? []).filter(point => point.task_id !== undefined && ids.has(point.task_id)),
        )
      : buildLegacyCarrierStats(carrierRecords)

    return {
      key: definition.key,
      labelZh: definition.labelZh,
      labelEn: definition.labelEn,
      taskNames: names,
      stats,
      hasLatency,
    }
  })
}

/**
 * 按 Ping 任务名称识别中国联通 / 中国电信 / 中国移动，并分别计算节点的延迟和丢包。
 * 任务名称可包含：联通/Unicom/CUCC、电信/Telecom/CTCC/CN2、移动/Mobile/CMCC/CMIN2。
 * 数据复用 useNodePingStats 的共享请求缓存，不会对同一节点重复拉取 Ping 记录。
 */
export function useNodeCarrierPingStats(
  uuid: MaybeRefOrGetter<string>,
  options?: {
    hours?: MaybeRefOrGetter<number>
    enabled?: MaybeRefOrGetter<boolean>
    maxCount?: MaybeRefOrGetter<number | undefined>
  },
) {
  const loading = ref(false)
  const error = ref<string | null>(null)

  const resolved = computed(() => {
    const maxCountRaw = toValue(options?.maxCount) ?? PING_SUMMARY_MAX_COUNT
    const maxCount = isFiniteNumber(maxCountRaw) && maxCountRaw > 0 ? Math.floor(maxCountRaw) : undefined
    return {
      uuid: toValue(uuid),
      hours: Math.max(1, Math.floor(toValue(options?.hours) ?? 1)),
      maxCount,
      enabled: toValue(options?.enabled) ?? true,
    }
  })

  let activeKey: string | null = null
  let releaseSharedRecords: (() => void) | null = null

  function syncSharedRecordsSubscription(hours: number | null, maxCount?: number, nodeUuid?: string): void {
    const key = hours === null ? null : `${nodeUuid ?? ''}:${hours}:${maxCount ?? 'all'}`
    if (activeKey === key)
      return

    releaseSharedRecords?.()
    releaseSharedRecords = null
    activeKey = null

    if (hours === null)
      return

    releaseSharedRecords = retainSharedPingRecordsEntry(hours, maxCount, nodeUuid)
    activeKey = key
  }

  onScopeDispose(() => {
    syncSharedRecordsSubscription(null)
  })

  const carriers = computed<NodeCarrierPingStatsState[]>(() => {
    const { uuid: nodeUuid, hours, maxCount, enabled } = resolved.value
    if (!enabled || !nodeUuid.trim())
      return createEmptyCarrierStats()

    const entry = getSharedPingRecordsEntry(hours, maxCount, nodeUuid)
    const state = entry.data.value
    if (!state)
      return createEmptyCarrierStats()

    return buildCarrierStatsFromState(state, nodeUuid)
  })

  // 副作用：与 useNodePingStats 相同的共享订阅与加载节奏，另需公开任务名用于归类。
  watch(
    resolved,
    async (next, _previous, onCleanup) => {
      let cancelled = false
      onCleanup(() => {
        cancelled = true
      })

      const { uuid: nodeUuid, hours, maxCount, enabled } = next
      if (!enabled || !nodeUuid.trim()) {
        syncSharedRecordsSubscription(null)
        loading.value = false
        error.value = null
        return
      }

      ensurePublicPingTasks()
      syncSharedRecordsSubscription(hours, maxCount, nodeUuid)
      const entry = getSharedPingRecordsEntry(hours, maxCount, nodeUuid)
      const shouldLoadRecords = !entry.data.value
        || Date.now() - entry.lastFetchedAt >= PING_RECORD_REFRESH_INTERVAL_MS

      if (!shouldLoadRecords) {
        loading.value = false
        error.value = null
        return
      }

      const shouldShowLoading = !entry.data.value
      loading.value = shouldShowLoading
      error.value = null

      try {
        await loadSharedPingRecords(entry, hours, maxCount, nodeUuid)
      }
      catch (err) {
        if (!cancelled && shouldShowLoading)
          error.value = err instanceof Error ? err.message : '获取 Ping 历史失败'
      }
      finally {
        if (!cancelled)
          loading.value = false
      }
    },
    { immediate: true },
  )

  return {
    carriers,
    loading,
    error,
  }
}
