import { useEffect, useState } from 'react'
import './App.css'
import type { DashboardData, DashboardSnapshot, WeeklyMetrics } from './lib/dashboard-data'

function getDefaultWeek(weeks: WeeklyMetrics[]) {
  if (weeks.length === 0) return ''

  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())

  return weeks.find((entry) => entry.webinarDate <= today)?.webinarDate ?? weeks[0].webinarDate
}

function formatPercent(value: number) {
  return `${value.toFixed(1)}%`
}

function hasVisibleData(data: DashboardData) {
  return data.source.paymentCount > 0 || data.weekly.length > 0
}

function getWeekPlaceholder(data: DashboardData) {
  if (!hasVisibleData(data)) {
    if (data.syncStatus.state === 'pending') return `${data.label} history sync in progress`
    if (data.syncStatus.state === 'error') return `${data.label} sync unavailable`
  }

  if (data.syncStatus.state === 'pending') return `${data.label} backfill in progress`
  if (data.syncStatus.state === 'error') return `${data.label} sync unavailable`
  return 'No valid weeks'
}

function getStatusHeadline(data: DashboardData) {
  if (data.syncStatus.state === 'pending') {
    return hasVisibleData(data)
      ? `${data.label} recent data is available`
      : `${data.label} sync in progress`
  }
  return `${data.label} sync unavailable`
}

function App() {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null)
  const [error, setError] = useState('')
  const [selectedWeek, setSelectedWeek] = useState('')

  useEffect(() => {
    let active = true

    fetch(`${import.meta.env.BASE_URL}dashboard-data.json?v=2026-05-30-6`, {
      cache: 'no-store',
    })
      .then((response) => {
        if (!response.ok) {
          throw new Error('Unable to load dashboard data.')
        }

        return response.json() as Promise<DashboardSnapshot>
      })
      .then((payload) => {
        if (!active) return
        setSnapshot(payload)
        setError('')
      })
      .catch((loadError) => {
        console.error(loadError)
        if (!active) return
        setError('Unable to load dashboard data right now.')
      })

    return () => {
      active = false
    }
  }, [])

  if (!snapshot) {
    return (
      <main className="shell">
        <section className="loading-panel">
          <p className="eyebrow">Payment Gateway Analysis</p>
          <h1>{error || 'Loading dashboard.'}</h1>
        </section>
      </main>
    )
  }

  const data: DashboardData = snapshot.gateways.combined
  const activeWeek = selectedWeek || getDefaultWeek(data.weekly)
  const selected = data.weekly.find((entry) => entry.webinarDate === activeWeek) ?? data.weekly[0] ?? null
  const selectedCoursePurchases = selected
    ? selected.coursePurchasesLive + selected.coursePurchasesExtended
    : 0
  const selectedBundleConversion =
    selected && selected.registrations !== 0
      ? (selected.bundleRegistrations / selected.registrations) * 100
      : 0
  const selectedCourseConversion =
    selected && selected.registrations !== 0 ? (selectedCoursePurchases / selected.registrations) * 100 : 0

  return (
    <main className="shell">
      <section className="control-panel">
        <div className="selector-row">
          <div>
            <p className="section-label">Webinar week</p>
            <select
              className="week-select"
              value={selected?.webinarDate ?? ''}
              onChange={(event) => setSelectedWeek(event.target.value)}
              disabled={data.weekly.length === 0}
            >
              {data.weekly.length === 0 ? (
                <option value="">{getWeekPlaceholder(data)}</option>
              ) : (
                data.weekly.map((entry) => (
                  <option key={entry.webinarDate} value={entry.webinarDate}>
                    {entry.label}
                  </option>
                ))
              )}
            </select>
          </div>
        </div>

        <div className="freshness">
          <span>Unified hourly sync</span>
          <strong>{new Date(data.generatedAt).toLocaleString('en-IN', { timeZone: data.timezone })}</strong>
        </div>
      </section>

      {data.syncStatus.state !== 'ready' ? (
        <section className="glass-card section-card">
          <p className="section-label">{data.label}</p>
          <h2>{getStatusHeadline(data)}</h2>
          <p className="status-copy">{data.syncStatus.message}</p>
        </section>
      ) : null}

      {selected ? (
        <>
          <section className="glass-card section-card">
            <p className="section-label">Selected week</p>
            <h2>{selected.label}</h2>
            <div className="metrics-grid">
              <article className="metric-card">
                <span>Webinar registrations</span>
                <strong>{selected.registrations}</strong>
                <p>
                  {selected.webinarOnlyRegistrations} direct + {selected.comboRegistrations} combo
                </p>
              </article>
              <article className="metric-card">
                <span>Bundle registrations</span>
                <strong>{selected.bundleRegistrations}</strong>
                <p>
                  {selected.bundleOnlyRegistrations} direct + {selected.comboRegistrations} combo
                </p>
              </article>
              <article className="metric-card">
                <span>Course purchases</span>
                <strong>{selectedCoursePurchases}</strong>
                <p>
                  {selected.coursePurchasesLive} live + {selected.coursePurchasesExtended} extension
                </p>
              </article>
              <article className="metric-card">
                <span>Bundle conversion</span>
                <strong>{formatPercent(selectedBundleConversion)}</strong>
                <p>Bundle registrations against webinar registrations</p>
              </article>
              <article className="metric-card">
                <span>Course conversion</span>
                <strong>{formatPercent(selectedCourseConversion)}</strong>
                <p>Course purchases against webinar registrations</p>
              </article>
            </div>
          </section>

          <section className="glass-card section-card">
            <p className="section-label">Historical valid weeks</p>
            <h2>All-time summary after exclusions</h2>
            <div className="metrics-grid">
              <article className="metric-card">
                <span>Webinar registrations</span>
                <strong>{data.historicalSummary.webinarRegistrations}</strong>
              </article>
              <article className="metric-card">
                <span>Webinars considered</span>
                <strong>{data.historicalSummary.webinarWeeksCount}</strong>
              </article>
              <article className="metric-card">
                <span>Bundle registrations</span>
                <strong>{data.historicalSummary.bundleRegistrations}</strong>
              </article>
              <article className="metric-card">
                <span>Course purchases</span>
                <strong>{data.historicalSummary.coursePurchases}</strong>
              </article>
              <article className="metric-card">
                <span>Bundle conversion</span>
                <strong>{formatPercent(data.historicalSummary.bundleConversionRate)}</strong>
              </article>
              <article className="metric-card">
                <span>Course conversion</span>
                <strong>{formatPercent(data.historicalSummary.courseConversionRate)}</strong>
              </article>
            </div>
          </section>

          <section className="info-grid">
            <article className="glass-card">
              <p className="section-label">Classification used</p>
              <h2>Purpose names currently counted</h2>
              <div className="rule-group">
                <h3>Webinar registration</h3>
                {data.classificationSources.webinar.map((item) => (
                  <div key={`webinar-${item.purpose}`} className="rule-row">
                    <strong>{item.purpose}</strong>
                    <span>{item.count} successful payments</span>
                  </div>
                ))}
              </div>
              <div className="rule-group">
                <h3>Bundle registration</h3>
                {data.classificationSources.bundle.map((item) => (
                  <div key={`bundle-${item.purpose}`} className="rule-row">
                    <strong>{item.purpose}</strong>
                    <span>{item.count} successful payments</span>
                  </div>
                ))}
              </div>
              <div className="rule-group">
                <h3>Course registration</h3>
                {data.classificationSources.course.map((item) => (
                  <div key={`course-${item.purpose}`} className="rule-row">
                    <strong>{item.purpose}</strong>
                    <span>{item.count} successful payments</span>
                  </div>
                ))}
              </div>
            </article>
          </section>
        </>
      ) : (
        data.syncStatus.state === 'ready' ? (
          <section className="glass-card section-card">
            <p className="section-label">{data.label}</p>
            <h2>No valid webinar weeks after exclusions</h2>
          </section>
        ) : null
      )}
    </main>
  )
}

export default App
