import { useCallback, useEffect, useMemo, useState } from 'react'

import { downloadEntries, listEntries, moduleMeta, runAction as applyAction } from '@/api/local-service'
import {
  closeAlert,
  effectiveAuditRules,
  effectiveOpsRules,
  findAlert,
  ignoreBatch,
  listAlerts,
  listBatches,
  listRecords,
  previewEscalation,
  submitEscalationGroup,
  type EscalationItemResult,
  type EscalationPreview,
} from '@/api/escalation-service'
import type { AlertInstance, AuditBatch, EscalationRecord } from '@/data/escalation'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('opsalert')
const columns = [
  "预警编号",
  "监控指标",
  "比较方式",
  "阈值数值",
  "持续周期",
  "预警级别",
  "通知对象",
  "升级策略"
]
const actions = [
  "提交规则评审",
  "生效规则",
  "关闭规则"
]
const statuses = [
  "草稿",
  "规则评审中",
  "已生效",
  "已关闭"
]

const OPERATOR = '值班管理员'

export default function OpsalertView() {
  const [rows, setRows] = useState<EntryRow[]>([])
  const [total, setTotal] = useState(0)
  const [errorMessage, setErrorMessage] = useState('')
  const [noticeMessage, setNoticeMessage] = useState('')
  const [filters, setFilters] = useState<Record<string, string>>({})
  const filterFields = useMemo(() => columns.slice(0, 3), [])

  // 升级工作台状态
  const auditOptions = useMemo(() => effectiveAuditRules(), [])
  const opsOptions = useMemo(() => effectiveOpsRules(), [])
  const [ruleCode, setRuleCode] = useState(() => String(auditOptions[0]?.['规则编号'] ?? ''))
  const [opsCode, setOpsCode] = useState(() => String(opsOptions[0]?.['预警编号'] ?? ''))
  const conditionOptions = useMemo(() => {
    const fromRule = auditOptions.find((row) => String(row['规则编号']) === ruleCode)
    const conditions = new Set<string>()
    if (fromRule) {
      conditions.add(String(fromRule['异常条件'] ?? ''))
    }
    for (const batch of listBatches(ruleCode)) {
      conditions.add(batch.condition)
    }
    conditions.delete('')
    return [...conditions]
  }, [auditOptions, ruleCode])
  const [condition, setCondition] = useState('')
  const activeCondition = condition || conditionOptions[0] || ''
  const [preview, setPreview] = useState<EscalationPreview | null>(null)
  const [batches, setBatches] = useState<AuditBatch[]>([])
  const [checked, setChecked] = useState<string[]>([])
  const [results, setResults] = useState<Record<string, EscalationItemResult>>({})
  const [alerts, setAlerts] = useState<AlertInstance[]>([])
  const [records, setRecords] = useState<EscalationRecord[]>([])
  const [detail, setDetail] = useState<AlertInstance | null>(null)

  const reload = useCallback(() => {
    setErrorMessage('')
    try {
      const payload = listEntries(meta.key, filters)
      setRows(payload.items)
      setTotal(payload.total)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '运营预警列表读取失败')
    }
  }, [filters])

  const reloadEscalation = useCallback(() => {
    setBatches(listBatches(ruleCode, activeCondition))
    setAlerts(listAlerts())
    setRecords(listRecords())
  }, [ruleCode, activeCondition])

  useEffect(() => {
    reload()
  }, [reload])

  useEffect(() => {
    reloadEscalation()
  }, [reloadEscalation])

  // 选择审计规则、异常条件和目标预警规则后，先展示告警结论、异常量及建议级别
  useEffect(() => {
    if (ruleCode && activeCondition && opsCode) {
      setPreview(previewEscalation(ruleCode, activeCondition, opsCode))
    } else {
      setPreview(null)
    }
  }, [ruleCode, activeCondition, opsCode])

  function runAction(action: string, row: EntryRow) {
    setErrorMessage('')
    const result = applyAction(meta.key, Number(row.id), action)
    if (!result.ok) {
      setErrorMessage(result.message)
      return
    }
    reload()
  }

  function toggleBatch(batchId: string, checkedValue: boolean) {
    setChecked((prev) =>
      checkedValue ? [...new Set([...prev, batchId])] : prev.filter((item) => item !== batchId),
    )
  }

  const pendingBatches = batches.filter((batch) => batch.status === '待升级')
  const allChecked = pendingBatches.length > 0 && pendingBatches.every((batch) => checked.includes(batch.id))

  function toggleAll(checkedValue: boolean) {
    setChecked(checkedValue ? pendingBatches.map((batch) => batch.id) : [])
  }

  // 一次提交整组：每条单独返回结果，未通过者留在列表里由操作人处理
  function submitGroup() {
    setErrorMessage('')
    setNoticeMessage('')
    const requests = checked.map((batchId) => ({ batchId, ruleCode, condition: activeCondition, opsCode }))
    if (requests.length === 0) {
      setErrorMessage('请先勾选要升级的审计批次')
      return
    }
    const outcomes = submitEscalationGroup(requests, OPERATOR)
    setResults((prev) => {
      const next = { ...prev }
      for (const outcome of outcomes) {
        next[outcome.batchId] = outcome
      }
      return next
    })
    const failed = outcomes.filter((outcome) => !outcome.ok).length
    setNoticeMessage(
      `本组提交 ${outcomes.length} 条：建立 ${outcomes.filter((o) => o.outcome === '已建立').length} 条，` +
      `合并 ${outcomes.filter((o) => o.outcome === '已合并').length} 条，未通过 ${failed} 条（未通过者请逐条处理）`,
    )
    setChecked([])
    reloadEscalation()
  }

  function handleIgnore(batchId: string) {
    const result = ignoreBatch(batchId)
    if (!result.ok) {
      setErrorMessage(result.message)
      return
    }
    setNoticeMessage(result.message)
    reloadEscalation()
  }

  function handleCloseAlert(code: string) {
    const result = closeAlert(code, OPERATOR)
    if (!result.ok) {
      setErrorMessage(result.message)
      return
    }
    setNoticeMessage(result.message)
    reloadEscalation()
  }

  const stats = [
    { label: '预警规则总数', value: rows.length },
    { label: '已生效规则', value: rows.filter((row) => row.status === '已生效').length },
    { label: '未结告警', value: alerts.filter((alert) => alert.status === '未结').length },
  ]

  return (
    <section className="page" data-module="opsalert">
      <header className="page-head">
        <div>
          <h2>运营预警管理</h2>
          <p className="page-desc">定义数据产品运营的异常预警规则，对DAU骤降、转化率异常和收入波动进行实时告警。</p>
        </div>
        <div className="page-actions">
          <button className="btn primary" type="button" onClick={() => setErrorMessage('预警规则登记入口尚未接入审批流')}>
            登记预警规则
          </button>
          <button className="btn" type="button" onClick={() => downloadEntries(meta.key)}>
            导出运营预警清单
          </button>
        </div>
      </header>

      <div className="stat-row">
        {stats.map((item) => (
          <article key={item.label} className="stat-card">
            <span className="stat-label">{item.label}</span>
            <strong className="stat-value">{item.value}</strong>
          </article>
        ))}
      </div>

      <p className="status-legend">
        {statuses.map((status: string) => (
          <span key={status} className="legend-item">
            {status}：{rows.filter((row) => String(row.status) === status).length}
          </span>
        ))}
      </p>

      <form className="filter-bar" onSubmit={(event) => { event.preventDefault(); reload() }}>
        {filterFields.map((field) => (
          <label key={field} className="filter-item">
            <span>{field}</span>
            <input
              value={filters[field] ?? ''}
              placeholder={`按${field}检索`}
              onChange={(event) => setFilters((prev) => ({ ...prev, [field]: event.target.value }))}
            />
          </label>
        ))}
        <button className="btn" type="submit">查询</button>
        <button className="btn ghost" type="button" onClick={() => setFilters({})}>重置条件</button>
      </form>

      <table className="data-table">
        <thead>
          <tr>
            {columns.map((column) => <th key={column}>{column}</th>)}
            <th>当前状态</th>
            <th>可执行动作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={String(row.id)}>
              {columns.map((column) => <td key={column}>{row[column] ?? '—'}</td>)}
              <td>{row.status}</td>
              <td className="row-actions">
                {actions.map((action) => (
                  <button key={action} className="link" type="button" onClick={() => runAction(action, row)}>
                    {action}
                  </button>
                ))}
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td className="empty-state" colSpan={columns.length + 2}>暂无运营预警数据，可先登记预警规则</td>
            </tr>
          )}
        </tbody>
      </table>

      <section className="escalation-panel">
        <h3>审计异常升级</h3>
        <p className="panel-desc">
          选择审计规则、异常条件和目标预警规则后先预检：展示告警结论、异常量及建议级别；
          达到持续周期才建立未结告警，告警与升级记录同时写入。
          合并边界：同一审计规则 + 异常条件 + 目标预警规则只保留一条未结告警，并发批次合并处理。
        </p>

        <div className="escalation-form">
          <label className="filter-item">
            <span>审计规则</span>
            <select value={ruleCode} onChange={(event) => { setRuleCode(event.target.value); setCondition(''); setResults({}) }}>
              {auditOptions.map((row) => (
                <option key={String(row['规则编号'])} value={String(row['规则编号'])}>
                  {String(row['规则编号'])}（{String(row['规则版本'])} · {String(row['审计对象'])}）
                </option>
              ))}
            </select>
          </label>
          <label className="filter-item">
            <span>异常条件</span>
            <select value={activeCondition} onChange={(event) => setCondition(event.target.value)}>
              {conditionOptions.map((item) => (
                <option key={item} value={item}>{item}</option>
              ))}
            </select>
          </label>
          <label className="filter-item">
            <span>目标预警规则</span>
            <select value={opsCode} onChange={(event) => setOpsCode(event.target.value)}>
              {opsOptions.map((row) => (
                <option key={String(row['预警编号'])} value={String(row['预警编号'])}>
                  {String(row['预警编号'])}（{String(row['监控指标'])} {String(row['比较方式'])} {String(row['阈值数值'])}）
                </option>
              ))}
            </select>
          </label>
        </div>

        {preview && (
          <div className={`preview-card ${preview.ok && preview.reached ? 'reached' : ''}`}>
            <div className="preview-item">
              <span className="preview-label">告警结论</span>
              <strong>{preview.conclusion}</strong>
            </div>
            <div className="preview-item">
              <span className="preview-label">异常量</span>
              <strong>{preview.volume}</strong>
            </div>
            <div className="preview-item">
              <span className="preview-label">连续周期 / 持续周期</span>
              <strong>{preview.streak} / {preview.requiredPeriods}</strong>
            </div>
            <div className="preview-item">
              <span className="preview-label">建议级别</span>
              <strong>{preview.suggestedLevel || '—'}</strong>
            </div>
          </div>
        )}

        <h4>待升级审计批次（支持批量勾选，一次提交整组）</h4>
        <table className="data-table">
          <thead>
            <tr>
              <th>
                <input
                  type="checkbox"
                  checked={allChecked}
                  onChange={(event) => toggleAll(event.target.checked)}
                  disabled={pendingBatches.length === 0}
                />
              </th>
              <th>批次编号</th>
              <th>审计周期</th>
              <th>规则编号</th>
              <th>异常条件</th>
              <th>异常量</th>
              <th>批次状态</th>
              <th>升级结果</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {batches.map((batch) => {
              const result = results[batch.id]
              return (
                <tr key={batch.id}>
                  <td>
                    <input
                      type="checkbox"
                      checked={checked.includes(batch.id)}
                      disabled={batch.status !== '待升级'}
                      onChange={(event) => toggleBatch(batch.id, event.target.checked)}
                    />
                  </td>
                  <td>{batch.id}</td>
                  <td>{batch.period}</td>
                  <td>{batch.ruleCode}</td>
                  <td>{batch.condition}</td>
                  <td>{batch.volume}</td>
                  <td>{batch.status}{batch.alertCode ? `（${batch.alertCode}）` : ''}</td>
                  <td>
                    {result ? (
                      <span className={result.ok ? 'result-ok' : 'result-fail'}>{result.message}</span>
                    ) : '—'}
                  </td>
                  <td>
                    {batch.status === '待升级' && (
                      <button className="link" type="button" onClick={() => handleIgnore(batch.id)}>
                        忽略
                      </button>
                    )}
                  </td>
                </tr>
              )
            })}
            {batches.length === 0 && (
              <tr>
                <td className="empty-state" colSpan={9}>当前审计规则与异常条件下暂无批次</td>
              </tr>
            )}
          </tbody>
        </table>
        <div className="panel-actions">
          <button className="btn primary" type="button" onClick={submitGroup} disabled={checked.length === 0}>
            提交升级（整组 {checked.length} 条）
          </button>
          {noticeMessage && <span className="notice-text">{noticeMessage}</span>}
        </div>

        <h4>告警列表</h4>
        <table className="data-table">
          <thead>
            <tr>
              <th>告警编号</th>
              <th>审计规则</th>
              <th>审计版本</th>
              <th>异常条件</th>
              <th>触发值</th>
              <th>连续周期</th>
              <th>告警级别</th>
              <th>目标预警</th>
              <th>合并批次</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {alerts.map((alert) => (
              <tr key={alert.code}>
                <td>{alert.code}</td>
                <td>{alert.ruleCode}</td>
                <td>{alert.auditVersion}</td>
                <td>{alert.condition}</td>
                <td>{alert.triggerValue}</td>
                <td>{alert.streak}</td>
                <td>{alert.level}</td>
                <td>{alert.opsCode}</td>
                <td>{alert.mergedBatches.length}</td>
                <td>{alert.status}</td>
                <td className="row-actions">
                  <button className="link" type="button" onClick={() => setDetail(alert)}>升级详情</button>
                  {alert.status === '未结' && (
                    <button className="link" type="button" onClick={() => handleCloseAlert(alert.code)}>结案</button>
                  )}
                </td>
              </tr>
            ))}
            {alerts.length === 0 && (
              <tr>
                <td className="empty-state" colSpan={11}>暂无告警，达到持续周期后自动建立未结告警</td>
              </tr>
            )}
          </tbody>
        </table>

        <h4>升级记录</h4>
        <table className="data-table">
          <thead>
            <tr>
              <th>记录编号</th>
              <th>告警编号</th>
              <th>审计规则</th>
              <th>审计版本</th>
              <th>触发值</th>
              <th>建议级别</th>
              <th>目标预警</th>
              <th>告警结论</th>
              <th>操作人</th>
              <th>时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {records.map((record) => (
              <tr key={record.code}>
                <td>{record.code}</td>
                <td>{record.alertCode}</td>
                <td>{record.ruleCode}</td>
                <td>{record.auditVersion}</td>
                <td>{record.triggerValue}</td>
                <td>{record.suggestedLevel}</td>
                <td>{record.opsCode}</td>
                <td>{record.conclusion}</td>
                <td>{record.operator}</td>
                <td>{record.createdAt}</td>
                <td>
                  <button
                    className="link"
                    type="button"
                    onClick={() => {
                      const alert = findAlert(record.alertCode)
                      if (alert) {
                        setDetail(alert)
                      } else {
                        setErrorMessage(`告警 ${record.alertCode} 不存在`)
                      }
                    }}
                  >
                    升级详情
                  </button>
                </td>
              </tr>
            ))}
            {records.length === 0 && (
              <tr>
                <td className="empty-state" colSpan={11}>暂无升级记录，告警建立时同步写入</td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <footer className="page-foot">
        <span>共 {total} 条运营预警记录</span>
        {errorMessage && <span className="error-text">{errorMessage}</span>}
      </footer>

      {detail && (
        <div className="modal-mask" onClick={() => setDetail(null)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <header className="modal-head">
              <h3>升级详情：{detail.code}（{detail.status}）</h3>
              <button className="btn ghost" type="button" onClick={() => setDetail(null)}>关闭</button>
            </header>
            <div className="detail-grid">
              <section>
                <h4>审计侧（{detail.ruleCode} · 审计版本 {detail.auditVersion}）</h4>
                <dl className="detail-list">
                  <dt>审计对象</dt><dd>{detail.auditSnapshot.审计对象}</dd>
                  <dt>校验字段</dt><dd>{detail.auditSnapshot.校验字段}</dd>
                  <dt>异常条件</dt><dd>{detail.auditSnapshot.异常条件}</dd>
                  <dt>告警级别</dt><dd>{detail.auditSnapshot.告警级别}</dd>
                  <dt>审计频率</dt><dd>{detail.auditSnapshot.审计频率}</dd>
                </dl>
              </section>
              <section>
                <h4>预警侧（{detail.opsCode}）</h4>
                <dl className="detail-list">
                  <dt>监控指标</dt><dd>{detail.opsSnapshot.监控指标}</dd>
                  <dt>比较方式</dt><dd>{detail.opsSnapshot.比较方式}</dd>
                  <dt>阈值数值</dt><dd>{detail.opsSnapshot.阈值数值}</dd>
                  <dt>持续周期</dt><dd>{detail.opsSnapshot.持续周期}</dd>
                  <dt>升级策略</dt><dd>{detail.opsSnapshot.升级策略}</dd>
                </dl>
              </section>
            </div>
            <section>
              <h4>升级信息</h4>
              <dl className="detail-list">
                <dt>触发值</dt><dd>{detail.triggerValue}</dd>
                <dt>连续周期数</dt><dd>{detail.streak}</dd>
                <dt>告警级别</dt><dd>{detail.level}</dd>
                <dt>来源批次</dt><dd>{detail.sourceBatches.join('、') || '—'}</dd>
                <dt>合并批次</dt><dd>{detail.mergedBatches.join('、') || '—'}</dd>
                <dt>建立人</dt><dd>{detail.operator}</dd>
                <dt>建立时间</dt><dd>{detail.createdAt}</dd>
                {detail.closedAt && (<><dt>结案时间</dt><dd>{detail.closedAt}</dd></>)}
              </dl>
            </section>
          </div>
        </div>
      )}
    </section>
  )
}
