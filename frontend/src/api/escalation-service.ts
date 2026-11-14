import {
  loadEscalationState,
  saveEscalationState,
  type AlertInstance,
  type AuditBatch,
  type EscalationRecord,
  type EscalationState,
} from '@/data/escalation'
import { listRows } from '@/data/local-store'
import type { EntryRow } from '@/data/types'

// ---------------------------------------------------------------------------
// 升级策略常量（告警合并边界和级别阈值集中在这里声明，页面只读不改）
// ---------------------------------------------------------------------------

/**
 * 告警合并边界：同一「审计规则编号 + 异常条件 + 目标预警规则编号」只保留一条未结告警。
 * 两个审计批次同时报出同一异常时，只有当前这条未结告警继续升级，
 * 其余批次合并进来，不新建告警、不写新升级记录。
 */
export function mergeKeyOf(ruleCode: string, condition: string, opsCode: string): string {
  return `${ruleCode}::${condition}::${opsCode}`
}

/**
 * 建议级别阈值：以目标预警规则的阈值数值 T 为基准按比例定级。
 * 异常量 ≥ 2T → P1 严重；T ≤ 异常量 < 2T → P2 重要；
 * 0.5T ≤ 异常量 < T → P3 次要；其余 → P4 提示。
 */
export const LEVEL_THRESHOLDS: { level: string; minRatio: number }[] = [
  { level: 'P1 严重', minRatio: 2 },
  { level: 'P2 重要', minRatio: 1 },
  { level: 'P3 次要', minRatio: 0.5 },
  { level: 'P4 提示', minRatio: 0 },
]

export function suggestLevel(volume: number, threshold: number): string {
  const ratio = threshold > 0 ? volume / threshold : Number.POSITIVE_INFINITY
  for (const item of LEVEL_THRESHOLDS) {
    if (ratio >= item.minRatio) {
      return item.level
    }
  }
  return LEVEL_THRESHOLDS[LEVEL_THRESHOLDS.length - 1].level
}

/** 按预警规则的比较方式判断异常量是否命中阈值 */
export function hitThreshold(volume: number, compare: string, threshold: number): boolean {
  switch (compare) {
    case '大于':
      return volume > threshold
    case '大于等于':
      return volume >= threshold
    case '小于':
      return volume < threshold
    case '小于等于':
      return volume <= threshold
    case '等于':
      return volume === threshold
    default:
      return volume > threshold
  }
}

// ---------------------------------------------------------------------------
// 查询
// ---------------------------------------------------------------------------

function findRule(moduleKey: string, codeField: string, code: string): EntryRow | undefined {
  return listRows(moduleKey).find((row) => String(row[codeField] ?? '') === code)
}

export function auditRuleByCode(code: string): EntryRow | undefined {
  return findRule('auditcheck', '规则编号', code)
}

export function opsRuleByCode(code: string): EntryRow | undefined {
  return findRule('opsalert', '预警编号', code)
}

/** 只有「已生效」的规则才参与升级（审计版本固定为当前生效版本） */
export function effectiveAuditRules(): EntryRow[] {
  return listRows('auditcheck').filter((row) => row.status === '已生效')
}

export function effectiveOpsRules(): EntryRow[] {
  return listRows('opsalert').filter((row) => row.status === '已生效')
}

export function listBatches(ruleCode?: string, condition?: string): AuditBatch[] {
  const { batches } = loadEscalationState()
  return batches.filter(
    (batch) =>
      (!ruleCode || batch.ruleCode === ruleCode) && (!condition || batch.condition === condition),
  )
}

export function listAlerts(): AlertInstance[] {
  return loadEscalationState().alerts
}

export function listRecords(): EscalationRecord[] {
  return loadEscalationState().records
}

export function findAlert(code: string): AlertInstance | undefined {
  return loadEscalationState().alerts.find((alert) => alert.code === code)
}

// ---------------------------------------------------------------------------
// 升级预检：先展示告警结论、异常量及建议级别，达到持续周期才允许建立未结告警
// ---------------------------------------------------------------------------

export type EscalationPreview = {
  ok: boolean
  message: string
  conclusion: string // 告警结论
  volume: number // 最新周期异常量
  streak: number // 当前连续命中周期数
  requiredPeriods: number // 持续周期
  threshold: number // 阈值数值
  compare: string // 比较方式
  suggestedLevel: string // 建议级别
  reached: boolean // 是否达到持续周期
  openAlertCode?: string // 已存在的未结告警（命中合并边界）
}

function toNumber(value: unknown, fallback: number): number {
  const num = Number(value)
  return Number.isFinite(num) ? num : fallback
}

/** 审计频率按日处理：相邻周期日期相差 1 天；解析不了就退化为列表相邻 */
function isAdjacentPeriod(prev: string, next: string): boolean {
  const prevTime = Date.parse(prev)
  const nextTime = Date.parse(next)
  if (Number.isNaN(prevTime) || Number.isNaN(nextTime)) {
    return true
  }
  return Math.round((nextTime - prevTime) / 86_400_000) === 1
}

/** 汇总某合并键下已上报批次：按周期取最大异常量，从最新周期往回数连续命中数 */
function evaluateStreak(
  batches: AuditBatch[],
  compare: string,
  threshold: number,
): { volume: number; streak: number; periods: string[] } {
  const byPeriod = new Map<string, number>()
  for (const batch of batches) {
    const current = byPeriod.get(batch.period)
    if (current === undefined || batch.volume > current) {
      byPeriod.set(batch.period, batch.volume)
    }
  }
  const periods = [...byPeriod.keys()].sort()
  const volume = periods.length > 0 ? byPeriod.get(periods[periods.length - 1]) ?? 0 : 0
  let streak = 0
  for (let index = periods.length - 1; index >= 0; index -= 1) {
    const periodVolume = byPeriod.get(periods[index]) ?? 0
    if (!hitThreshold(periodVolume, compare, threshold)) {
      break
    }
    if (index < periods.length - 1 && !isAdjacentPeriod(periods[index], periods[index + 1])) {
      break
    }
    streak += 1
  }
  return { volume, streak, periods }
}

function buildEvaluation(
  ruleCode: string,
  condition: string,
  opsCode: string,
): { error?: string; preview?: EscalationPreview } {
  const auditRule = auditRuleByCode(ruleCode)
  if (!auditRule) {
    return { error: `没有找到审计规则 ${ruleCode}` }
  }
  if (auditRule.status !== '已生效') {
    return { error: `审计规则 ${ruleCode} 当前状态「${auditRule.status}」，未生效不能升级` }
  }
  const opsRule = opsRuleByCode(opsCode)
  if (!opsRule) {
    return { error: `没有找到预警规则 ${opsCode}` }
  }
  if (opsRule.status !== '已生效') {
    return { error: `预警规则 ${opsCode} 当前状态「${opsRule.status}」，未生效不能作为升级目标` }
  }

  const threshold = toNumber(opsRule['阈值数值'], 0)
  const compare = String(opsRule['比较方式'] ?? '大于')
  const requiredPeriods = Math.max(1, toNumber(opsRule['持续周期'], 1))
  const mergeKey = mergeKeyOf(ruleCode, condition, opsCode)
  const state = loadEscalationState()
  const related = state.batches.filter(
    (batch) => batch.ruleCode === ruleCode && batch.condition === condition,
  )
  const { volume, streak } = evaluateStreak(related, compare, threshold)
  const suggestedLevel = suggestLevel(volume, threshold)
  const reached = streak >= requiredPeriods
  const openAlert = state.alerts.find(
    (alert) => alert.mergeKey === mergeKey && alert.status === '未结',
  )

  let conclusion: string
  if (related.length === 0) {
    conclusion = `${ruleCode} 在该异常条件下暂无审计批次上报，无法评估`
  } else if (openAlert) {
    conclusion = `已存在未结告警 ${openAlert.code}（合并边界内），新批次将合并到当前告警继续升级`
  } else if (reached) {
    conclusion = `异常量 ${volume} 连续 ${streak} 个周期命中阈值（${compare} ${threshold}），达到持续周期 ${requiredPeriods}，建议建立未结告警`
  } else {
    conclusion = `异常量 ${volume} 连续 ${streak} 个周期命中阈值（${compare} ${threshold}），未达持续周期 ${requiredPeriods}，暂不建立告警`
  }

  return {
    preview: {
      ok: true,
      message: '',
      conclusion,
      volume,
      streak,
      requiredPeriods,
      threshold,
      compare,
      suggestedLevel,
      reached,
      openAlertCode: openAlert?.code,
    },
  }
}

export function previewEscalation(
  ruleCode: string,
  condition: string,
  opsCode: string,
): EscalationPreview {
  const { error, preview } = buildEvaluation(ruleCode, condition, opsCode)
  if (error || !preview) {
    return {
      ok: false,
      message: error ?? '预检失败',
      conclusion: error ?? '预检失败',
      volume: 0,
      streak: 0,
      requiredPeriods: 0,
      threshold: 0,
      compare: '',
      suggestedLevel: '',
      reached: false,
    }
  }
  return preview
}

// ---------------------------------------------------------------------------
// 升级提交：支持整组批量提交，每个条目单独返回结果
// ---------------------------------------------------------------------------

export type EscalationRequest = {
  batchId: string
  ruleCode: string
  condition: string
  opsCode: string
}

export type EscalationItemResult = {
  batchId: string
  ok: boolean
  outcome: '已建立' | '已合并' | '未达持续周期' | '未通过'
  message: string
  alertCode?: string
}

function nowText(): string {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
}

function nextCode(prefix: string, existing: string[]): string {
  const max = existing.reduce((acc, code) => {
    const num = Number(code.replace(`${prefix}-`, ''))
    return Number.isFinite(num) ? Math.max(acc, num) : acc
  }, 0)
  return `${prefix}-${String(max + 1).padStart(4, '0')}`
}

/**
 * 写入前校验：保证「告警建立与升级记录写入同时成功」。
 * 任一校验失败都抛错，state 不会被持久化，预警状态不会被单独改变。
 */
function assertEscalationInvariants(state: EscalationState): void {
  const openByMergeKey = new Set<string>()
  for (const alert of state.alerts) {
    if (alert.status !== '未结') {
      continue
    }
    if (openByMergeKey.has(alert.mergeKey)) {
      throw new Error(`合并边界被破坏：${alert.mergeKey} 下存在多条未结告警`)
    }
    openByMergeKey.add(alert.mergeKey)
    if (!alert.auditVersion || alert.triggerValue === undefined) {
      throw new Error(`告警 ${alert.code} 缺少审计版本或触发值，不允许写入`)
    }
  }
  const alertCodes = new Set(state.alerts.map((alert) => alert.code))
  for (const record of state.records) {
    if (!alertCodes.has(record.alertCode)) {
      throw new Error(`升级记录 ${record.code} 关联的告警 ${record.alertCode} 不存在，不允许写入`)
    }
  }
}

/** 原子提交：告警实例与升级记录在同一次 saveEscalationState 里落库 */
function commitState(next: EscalationState): void {
  assertEscalationInvariants(next)
  saveEscalationState(next)
}

function submitOne(request: EscalationRequest, operator: string): EscalationItemResult {
  const state = loadEscalationState()
  const batch = state.batches.find((item) => item.id === request.batchId)
  if (!batch) {
    return { batchId: request.batchId, ok: false, outcome: '未通过', message: `批次 ${request.batchId} 不存在` }
  }
  if (batch.status !== '待升级') {
    return {
      batchId: batch.id,
      ok: false,
      outcome: '未通过',
      message: `批次 ${batch.id} 已是「${batch.status}」状态，不能重复升级`,
    }
  }

  const { error, preview } = buildEvaluation(request.ruleCode, request.condition, request.opsCode)
  if (error || !preview) {
    return { batchId: batch.id, ok: false, outcome: '未通过', message: error ?? '升级预检未通过' }
  }

  if (!preview.reached && !preview.openAlertCode) {
    return {
      batchId: batch.id,
      ok: false,
      outcome: '未达持续周期',
      message: `连续 ${preview.streak} 个周期命中阈值，未达持续周期 ${preview.requiredPeriods}，暂不建立告警`,
    }
  }

  const mergeKey = mergeKeyOf(request.ruleCode, request.condition, request.opsCode)

  // 命中合并边界：已有未结告警时，本批次合并进去，只有当前告警继续升级
  if (preview.openAlertCode) {
    const next: EscalationState = {
      ...state,
      batches: state.batches.map((item) =>
        item.id === batch.id ? { ...item, status: '已合并', alertCode: preview.openAlertCode } : item,
      ),
      alerts: state.alerts.map((alert) =>
        alert.code === preview.openAlertCode
          ? { ...alert, mergedBatches: [...alert.mergedBatches, batch.id] }
          : alert,
      ),
    }
    try {
      commitState(next)
    } catch (commitError) {
      return {
        batchId: batch.id,
        ok: false,
        outcome: '未通过',
        message: `合并写入失败：${commitError instanceof Error ? commitError.message : '未知错误'}，预警状态未变更`,
      }
    }
    return {
      batchId: batch.id,
      ok: true,
      outcome: '已合并',
      message: `已存在未结告警 ${preview.openAlertCode}，本批次合并处理，仅当前告警继续升级`,
      alertCode: preview.openAlertCode,
    }
  }

  // 建立未结告警 + 升级记录：两处写入同事务，失败则整体不落库
  const auditRule = auditRuleByCode(request.ruleCode)
  const opsRule = opsRuleByCode(request.opsCode)
  if (!auditRule || !opsRule) {
    return { batchId: batch.id, ok: false, outcome: '未通过', message: '规则读取失败，未写入任何数据' }
  }
  const alertCode = nextCode('ALM', state.alerts.map((alert) => alert.code))
  const recordCode = nextCode('ESC', state.records.map((record) => record.code))
  const auditVersion = String(auditRule['规则版本'] ?? 'v1')
  const alert: AlertInstance = {
    code: alertCode,
    mergeKey,
    ruleCode: request.ruleCode,
    auditVersion,
    auditSnapshot: {
      审计对象: String(auditRule['审计对象'] ?? ''),
      校验字段: String(auditRule['校验字段'] ?? ''),
      异常条件: String(auditRule['异常条件'] ?? ''),
      告警级别: String(auditRule['告警级别'] ?? ''),
      审计频率: String(auditRule['审计频率'] ?? ''),
    },
    condition: request.condition,
    triggerValue: preview.volume,
    streak: preview.streak,
    level: preview.suggestedLevel,
    opsCode: request.opsCode,
    opsSnapshot: {
      监控指标: String(opsRule['监控指标'] ?? ''),
      比较方式: String(opsRule['比较方式'] ?? ''),
      阈值数值: String(opsRule['阈值数值'] ?? ''),
      持续周期: String(opsRule['持续周期'] ?? ''),
      升级策略: String(opsRule['升级策略'] ?? ''),
    },
    sourceBatches: [batch.id],
    mergedBatches: [],
    status: '未结',
    operator,
    createdAt: nowText(),
  }
  const record: EscalationRecord = {
    code: recordCode,
    alertCode,
    ruleCode: request.ruleCode,
    auditVersion,
    condition: request.condition,
    triggerValue: preview.volume,
    streak: preview.streak,
    suggestedLevel: preview.suggestedLevel,
    opsCode: request.opsCode,
    conclusion: `${request.ruleCode} 异常量 ${preview.volume} 连续 ${preview.streak} 个周期命中阈值（${preview.compare} ${preview.threshold}），达到持续周期 ${preview.requiredPeriods}，建立未结告警 ${alertCode}，建议级别 ${preview.suggestedLevel}（审计版本 ${auditVersion}）`,
    operator,
    createdAt: alert.createdAt,
  }
  const next: EscalationState = {
    batches: state.batches.map((item) =>
      item.id === batch.id ? { ...item, status: '已升级', alertCode } : item,
    ),
    alerts: [...state.alerts, alert],
    records: [...state.records, record],
  }
  try {
    commitState(next)
  } catch (commitError) {
    return {
      batchId: batch.id,
      ok: false,
      outcome: '未通过',
      message: `告警与升级记录写入失败：${commitError instanceof Error ? commitError.message : '未知错误'}，预警状态未变更`,
    }
  }
  return {
    batchId: batch.id,
    ok: true,
    outcome: '已建立',
    message: `已建立未结告警 ${alertCode}，并同步写入升级记录 ${recordCode}（审计版本 ${auditVersion}，触发值 ${preview.volume}）`,
    alertCode,
  }
}

/** 整组提交：一次提交勾选的全部条目，每条独立评估、独立落库、单独返回结果 */
export function submitEscalationGroup(
  requests: EscalationRequest[],
  operator: string,
): EscalationItemResult[] {
  return requests.map((request) => submitOne(request, operator))
}

/** 未通过/暂不升级的批次由操作人处理：确认不升级可忽略 */
export function ignoreBatch(batchId: string): { ok: boolean; message: string } {
  const state = loadEscalationState()
  const batch = state.batches.find((item) => item.id === batchId)
  if (!batch) {
    return { ok: false, message: `批次 ${batchId} 不存在` }
  }
  if (batch.status !== '待升级') {
    return { ok: false, message: `批次 ${batchId} 已是「${batch.status}」状态，无需忽略` }
  }
  commitState({
    ...state,
    batches: state.batches.map((item) =>
      item.id === batchId ? { ...item, status: '已忽略' } : item,
    ),
  })
  return { ok: true, message: `批次 ${batchId} 已由操作人标记为已忽略` }
}

/** 结案：未结告警关闭后，同一合并边界内才允许建立下一条告警 */
export function closeAlert(code: string, operator: string): { ok: boolean; message: string } {
  const state = loadEscalationState()
  const alert = state.alerts.find((item) => item.code === code)
  if (!alert) {
    return { ok: false, message: `告警 ${code} 不存在` }
  }
  if (alert.status === '已结') {
    return { ok: false, message: `告警 ${code} 已结案，不用重复操作` }
  }
  commitState({
    ...state,
    alerts: state.alerts.map((item) =>
      item.code === code ? { ...item, status: '已结', closedAt: nowText() } : item,
    ),
  })
  return { ok: true, message: `告警 ${code} 已由 ${operator} 结案，后续同异常可重新升级建立新告警` }
}
