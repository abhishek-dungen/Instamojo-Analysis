import { useEffect, useState } from 'react'
import './App.css'
import type { DashboardData, WeeklyMetrics } from './lib/dashboard-data'

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

function App() {
  const [data, setData] = useState<DashboardData | null>(null)
  const [selectedWeek, setSelectedWeek] = useState('')

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
          <h1>Loading dashboard.</h1>
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

  const selected = data.weekly.find((entry) => entry.webinarDate === selectedWeek) ?? data.weekly[0]

  return (
    <main className="shell">
      <section className="control-panel">
        <div>
          <p className="section-label">Webinar week</p>
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
          <span>Last hourly sync</span>
          <strong>{new Date(data.generatedAt).toLocaleString('en-IN', { timeZone: data.timezone })}</strong>
        </div>
      </section>

      <section className="metrics-grid">
        <article className="metric-card">
          <span>Webinar registrations</span>
          <strong>{selected.registrations}</strong>
          <p>{selected.webinarOnlyRegistrations} direct + {selected.comboRegistrations} combo</p>
        </article>
        <article className="metric-card">
          <span>Bundle registrations</span>
          <strong>{selected.bundleRegistrations}</strong>
          <p>{selected.bundleOnlyRegistrations} direct + {selected.comboRegistrations} combo</p>
        </article>
        <article className="metric-card">
          <span>Course purchases</span>
          <strong>{selected.coursePurchasesLive + selected.coursePurchasesExtended}</strong>
          <p>
            {selected.coursePurchasesLive} live + {selected.coursePurchasesExtended} extension
          </p>
        </article>
        <article className="metric-card">
          <span>Total revenue</span>
          <strong>{formatMoney(selected.totalRevenue)}</strong>
          <p>{formatMoney(selected.registrationRevenue)} from registration-linked payments</p>
        </article>
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
    </main>
  )
}

export default App
