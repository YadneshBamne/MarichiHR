import { Link, Navigate } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'
import { APPS, type AppKey } from '../../lib/apps'
import Logo from '../../components/brand/Logo'

// Public product page. Scroll motion is CSS scroll-driven animation only (no library) and only where the browser supports it;
// everywhere else, and under reduced motion, the finished layout is shown. Nothing here is a customer claim: the payslip is a
// labelled sample worked out by the real payroll engine, and the conversation is a labelled sample.

// One short imperative line per app, shown big on its panel
const SAY: Record<AppKey, string> = { attendance: 'Clock in.', leave: 'Take leave.', payroll: 'Get paid.', expenses: 'Claim it back.', exits: 'Leave well.' }

const STEPS: [string, string][] = [
  ['Draft', 'Create the cycle for the month and pick who it covers.'],
  ['Lock attendance', 'The period becomes read-only so pay cannot drift.'],
  ['Run payroll', 'Salary rules and statutory tables are worked out for everyone with a running contract.'],
  ['First approval', 'A Payroll admin reviews the warnings and approves.'],
  ['Second approval', 'A different Payroll admin must approve too.'],
  ['Disburse', 'The run is locked for good and payslips are released.'],
]

const PAYSLIP: { label: string; amount: number; kind?: 'sum' | 'cut' | 'net' }[] = [
  { label: 'Basic salary', amount: 6000 }, { label: 'Housing allowance', amount: 2500 }, { label: 'Transport allowance', amount: 1500 },
  { label: 'Gross pay', amount: 10000, kind: 'sum' }, { label: 'NAPSA (employee)', amount: -500, kind: 'cut' },
  { label: 'NHIMA (employee)', amount: -60, kind: 'cut' }, { label: 'PAYE', amount: -1326, kind: 'cut' }, { label: 'Net pay', amount: 8114, kind: 'net' },
]
const fmt = (n: number) => `${n < 0 ? '−' : ''}${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const ALSO = ['People and org chart', 'Documents with expiry reminders', 'Approvals and tasks', 'Incentives and pay review', 'Policies and acceptance', 'Grievances', 'Community and kudos', 'Reports and audit log', 'Automation rules', 'Webhooks and API keys', 'Accounting export', 'Bank files', 'Legal entities and currencies']

const CHAT: { who: 'sys' | 'a' | 'b'; text: string }[] = [
  { who: 'sys', text: 'November run finished: 14 payslips, 2 warnings to check.' },
  { who: 'a', text: 'Warnings checked. First approval given.' },
  { who: 'b', text: 'Second approval given from my account. Disbursing.' },
  { who: 'a', text: 'I will give the second one too, to speed things up.' },
  { who: 'sys', text: 'Not allowed: a different Payroll admin must give the second approval.' },
  { who: 'sys', text: 'Run locked. Payslips released to 14 people.' },
]

const FAQ: [string, string][] = [
  ['Can HR see salaries?', 'No. HR admins manage people, leave and attendance rules and add bank details, but never see salaries, contracts, payslips or payroll. Pay belongs to Payroll admins.'],
  ['Do I have to install every app?', 'No. Every workspace has people, approvals, tasks and notifications. Attendance, leave, payroll, expenses and exits are optional and can be switched on or off at any time.'],
  ['Which countries does payroll cover?', 'Zambia and India have full payroll tax tables built in. Kenya and Nigeria starters exist with their rates marked to confirm. Every statutory rate cites its source.'],
  ['Does it file PAYE, NAPSA and NHIMA returns?', 'It prepares and tracks them in a filing dashboard and keeps the reference. Submitting the return itself happens on the authority\'s own portal.'],
  ['Can I export to my accounting system and my bank?', 'Yes. Each run gives one balanced journal in JSON, CSV, XML, QuickBooks, Xero or Tally layouts, with your own ledger accounts, and bank files in several layouts. Other banks are added from your bank\'s template.'],
  ['How is sensitive data protected?', 'Two-factor sign-in, encrypted bank details (only the last four digits are ever shown), role-based access enforced on the server, an audit log, and each company\'s data kept separate.'],
]

export default function LandingPage() {
  const { isAuthenticated, isLoading } = useAuth()
  if (isLoading) return null
  if (isAuthenticated) return <Navigate to="/dashboard" replace />

  return (
    <div className="lw">
      <header className="lw-nav">
        <div className="lw-col lw-nav-in">
          <Link to="/" aria-label="MarichiHR home"><Logo size={24} /></Link>
          <nav className="lw-nav-links" aria-label="Page sections"><a href="#apps">Apps</a><a href="#run">A payroll run</a><a href="#faq">Questions</a></nav>
          <Link to="/login" className="lw-link lw-signin">Sign in</Link>
          <Link to="/signup" className="lw-btn">Create a free workspace</Link>
        </div>
      </header>

      <main>
        {/* ─── First screen ─── */}
        <section className="lw-col lw-hero">
          <div className="lw-hero-text">
            <h1 className="lw-wide lw-fade" style={{ ['--d' as string]: '0ms' }}>People, time and pay in one workspace.</h1>
            <p className="lw-lead lw-fade" style={{ ['--d' as string]: '90ms' }}>Attendance, leave, payroll, expenses and exits as separate apps. Install the ones you need today and add the rest as you grow.</p>
            <div className="lw-fade" style={{ ['--d' as string]: '180ms' }}><Link to="/signup" className="lw-btn lw-btn-lg">Create a free workspace</Link></div>
            <p className="lw-fine lw-fade" style={{ ['--d' as string]: '260ms' }}>Payroll tax tables for Zambia and India are built in.</p>
          </div>
          <div className="lw-hero-art" aria-hidden="true">
            <svg className="lw-sun" viewBox="0 0 32 32"><circle cx="16" cy="16" r="13" fill="var(--night)" /><path d="M16 3a13 13 0 0 0 0 26z" fill="var(--honey)" /><circle cx="16" cy="16" r="5" fill="#fff" /></svg>
            <ul className="lw-pills">
              {APPS.map((a, i) => <li key={a.key} style={{ background: a.tint, ['--i' as string]: i }}>{a.name}</li>)}
            </ul>
          </div>
        </section>

        {/* ─── Apps: panels slide sideways while the stage holds ─── */}
        <section id="apps" className="lw-slide" aria-label="The five apps">
          <div className="lw-stage">
            <div className="lw-col lw-stage-head"><h2 className="lw-wide">Five apps on one shared core.</h2></div>
            <div className="lw-track">
              {APPS.map((a) => (
                <article key={a.key} className="lw-panel" style={{ background: a.tint }}>
                  <p className="lw-say lw-wide">{SAY[a.key]}</p>
                  <div>
                    <h3>{a.name}</h3>
                    <p className="lw-panel-tag">{a.tagline}</p>
                    <ul className="lw-panel-list">{a.features.map((f) => <li key={f}>{f}</li>)}</ul>
                  </div>
                </article>
              ))}
              <article className="lw-panel lw-panel-core">
                <p className="lw-say lw-wide">Always there.</p>
                <div>
                  <h3>The shared core</h3>
                  <p className="lw-panel-tag">Every workspace includes these, whichever apps you install.</p>
                  <ul className="lw-panel-list"><li>People and org chart</li><li>Approvals in one inbox</li><li>Tasks and follow-ups</li><li>Notifications</li></ul>
                </div>
              </article>
            </div>
          </div>
        </section>

        <section className="lw-col lw-also" aria-label="More in every workspace">
          <h2 className="lw-wide">And around them.</h2>
          <ul>{ALSO.map((t, i) => <li key={t} className={i % 3 === 0 ? 'y' : i % 3 === 1 ? 'k' : ''}>{t}</li>)}</ul>
        </section>

        {/* ─── A payroll run: bars that grow with each step ─── */}
        <section id="run" className="lw-col lw-sec">
          <h2 className="lw-wide">One payroll run, six steps.</h2>
          <p className="lw-lead">Above an amount you set, a System admin signs the run off as well.</p>
          <ol className="lw-bars">
            {STEPS.map(([t, b], i) => (
              <li key={t}>
                <span className="lw-bar" aria-hidden="true"><i className={i % 2 ? 'k' : ''} style={{ width: `${((i + 1) / STEPS.length) * 100}%` }} /></span>
                <div><strong>{t}</strong><span>{b}</span></div>
              </li>
            ))}
          </ol>
        </section>

        {/* ─── A payslip ─── */}
        <section className="lw-col lw-sec lw-split">
          <div>
            <h2 className="lw-wide">Every line can be checked.</h2>
            <p className="lw-lead">Salary rules are formulas you can read and change. Statutory lines come from a rates table where each rate cites its source. The NAPSA ceiling is still marked to confirm.</p>
          </div>
          <div className="lw-slip" role="group" aria-label="Sample payslip">
            <p className="lw-slip-note">Sample payslip · Zambia · K10,000 a month · worked out by the payroll engine</p>
            <dl>
              {PAYSLIP.map((l) => <div key={l.label} className={l.kind ?? ''}><dt>{l.label}</dt><dd>{fmt(l.amount)}</dd></div>)}
            </dl>
          </div>
        </section>

        {/* ─── The one action ─── */}
        <section className="lw-col lw-sec">
          <div className="lw-trial">
            <h2 className="lw-wide">Create a free workspace.</h2>
            <p>Add your company, choose your apps, invite your team.</p>
            <Link to="/signup" className="lw-btn lw-btn-lg">Create a free workspace</Link>
          </div>
        </section>

        {/* ─── Chat thread ─── */}
        <section className="lw-col lw-sec">
          <h2 className="lw-wide">Nobody approves their own work.</h2>
          <p className="lw-lead">A sample of how a run passes between people. Illustrative, not a customer conversation.</p>
          <ol className="lw-chat">
            {CHAT.map((m, i) => (
              <li key={i} className={`lw-msg ${m.who}${m.text.startsWith('Not allowed') ? ' no' : ''}`}>
                <span className="lw-who">{m.who === 'sys' ? 'MarichiHR' : m.who === 'a' ? 'Payroll admin A' : 'Payroll admin B'}</span>
                <p>{m.text}</p>
              </li>
            ))}
          </ol>
        </section>

        {/* ─── Questions ─── */}
        <section id="faq" className="lw-col lw-sec">
          <h2 className="lw-wide">Questions.</h2>
          <div className="lw-faq">
            {FAQ.map(([q, a]) => (
              <details key={q}><summary>{q}</summary><p>{a}</p></details>
            ))}
          </div>
        </section>
      </main>

      <footer className="lw-foot">
        <div className="lw-col lw-foot-in">
          <Logo size={20} /><span>© {new Date().getFullYear()} Marichi Labs</span>
          <span className="lw-foot-links"><Link to="/login">Sign in</Link><Link to="/signup">Create a free workspace</Link></span>
        </div>
      </footer>
    </div>
  )
}
