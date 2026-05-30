import { useEffect, useState } from 'react'
import './App.css'
import type {
  DashboardData,
  DashboardSnapshot,
  DatabaseCourseRow,
  DatabasePersonRow,
  WeeklyMetrics,
} from './lib/dashboard-data'

type DatabaseTab = 'webinar' | 'bundle' | 'course'

type DatabaseFilters = {
  quick: string
  name: string
  email: string
  phone: string
  date: string
  month: string
  year: string
  amountMin: string
  amountMax: string
}

const DEFAULT_FILTERS: DatabaseFilters = {
  quick: '',
  name: '',
  email: '',
  phone: '',
  date: '',
  month: '',
  year: '',
  amountMin: '',
  amountMax: '',
}

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

function normalizeSearch(value: string) {
  return value.trim().toLowerCase()
}

function includesSearch(value: string, query: string) {
  return normalizeSearch(value).includes(normalizeSearch(query))
}

function getDateParts(date: string) {
  const [day, month, year] = date.split('-')
  return { day, month, year }
}

function filterDatabaseRows<T extends DatabasePersonRow | DatabaseCourseRow>(
  rows: T[],
  filters: DatabaseFilters,
  includeAmount: boolean,
) {
  const amountMin = Number(filters.amountMin)
  const amountMax = Number(filters.amountMax)
  const hasAmountMin = filters.amountMin.trim() !== '' && !Number.isNaN(amountMin)
  const hasAmountMax = filters.amountMax.trim() !== '' && !Number.isNaN(amountMax)

  return rows.filter((row) => {
    const quickHaystack = [row.name, row.email, row.phone, row.date, 'amount' in row ? String(row.amount) : '']
      .join(' ')
      .toLowerCase()
    const { month, year } = getDateParts(row.date)

    if (filters.quick && !quickHaystack.includes(normalizeSearch(filters.quick))) return false
    if (filters.name && !includesSearch(row.name, filters.name)) return false
    if (filters.email && !includesSearch(row.email, filters.email)) return false
    if (filters.phone && !includesSearch(row.phone, filters.phone)) return false
    if (filters.date && !includesSearch(row.date, filters.date)) return false
    if (filters.month && month !== filters.month) return false
    if (filters.year && year !== filters.year) return false

    if (includeAmount && 'amount' in row) {
      if (hasAmountMin && row.amount < amountMin) return false
      if (hasAmountMax && row.amount > amountMax) return false
    }

    return true
  })
}

function asCourseRow(row: DatabasePersonRow | DatabaseCourseRow) {
  return row as DatabaseCourseRow
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
  const [databaseTab, setDatabaseTab] = useState<DatabaseTab>('webinar')
  const [filters, setFilters] = useState<DatabaseFilters>(DEFAULT_FILTERS)

  useEffect(() => {
    let active = true

    fetch(`${import.meta.env.BASE_URL}dashboard-data.json?v=2026-05-30-7`, {
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
  const database = snapshot.database
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
  const activeRows =
    databaseTab === 'webinar'
      ? filterDatabaseRows(database.webinarOnly, filters, false)
      : databaseTab === 'bundle'
        ? filterDatabaseRows(database.bundleBuyers, filters, false)
        : filterDatabaseRows(database.courseBuyers, filters, true)
  const yearOptions = Array.from(
    new Set(
      [...database.webinarOnly, ...database.bundleBuyers, ...database.courseBuyers].map(
        (row) => getDateParts(row.date).year,
      ),
    ),
  ).sort((left, right) => right.localeCompare(left))

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

          <section className="glass-card section-card">
            <div className="card-head">
              <div>
                <p className="section-label">Report database</p>
                <h2>Searchable people lists</h2>
              </div>
              <div className="database-count">
                <span>Visible rows</span>
                <strong>{activeRows.length}</strong>
              </div>
            </div>

            <div className="database-tabs" role="tablist" aria-label="Database lists">
              <button
                className={`database-tab ${databaseTab === 'webinar' ? 'active' : ''}`}
                onClick={() => {
                  setDatabaseTab('webinar')
                  setFilters(DEFAULT_FILTERS)
                }}
              >
                Webinar Only
              </button>
              <button
                className={`database-tab ${databaseTab === 'bundle' ? 'active' : ''}`}
                onClick={() => {
                  setDatabaseTab('bundle')
                  setFilters(DEFAULT_FILTERS)
                }}
              >
                Bundle Buyers
              </button>
              <button
                className={`database-tab ${databaseTab === 'course' ? 'active' : ''}`}
                onClick={() => {
                  setDatabaseTab('course')
                  setFilters(DEFAULT_FILTERS)
                }}
              >
                Course Buyers
              </button>
            </div>

            <div className="filter-grid">
              <label className="filter-field">
                <span>Quick search</span>
                <input
                  value={filters.quick}
                  onChange={(event) => setFilters((current) => ({ ...current, quick: event.target.value }))}
                  placeholder="Name, email, phone, date"
                />
              </label>
              <label className="filter-field">
                <span>Name</span>
                <input
                  value={filters.name}
                  onChange={(event) => setFilters((current) => ({ ...current, name: event.target.value }))}
                  placeholder="Filter by name"
                />
              </label>
              <label className="filter-field">
                <span>Email</span>
                <input
                  value={filters.email}
                  onChange={(event) => setFilters((current) => ({ ...current, email: event.target.value }))}
                  placeholder="Filter by email"
                />
              </label>
              <label className="filter-field">
                <span>Phone</span>
                <input
                  value={filters.phone}
                  onChange={(event) => setFilters((current) => ({ ...current, phone: event.target.value }))}
                  placeholder="Filter by phone"
                />
              </label>
              <label className="filter-field">
                <span>Date</span>
                <input
                  value={filters.date}
                  onChange={(event) => setFilters((current) => ({ ...current, date: event.target.value }))}
                  placeholder="dd-mm-yyyy"
                />
              </label>
              <label className="filter-field">
                <span>Month</span>
                <select
                  value={filters.month}
                  onChange={(event) => setFilters((current) => ({ ...current, month: event.target.value }))}
                >
                  <option value="">All months</option>
                  <option value="01">January</option>
                  <option value="02">February</option>
                  <option value="03">March</option>
                  <option value="04">April</option>
                  <option value="05">May</option>
                  <option value="06">June</option>
                  <option value="07">July</option>
                  <option value="08">August</option>
                  <option value="09">September</option>
                  <option value="10">October</option>
                  <option value="11">November</option>
                  <option value="12">December</option>
                </select>
              </label>
              <label className="filter-field">
                <span>Year</span>
                <select
                  value={filters.year}
                  onChange={(event) => setFilters((current) => ({ ...current, year: event.target.value }))}
                >
                  <option value="">All years</option>
                  {yearOptions.map((year) => (
                    <option key={year} value={year}>
                      {year}
                    </option>
                  ))}
                </select>
              </label>
              {databaseTab === 'course' ? (
                <>
                  <label className="filter-field">
                    <span>Min amount</span>
                    <input
                      value={filters.amountMin}
                      onChange={(event) =>
                        setFilters((current) => ({ ...current, amountMin: event.target.value }))
                      }
                      placeholder="1500"
                    />
                  </label>
                  <label className="filter-field">
                    <span>Max amount</span>
                    <input
                      value={filters.amountMax}
                      onChange={(event) =>
                        setFilters((current) => ({ ...current, amountMax: event.target.value }))
                      }
                      placeholder="2500"
                    />
                  </label>
                </>
              ) : null}
            </div>

            {activeRows.length === 0 ? (
              <p className="empty-state">No people match the current filters.</p>
            ) : (
              <div className="database-table-wrap">
                <table className="database-table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Phone</th>
                      <th>Email</th>
                      {databaseTab === 'course' ? <th>Amount</th> : null}
                      <th>Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activeRows.map((row) => (
                      <tr key={`${databaseTab}-${row.createdAt}-${row.phone}-${row.email}-${row.name}`}>
                        <td>{row.name || '—'}</td>
                        <td>{row.phone || '—'}</td>
                        <td>{row.email || '—'}</td>
                        {databaseTab === 'course' ? <td>{asCourseRow(row).amount.toLocaleString('en-IN')}</td> : null}
                        <td>{row.date}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
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
