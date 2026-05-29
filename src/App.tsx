import { useDeferredValue, useEffect, useState } from 'react'
import './App.css'

type WeeklyMetrics = {
  webinarDate: string
  label: string
  registrationWindow: string
  registrations: number
  webinarOnlyRegistrations: number
  comboRegistrations: number
  bundleRegistrations: number
  bundleOnlyRegistrations: number
  coursePurchasesLive: number
  coursePurchasesExtended: number
  courseRevenueLive: number
  courseRevenueExtended: number
  registrationRevenue: number
  totalRevenue: number
  topCoursePurposes: Array<{ purpose: string; count: number; revenue: number }>
  recentPayments: Array<{
    paymentId: string
    localCreatedAt: string
    amount: number
    purpose: string
    classification: string
    buyerName: string
  }>
}

type DashboardData = {
  generatedAt: string
  timezone: string
  source: {
    paymentRequestCount: number
    paymentCount: number
    successfulPaymentCount: number
  }
  totals: {
    registrations: number
    bundleRegistrations: number
    coursePurchases: number
    totalRevenue: number
  }
  weekly: WeeklyMetrics[]
}

const currency = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
})

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

function formatMoney(value: number) {
  return currency.format(value)
}

function ratio(value: number, max: number) {
  if (max <= 0) return '0%'
  return `${Math.max(8, Math.round((value / max) * 100))}%`
}

function App() {
  const [data, setData] = useState<DashboardData | null>(null)
  const [selectedWeek, setSelectedWeek] = useState('')
  const deferredWeek = useDeferredValue(selectedWeek)

  useEffect(() => {
    let active = true

    fetch(`${import.meta.env.BASE_URL}dashboard-data.json`)
      .then((response) => {
        if (!response.ok) {
          throw new Error('Unable to load dashboard data.')
        }

        return response.json() as Promise<DashboardData>
      })
      .then((payload) => {
        if (!active) return
        setData(payload)
        setSelectedWeek(getDefaultWeek(payload.weekly))
      })
      .catch((error) => {
        console.error(error)
      })

    return () => {
      active = false
    }
  }, [])

  if (!data) {
    return (
      <main className="shell">
        <section className="loading-panel">
          <p className="eyebrow">Instamojo Analysis</p>
          <h1>Loading the weekly command center.</h1>
        </section>
      </main>
    )
  }

  if (data.weekly.length === 0) {
    return (
      <main className="shell">
        <section className="loading-panel">
          <p className="eyebrow">Instamojo Analysis</p>
          <h1>No synced payments yet.</h1>
        </section>
      </main>
    )
  }

  const selected =
    data.weekly.find((entry) => entry.webinarDate === deferredWeek) ?? data.weekly[0]

  const maxRegistration = Math.max(...data.weekly.map((entry) => entry.registrations), 1)
  const maxRevenue = Math.max(...data.weekly.map((entry) => entry.totalRevenue), 1)

  return (
    <main className="shell">
      <section className="hero-panel">
        <div className="hero-copy">
          <p className="eyebrow">Instamojo Analysis</p>
          <h1>Weekly webinar revenue, registrations, bundles, and course conversions.</h1>
          <p className="lede">
            Each webinar week closes at Sunday 6:30 PM IST for registrations. Course sales are
            split into live webinar conversions and post-webinar extensions.
          </p>
        </div>

        <div className="hero-meta">
          <div className="hero-stat">
            <span>Total registrations</span>
            <strong>{data.totals.registrations}</strong>
          </div>
          <div className="hero-stat">
            <span>Total bundle buyers</span>
            <strong>{data.totals.bundleRegistrations}</strong>
          </div>
          <div className="hero-stat">
            <span>Total revenue</span>
            <strong>{formatMoney(data.totals.totalRevenue)}</strong>
          </div>
          <div className="hero-stat">
            <span>Successful payments synced</span>
            <strong>{data.source.successfulPaymentCount}</strong>
          </div>
        </div>
      </section>

      <section className="control-panel">
        <div>
          <p className="section-label">Select webinar week</p>
          <select
            className="week-select"
            value={selected.webinarDate}
            onChange={(event) => setSelectedWeek(event.target.value)}
          >
            {data.weekly.map((entry) => (
              <option key={entry.webinarDate} value={entry.webinarDate}>
                {entry.label}
              </option>
            ))}
          </select>
        </div>
        <div className="freshness">
          <span>Snapshot updated</span>
          <strong>{new Date(data.generatedAt).toLocaleString('en-IN', { timeZone: data.timezone })}</strong>
        </div>
      </section>

      <section className="metrics-grid">
        <article className="metric-card">
          <span>Webinar registrations</span>
          <strong>{selected.registrations}</strong>
          <p>
            {selected.webinarOnlyRegistrations} webinar-only + {selected.comboRegistrations} combo
          </p>
        </article>
        <article className="metric-card">
          <span>Bundle registrations</span>
          <strong>{selected.bundleRegistrations}</strong>
          <p>
            {selected.bundleOnlyRegistrations} bundle-only + {selected.comboRegistrations} combo
          </p>
        </article>
        <article className="metric-card">
          <span>Live course sales</span>
          <strong>{selected.coursePurchasesLive}</strong>
          <p>{formatMoney(selected.courseRevenueLive)} during Sunday 7 PM to 12 AM</p>
        </article>
        <article className="metric-card">
          <span>Extension course sales</span>
          <strong>{selected.coursePurchasesExtended}</strong>
          <p>{formatMoney(selected.courseRevenueExtended)} after the live window</p>
        </article>
      </section>

      <section className="insight-layout">
        <article className="glass-card">
          <div className="card-head">
            <div>
              <p className="section-label">Weekly snapshot</p>
              <h2>{selected.label}</h2>
            </div>
            <p className="window-note">
              {selected.registrationWindow}
              <br />
              Source records: {data.source.paymentRequestCount} requests, {data.source.paymentCount}{' '}
              payments
            </p>
          </div>

          <div className="money-band">
            <div>
              <span>Registration revenue</span>
              <strong>{formatMoney(selected.registrationRevenue)}</strong>
            </div>
            <div>
              <span>Total revenue</span>
              <strong>{formatMoney(selected.totalRevenue)}</strong>
            </div>
          </div>

          <div className="course-list">
            <div className="course-list-head">
              <p className="section-label">Top course intents</p>
              <span>{selected.topCoursePurposes.length} purposes</span>
            </div>
            {selected.topCoursePurposes.length === 0 ? (
              <p className="empty-state">No course payments were attributed to this webinar yet.</p>
            ) : (
              selected.topCoursePurposes.map((purpose) => (
                <div key={purpose.purpose} className="course-row">
                  <div>
                    <strong>{purpose.purpose}</strong>
                    <span>{purpose.count} purchases</span>
                  </div>
                  <em>{formatMoney(purpose.revenue)}</em>
                </div>
              ))
            )}
          </div>
        </article>

        <article className="glass-card">
          <div className="card-head">
            <div>
              <p className="section-label">Trendline</p>
              <h2>Recent webinar weeks</h2>
            </div>
          </div>
          <div className="bars">
            {data.weekly.slice(0, 8).map((entry) => (
              <button
                key={entry.webinarDate}
                type="button"
                className={`bar-row ${entry.webinarDate === selected.webinarDate ? 'active' : ''}`}
                onClick={() => setSelectedWeek(entry.webinarDate)}
              >
                <div>
                  <strong>{entry.label}</strong>
                  <span>{entry.registrations} registrations</span>
                </div>
                <div className="bar-stack">
                  <div className="bar-fill registration" style={{ width: ratio(entry.registrations, maxRegistration) }} />
                  <div className="bar-fill revenue" style={{ width: ratio(entry.totalRevenue, maxRevenue) }} />
                </div>
                <em>{formatMoney(entry.totalRevenue)}</em>
              </button>
            ))}
          </div>
        </article>
      </section>

      <section className="glass-card">
        <div className="card-head">
          <div>
            <p className="section-label">Recent payments</p>
            <h2>What fed this week</h2>
          </div>
        </div>
        <div className="payment-table">
          {selected.recentPayments.length === 0 ? (
            <p className="empty-state">No successful payments available for this week.</p>
          ) : (
            selected.recentPayments.map((payment) => (
              <div key={payment.paymentId} className="payment-row">
                <div>
                  <strong>{payment.purpose}</strong>
                  <span>{payment.buyerName || 'Unknown buyer'}</span>
                </div>
                <div>
                  <strong>{formatMoney(payment.amount)}</strong>
                  <span>{payment.classification.replaceAll('_', ' ')}</span>
                </div>
                <time>{payment.localCreatedAt}</time>
              </div>
            ))
          )}
        </div>
      </section>
    </main>
  )
}

export default App
