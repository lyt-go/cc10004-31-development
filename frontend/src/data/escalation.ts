// 审计异常升级到运营告警的领域数据：审计批次、告警实例、升级记录。
// 与模块清单分开存（独立 localStorage key），带 schema 版本，结构变了就重播种。

/** 审计批次状态：待升级 → 已升级 / 已合并 / 已忽略 */
export type BatchStatus = '待升级' | '已升级' | '已合并' | '已忽略'

/** 审计批次：一次审计周期跑出来的异常量快报 */
export type AuditBatch = {
  id: string // 批次编号，如 BAT-20261114-02
  ruleCode: string // 审计规则编号，如 AUDI-0002
  condition: string // 异常条件（批次上报时从规则快照）
  period: string // 审计周期，如 2026-11-14
  volume: number // 异常量
  status: BatchStatus
  alertCode?: string // 归属的告警编号（已升级/已合并时回填）
}

/** 告警实例：升级流程建立的未结/已结告警，审计版本与触发值在建立时固定 */
export type AlertInstance = {
  code: string // 告警编号，如 ALM-0001
  mergeKey: string // 合并边界键：审计规则 + 异常条件 + 目标预警规则
  ruleCode: string // 审计规则编号
  auditVersion: string // 审计版本：固定为升级时当前生效版本，规则改版不影响本告警
  auditSnapshot: {
    审计对象: string
    校验字段: string
    异常条件: string
    告警级别: string
    审计频率: string
  }
  condition: string // 异常条件
  triggerValue: number // 触发值：建立时最新一周期的异常量，之后不再变化
  streak: number // 建立时的连续超阈值周期数
  level: string // 告警级别（采纳建议级别）
  opsCode: string // 目标预警规则编号
  opsSnapshot: {
    监控指标: string
    比较方式: string
    阈值数值: string
    持续周期: string
    升级策略: string
  }
  sourceBatches: string[] // 建立告警的批次
  mergedBatches: string[] // 合并进来的并发/重复批次
  status: '未结' | '已结'
  operator: string
  createdAt: string
  closedAt?: string
}

/** 升级记录：与告警建立同一次写入，可追溯 */
export type EscalationRecord = {
  code: string // 记录编号，如 ESC-0001
  alertCode: string // 关联告警编号
  ruleCode: string
  auditVersion: string // 固定为升级时生效的审计版本
  condition: string
  triggerValue: number
  streak: number
  suggestedLevel: string
  opsCode: string
  conclusion: string // 告警结论
  operator: string
  createdAt: string
}

export type EscalationState = {
  batches: AuditBatch[]
  alerts: AlertInstance[]
  records: EscalationRecord[]
}

const STORAGE_KEY = 'data-product-ops:escalation'
const SCHEMA_KEY = 'data-product-ops:escalation-schema'
const SCHEMA_VERSION = 1

// 示例批次：AUDI-0002 连续两个周期（2026-11-13、2026-11-14）报出异常量 120，
// 其中 11-14 有一个并发重复批次（同一异常同时报两次），用来验证合并边界；
// AUDI-0003 只有一个周期超阈值，用来验证「未达持续周期不建告警」。
export const SEED_ESCALATION: EscalationState = {
  batches: [
    {
      id: 'BAT-20261113-02',
      ruleCode: 'AUDI-0002',
      condition: '订单金额为空或负值的记录数 > 100',
      period: '2026-11-13',
      volume: 120,
      status: '待升级',
    },
    {
      id: 'BAT-20261114-02',
      ruleCode: 'AUDI-0002',
      condition: '订单金额为空或负值的记录数 > 100',
      period: '2026-11-14',
      volume: 120,
      status: '待升级',
    },
    {
      id: 'BAT-20261114-02B',
      ruleCode: 'AUDI-0002',
      condition: '订单金额为空或负值的记录数 > 100',
      period: '2026-11-14',
      volume: 120,
      status: '待升级',
    },
    {
      id: 'BAT-20261114-03',
      ruleCode: 'AUDI-0003',
      condition: 'user_id 重复记录数 > 50',
      period: '2026-11-14',
      volume: 86,
      status: '待升级',
    },
  ],
  alerts: [],
  records: [],
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readState(): EscalationState {
  const fallback = clone(SEED_ESCALATION)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const version = Number(window.localStorage.getItem(SCHEMA_KEY) ?? '0')
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw || version !== SCHEMA_VERSION) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    window.localStorage.setItem(SCHEMA_KEY, String(SCHEMA_VERSION))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as EscalationState
    return {
      batches: parsed.batches ?? [],
      alerts: parsed.alerts ?? [],
      records: parsed.records ?? [],
    }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: EscalationState | null = null

export function loadEscalationState(): EscalationState {
  if (cache === null) {
    cache = readState()
  }
  return cache
}

/** 唯一持久化出口：告警与升级记录只能在同一次 save 里落库，保证写入同时成功 */
export function saveEscalationState(state: EscalationState): void {
  cache = state
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(SCHEMA_KEY, String(SCHEMA_VERSION))
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  }
}

export function resetEscalationState(): EscalationState {
  const fresh = clone(SEED_ESCALATION)
  saveEscalationState(fresh)
  return fresh
}
