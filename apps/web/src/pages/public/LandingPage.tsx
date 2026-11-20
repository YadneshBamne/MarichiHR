import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'
import { APPS, type AppKey } from '../../lib/apps'
import { gsap, reduced } from '../../lib/motion'
import Logo, { Mark } from '../../components/brand/Logo'
import Icon from '../../components/ui/Icon'

// Public product page. The hero is a working shelf: switch an app on and the miniature workspace beside it assembles.
// Everything on the page is something the product does today; the payslip is a labelled sample worked out by the real
// payroll engine (Zambia, K10,000 a month).

// The shelf follows the app list's own order: no app leads
const SHELF: AppKey[] = APPS.map((a) => a.key)
const SHELF_APPS = SHELF.map((k) => APPS.find((a) => a.key === k)!)
const SHORT: Record<AppKey, string> = { payroll: 'Runs, payslips, bank files', leave: 'Balances and approvals', attendance: 'Clock-in and timesheets', expenses: 'Claims and per diems', exits: 'Clearance and settlement' }

const PAYSLIP: { code: string; label: string; amount: number; kind: 'earn' | 'sum' | 'cut' | 'net' }[] = [
  { code: 'BASIC', label: 'Basic salary', amount: 6000, kind: 'earn' },
  { code: 'HOUSING', label: 'Housing allowance', amount: 2500, kind: 'earn' },
  { code: 'TRANSPORT', label: 'Transport allowance', amount: 1500, kind: 'earn' },
  { code: 'GROSS', label: 'Gross pay', amount: 10000, kind: 'sum' },
  { code: 'NAPSA', label: 'NAPSA (employee)', amount: -500, kind: 'cut' },
  { code: 'NHIMA', label: 'NHIMA (employee)', amount: -60, kind: 'cut' },
  { code: 'PAYE', label: 'PAYE', amount: -1326, kind: 'cut' },
  { code: 'NET', label: 'Net pay', amount: 8114, kind: 'net' },
]
const fmt = (n: number) => `${n < 0 ? '−' : ''}${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

// What each installed app adds to the sample workspace's side menu and dashboard
const MENU: Record<AppKey, string[]> = {
  payroll: ['Payroll runs', 'Payslips', 'Salary structures'],
  leave: ['Leave', 'Leave policies'],
  attendance: ['Attendance', 'Shifts & rosters'],
  expenses: ['Expenses'],
  exits: ['Offboarding'],
}
const CORE_MENU = ['Dashboard', 'People', 'Approvals', 'Tasks']

const COUNTRY: Record<'ZM' | 'IN', { name: string; currency: string; rows: [string, string, string?][]; note: string }> = {
  ZM: {
    name: 'Zambia', currency: 'ZMW',
    rows: [
      ['Basic salary', '60% of the monthly wage'], ['Housing allowance', '25% of the monthly wage'], ['Transport allowance', '15% of the monthly wage'],
      ['NAPSA, employee and employer', 'Percentage of gross, up to the yearly ceiling', 'Ceiling to confirm'],
      ['NHIMA, employee and employer', 'Percentage of basic salary'], ['PAYE', 'Progressive bands from the ZRA table'],
    ],
    note: 'Starter structure. Change the split to match your contracts.',
  },
  IN: {
    name: 'India', currency: 'INR',
    rows: [
      ['Basic salary', '50% of the monthly wage'], ['HRA', '50% of basic'], ['Special allowance', 'The rest of the wage'],
      ['EPF, employee and employer', '12% of basic, capped at 1,800'], ['Professional tax', '200 a month (Maharashtra rate: set your state)'],
      ['TDS', 'New regime, worked out cumulatively across the year, no surcharge'],
    ],
    note: 'Starter structure. Kenya and Nigeria starters exist too, with rates marked to confirm.',
  },
}

export default function LandingPage() {
  const { isAuthenticated, isLoading } = useAuth()
  const root = useRef<HTMLDivElement>(null)
  const slip = useRef<HTMLDivElement>(null)
  const [on, setOn] = useState<Set<AppKey>>(new Set<AppKey>(['attendance', 'leave', 'payroll']))
  const [country, setCountry] = useState<'ZM' | 'IN'>('ZM')

  // One entrance: the headline block settles in; everything after that is the shelf responding to you
  useLayoutEffect(() => {
    if (!root.current || reduced()) return
    const ctx = gsap.context(() => {
      gsap.fromTo('[data-hero]', { opacity: 0, y: 18 }, { opacity: 1, y: 0, duration: 0.8, ease: 'power3.out', stagger: 0.07, clearProps: 'opacity,transform' })
      gsap.fromTo('[data-stage]', { opacity: 0, y: 28 }, { opacity: 1, y: 0, duration: 1, ease: 'power3.out', delay: 0.25, clearProps: 'opacity,transform' })
    }, root)
    return () => ctx.revert()
  }, [isAuthenticated])

  useEffect(() => {
    const el = slip.current
    if (!el || reduced() || typeof IntersectionObserver === 'undefined') return
    el.classList.add('pre')
    // never leave the payslip hidden: if the observer does not report within a few seconds, just show it
    const safety = window.setTimeout(() => el.classList.remove('pre'), 6000)
    const io = new IntersectionObserver(([e]) => { if (!e.isIntersecting) return; io.disconnect(); window.clearTimeout(safety); el.classList.remove('pre'); el.classList.add('go') }, { threshold: 0.35 })
    io.observe(el)
    return () => { io.disconnect(); window.clearTimeout(safety) }
  }, [isAuthenticated, isLoading])

  if (isLoading) return null
  if (isAuthenticated) return <Navigate to="/dashboard" replace />

  const toggle = (k: AppKey) => setOn((prev) => { const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); return n })
  const installed = SHELF.filter((k) => on.has(k))

  return (
    <div ref={root} className="canvas lp">
      <header className="lp-head">
        <div className="lp-wrap lp-head-in">
          <Link to="/" aria-label="MarichiHR home"><Logo size={22} /></Link>
          <nav className="desktop-only lp-nav" aria-label="Page sections">
            <a href="#apps">Apps</a><a href="#detail">What each does</a><a href="#payslip">Payroll</a><a href="#roles">Who does what</a><a href="#connect">Connections</a><a href="#security">Security</a>
          </nav>
          <div className="lp-head-act">
            <Link to="/login" className="btn btn-ghost">Sign in</Link>
            <Link to="/signup" className="btn btn-primary">Create a workspace</Link>
          </div>
        </div>
      </header>

      <main>
        {/* ─── Hero: the shelf ─── */}
        <section id="apps" className="lp-wrap lp-hero">
          <div>
            <h1 data-hero className="lp-h1">One workspace for your people, their time and their pay.</h1>
            <p data-hero className="lp-lead">MarichiHR is built as separate apps: attendance, leave, payroll, expenses and exits, on top of people, approvals and tasks. Install the ones you need today and add the rest as you grow.</p>
            <div data-hero className="lp-cta">
              <Link to="/signup" className="btn btn-primary lp-btn-lg">Create a free workspace <Icon name="arrowRight" size={16} /></Link>
              <a href="#detail" className="lp-link">See what each app does</a>
            </div>
            <p data-hero className="muted lp-fine">Add or remove apps at any time. Set up in minutes.</p>
          </div>

          <div data-stage className="lp-stage">
            <div className="card lp-shelf">
              <div className="lp-shelf-head">
                <span className="lp-label">Apps in your workspace</span>
                <span className="muted lp-count">{installed.length} of {SHELF.length} on</span>
              </div>
              <ul className="lp-rows">
                {SHELF_APPS.map((a) => {
                  const isOn = on.has(a.key)
                  return (
                    <li key={a.key}>
                      <button type="button" role="switch" aria-checked={isOn} className="lp-row" onClick={() => toggle(a.key)}>
                        <span className="lp-chip" style={{ background: a.tint }}><Icon name={a.icon} size={18} /></span>
                        <span className="lp-row-text"><strong>{a.name}</strong><span className="dim">{SHORT[a.key]}</span></span>
                        <span className="lp-switch" aria-hidden="true"><span /></span>
                      </button>
                    </li>
                  )
                })}
              </ul>
              <p className="muted lp-hint">Always included: people, approvals, tasks and notifications. Switch them on and off; the workspace follows.</p>
            </div>

            <Workspace on={on} installed={installed} />
          </div>
        </section>

        {/* ─── Each app, from the real feature lists ─── */}
        <section id="detail" className="lp-wrap lp-sec">
          <h2 className="lp-h2">Five apps on a shared core.</h2>
          <p className="lp-lead">Every workspace has people, approvals, tasks and notifications. Each app adds its own screens, rules and approvals, and they hand work to each other.</p>
          <dl className="lp-apps">
            {APPS.map((a) => (
              <div key={a.key}>
                <dt><span className="lp-chip" style={{ background: a.tint }}><Icon name={a.icon} size={18} /></span>{a.name}</dt>
                <dd><span className="dim">{a.tagline}</span>
                  <ul>{a.features.map((f) => <li key={f}>{f}</li>)}</ul>
                </dd>
              </div>
            ))}
          </dl>
        </section>

        {/* ─── The payslip, line by line, per country ─── */}
        <section id="payslip" className="lp-wrap lp-sec">
          <div className="lp-split">
            <div>
              <h2 className="lp-h2">When payroll runs, every line can be checked.</h2>
              <p className="lp-lead">Salary rules are formulas you can read and change. Statutory lines come from a rates table where every rate cites its source, and the ones still waiting for confirmation say so.</p>
              <div className="chips lp-chips" role="group" aria-label="Country">
                {(['ZM', 'IN'] as const).map((c) => (
                  <button key={c} type="button" className={`chip${country === c ? ' is-on' : ''}`} aria-pressed={country === c} onClick={() => setCountry(c)}>{COUNTRY[c].name}</button>
                ))}
              </div>
              <table className="lp-tbl" aria-label={`${COUNTRY[country].name} starter structure`}>
                <thead><tr><th scope="col">Line</th><th scope="col">How it is worked out</th></tr></thead>
                <tbody>
                  {COUNTRY[country].rows.map(([a, b, flag]) => (
                    <tr key={a}><th scope="row">{a}</th><td>{b}{flag && <span className="pill warn lp-flag">{flag}</span>}</td></tr>
                  ))}
                </tbody>
              </table>
              <p className="muted lp-fine">{COUNTRY[country].note}</p>
            </div>

            <div ref={slip} className="card lp-slip">
              <div className="lp-slip-head">
                <span className="lp-label">Sample payslip · Zambia · K10,000 a month</span>
                <span className="pill mute">Worked out by the payroll engine</span>
              </div>
              <dl className="lp-slip-lines">
                {PAYSLIP.map((l, i) => (
                  <div key={l.code} className={`lp-line ${l.kind}`} style={{ '--i': i } as React.CSSProperties}>
                    <dt>{l.label}</dt><dd>{fmt(l.amount)}</dd>
                  </div>
                ))}
              </dl>
              <p className="muted lp-fine">Illustrative figures for one employee. Your numbers follow your contracts and the rates in force.</p>
            </div>
          </div>
        </section>

        {/* ─── Who can do what ─── */}
        <section id="roles" className="lp-wrap lp-sec">
          <h2 className="lp-h2">Everyone sees what they need, and nobody approves their own work.</h2>
          <p className="lp-lead">Leave, attendance and expense approvals go to the person's manager or HR. Every payroll run needs two different Payroll admins, and above an amount you set a System admin signs it off too. Bank details are kept encrypted and verified by a second person.</p>
          <div className="lp-scroll">
            <table className="lp-tbl lp-roles" aria-label="Who can do what">
              <thead><tr><th scope="col">Role</th><th scope="col">Can</th><th scope="col">Cannot</th></tr></thead>
              <tbody>
                <tr><th scope="row">Employee</th><td data-label="Can:">Own profile, leave, attendance, expense claims, own payslips</td><td data-label="Cannot:">See anyone else's records or pay</td></tr>
                <tr><th scope="row">Manager</th><td data-label="Can:">Approve the team's leave, attendance and expenses; nominate incentives</td><td data-label="Cannot:">See anyone's pay</td></tr>
                <tr><th scope="row">HR admin</th><td data-label="Can:">People, leave and attendance rules, policies, audit log; add bank details</td><td data-label="Cannot:">See salaries, contracts, payslips or run payroll</td></tr>
                <tr><th scope="row">Payroll admin</th><td data-label="Can:">Salary structures, run payroll, first or second approval, disburse, bank file and journal</td><td data-label="Cannot:">Give both approvals on the same run</td></tr>
                <tr><th scope="row">System admin</th><td data-label="Can:">Company settings, apps, logins and roles, sign off large runs</td><td data-label="Cannot:">See individual pay</td></tr>
              </tbody>
            </table>
          </div>
        </section>

        {/* ─── Connections ─── */}
        <section id="connect" className="lp-wrap lp-sec">
          <h2 className="lp-h2">Connects to your bank, your books and your systems.</h2>
          <dl className="lp-defs">
            <div><dt>Bank files</dt><dd>Generic CSV, semicolon and fixed-width layouts, and ISO 20022 XML. Union Bank of India is built in; FNB Zambia and NIBSS layouts are marked to confirm with the bank. Other banks are added from your bank's own template.</dd></div>
            <div><dt>Accounting export</dt><dd>One balanced journal per run in JSON, CSV, XML, QuickBooks, Xero or Tally layout, with your own ledger accounts, split by department or legal entity. It can also be pushed to your ERP as a signed webhook.</dd></div>
            <div><dt>Webhooks and API keys</dt><dd>Signed outbound events for payslips, approvals and more. Scoped API keys read people, leave and attendance, with a rate limit and a write API for imports.</dd></div>
            <div><dt>ZRA Smart Invoice</dt><dd>In test mode today and switched on per company on request: approved Zambian expense claims are recorded as purchases through DigiTax, with the supplier's TPIN. Per diems are never sent.</dd></div>
            <div><dt>Statutory returns</dt><dd>A filing dashboard prepares and tracks PAYE, NAPSA and NHIMA returns and keeps the reference. Submission itself happens on the authority's portal.</dd></div>
            <div><dt>Imports and reports</dt><dd>Bring in people, bank details, contracts and leave balances from a spreadsheet, and build and save your own reports on the data you already have.</dd></div>
            <div><dt>Documents</dt><dd>Employee documents are stored with the workspace, with reminders 30 days, 7 days and on the day an ID or contract document expires.</dd></div>
            <div><dt>Notifications</dt><dd>The in-app bell and email, set per person and per category. Pay and policy notices are always delivered.</dd></div>
          </dl>
        </section>

        {/* ─── The rest of the workspace ─── */}
        <section className="lp-wrap lp-sec">
          <h2 className="lp-h2">And everything else in the workspace.</h2>
          <ul className="lp-more">
            {([
              ['People and org chart', 'Employee record with your own fields, documents with expiry reminders, position history.'],
              ['Approvals and tasks', 'One inbox for leave, corrections, expenses and sign-offs, with response targets.'],
              ['Incentives and pay review', 'Schemes, budgets and ratings feeding variable pay, and review budgets per manager.'],
              ['Policies and grievances', 'Publish, collect acceptance, take questions; confidential case numbers for grievances.'],
              ['Community', 'Spaces, polls, kudos and company news in one place.'],
              ['Reports and audit', 'A report builder, payroll cost and consolidated reports, and a full audit log.'],
              ['Automation', 'Rules from triggers and conditions to notifications and tasks, with a dry run and a run log.'],
              ['Many entities, many currencies', 'Legal entities and pay groups, each with its own run and currency.'],
            ] as [string, string][]).map(([t, b]) => (
              <li key={t}><strong>{t}</strong><span className="dim">{b}</span></li>
            ))}
          </ul>
        </section>

        {/* ─── Security ─── */}
        <section id="security" className="lp-wrap lp-sec">
          <div className="card lp-sec-card">
            <div>
              <h2 className="lp-h2">Built for sensitive data.</h2>
              <p className="lp-lead">Salaries, bank details and personal records are treated carefully from the first day.</p>
            </div>
            <ul className="lp-facts">
              <li><Icon name="lock" size={17} />Two-factor sign-in with an authenticator app</li>
              <li><Icon name="key" size={17} />Bank details encrypted; only the last four digits are ever shown</li>
              <li><Icon name="shield" size={17} />Role-based access enforced on the server</li>
              <li><Icon name="audit" size={17} />Audit log of changes and sign-ins</li>
              <li><Icon name="checkCircle" size={17} />Maker-checker on payroll, bank details and inputs</li>
              <li><Icon name="layers" size={17} />Each company's data is kept separate</li>
            </ul>
          </div>
        </section>

        {/* ─── Close ─── */}
        <section className="lp-wrap lp-sec lp-last">
          <div className="card card-night lp-close">
            <Mark size={38} />
            <h2 className="lp-h2">Create your workspace and pick your apps.</h2>
            <p>Add your company, choose your apps, invite your team.</p>
            <Link to="/signup" className="btn btn-honey lp-btn-lg">Create a free workspace <Icon name="arrowRight" size={16} /></Link>
          </div>
        </section>
      </main>

      <footer className="lp-foot">
        <div className="lp-wrap lp-foot-in muted">
          <Logo size={18} /><span>© {new Date().getFullYear()} Marichi Labs</span>
          <span className="lp-foot-links"><Link to="/login">Sign in</Link><Link to="/signup">Create a workspace</Link></span>
        </div>
      </footer>
    </div>
  )
}

// The miniature workspace beside the shelf: its side menu and dashboard are built from what is switched on
function Workspace({ on, installed }: { on: Set<AppKey>; installed: AppKey[] }) {
  const payroll = on.has('payroll')
  return (
    <div className="lp-win" role="group" aria-label="Sample workspace">
      <span className="sr-only" aria-live="polite">Workspace with {installed.length ? installed.map((k) => APPS.find((a) => a.key === k)!.name).join(', ') : 'no apps'} installed.</span>
      <div className="lp-win-bar" aria-hidden="true"><i /><i /><i /><span>Your company · sample data</span></div>
      <div className="lp-win-body">
        <ul className="lp-side" aria-hidden="true">
          {CORE_MENU.map((m, i) => <li key={m} className={i === 0 ? 'is-on' : ''}>{m}</li>)}
          {SHELF.filter((k) => on.has(k)).map((k) => (
            <li key={k} className="lp-in lp-side-group">
              {MENU[k].map((m) => <span key={m}>{m}</span>)}
            </li>
          ))}
        </ul>
        <div className="lp-main" aria-hidden="true">
          <div className="lp-main-title">Dashboard</div>
          <div className="lp-tiles">
            {on.has('payroll') && <div key="pay" className="lp-in lp-tile lp-tile-wide"><span>Payroll · November</span><b>ZMW {fmt(8114)} net, one employee</b><em>Run, first approval done · second approval next</em></div>}
            {on.has('attendance') && <div key="att" className="lp-in lp-tile"><span>Attendance</span><b>14 of 16 in today</b><em>1 correction waiting</em></div>}
            {on.has('leave') && <div key="leave" className="lp-in lp-tile"><span>Leave</span><b>18 days available</b><em>2 requests waiting</em></div>}
            {on.has('expenses') && <div key="exp" className="lp-in lp-tile"><span>Expenses</span><b>3 claims waiting</b><em>{payroll ? 'Paid with the next payslip' : 'Install payroll to pay through it'}</em></div>}
            {on.has('exits') && <div key="exit" className="lp-in lp-tile"><span>Offboarding</span><b>1 clearance open</b><em>Final settlement follows</em></div>}
            {installed.length === 0 && <div key="none" className="lp-in lp-empty">No apps installed yet. People, approvals and tasks are always here; switch an app on to add it.</div>}
          </div>
        </div>
      </div>
    </div>
  )
}
