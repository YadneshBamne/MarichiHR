import { Link } from 'react-router-dom'
import PageHeader from '../../components/ui/PageHeader'

// Read-only map of who can do what. Roles are given per person in their profile › Login & access tab; they stack.
const ROLES = ['Employee', 'Manager', 'Payroll admin', 'HR admin', 'System admin'] as const
const MATRIX: [string, ...string[]][] = [
  ['Dashboard', 'Own', 'Own + team', 'Own + payroll', 'Company', 'Company'],
  ['Profiles', 'Own', 'Team below (no pay)', 'List only', 'All', 'All (no pay)'],
  ['Attendance', 'Own', 'Approve team', 'Lock for payroll', 'All, policies', 'Policies'],
  ['Leave', 'Own, request days', 'Approve team', '—', 'All, balances, rules', '—'],
  ['Expenses', 'Own claims', 'Approve team', 'Finance approve', 'All, categories', '—'],
  ['Payroll run', '—', '—', 'Run, finance approve, pay', 'Run, HR approve', '—'],
  ['Payslips', 'Own', 'Own', 'All', 'All', 'Own'],
  ['Salary structures, contracts', 'Own contract', '—', 'Read', 'Create / edit', '—'],
  ['Salary revisions', '—', '—', 'Raise / approve*', 'Raise / approve*', '—'],
  ['Tax & compliance', 'Own statement', 'Own', 'View, filing', 'View, configure', '—'],
  ['Incentives', 'Own awards', 'Nominate', 'Post to payroll', 'Configure, approve', '—'],
  ['Recruitment', 'Jobs & referrals', 'Request openings', '—', 'Full', '—'],
  ['Exits / settlements', '—', '—', 'Approve*, pay', 'Start, compute', '—'],
  ['Policies, announcements', 'Read, accept', 'Read', 'Read', 'Write, publish', 'Write, publish'],
  ['Grievances', 'Raise own', 'Raise own', 'Raise own', 'Handle all', '—'],
  ['Reports', '—', 'Team', 'Payroll, expenses', 'All', 'All'],
  ['Audit log', '—', '—', '—', 'Yes', 'Yes'],
  ['Masters, company profile, automation', '—', '—', '—', 'Yes', 'Yes'],
  ['Apps, webhooks, API keys', '—', '—', '—', '—', 'Yes'],
  ['Logins and roles', '—', '—', '—', 'Yes (not System admin / Compliance)', 'Yes (all)'],
]

export default function RolesPage() {
  return (
    <div>
      <PageHeader title="Roles & permissions" sub="Who can see and do what. Give roles in a person's profile › Login & access; one person can have several." />
      <section className="card" style={{ padding: 18, display: 'grid', gap: 8, fontSize: 13.5 }}>
        <p style={{ margin: 0 }}><b>Managers</b> need the Manager role <i>and</i> people set to report to them (the "Reports to" field). They approve for their team, including people further down their line, and never see pay.</p>
        <p style={{ margin: 0 }}><b>Two people, two jobs:</b> payroll is approved by an HR admin, then a Payroll admin gives the finance approval and pays. Salary revisions and final settlements are approved by someone other than the person who prepared them. Nobody approves their own leave or expenses.</p>
        <p style={{ margin: 0 }}><b>Only a System admin</b> can switch apps on or off, manage webhooks and API keys, and give the System admin or Compliance officer role.</p>
        <p className="dim" style={{ margin: 0, fontSize: 12.5 }}>Compliance officer (not shown below): tax rules and filing, reads payroll and salary, audit log. <Link to="/employees">Go to Employees</Link> to assign roles.</p>
      </section>
      <section className="card" style={{ padding: 8, marginTop: 'var(--gap)', overflowX: 'auto' }}>
        <table className="tbl" style={{ width: '100%', minWidth: 760 }}>
          <thead><tr><th>Area</th>{ROLES.map((r) => <th key={r}>{r}</th>)}</tr></thead>
          <tbody>{MATRIX.map(([area, ...cells]) => <tr key={area}><td><strong style={{ fontWeight: 600 }}>{area}</strong></td>{cells.map((c, i) => <td key={i} className={c === '—' ? 'dim' : undefined} style={{ fontSize: 13 }}>{c}</td>)}</tr>)}</tbody>
        </table>
        <p className="dim" style={{ fontSize: 12, padding: '6px 8px', margin: 0 }}>* never their own.</p>
      </section>
    </div>
  )
}
