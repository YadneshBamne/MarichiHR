import { useLayoutEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import api from '../../lib/api'
import { useAuth } from '../../contexts/AuthContext'
import { useCompany, useCompanyWrite } from '../../lib/hooks/useCompany'
import { APPS, type AppKey } from '../../lib/apps'
import { gsap, reduced } from '../../lib/motion'
import { useToast } from '../../components/ui/Toast'
import { AppPicker, CompanyFields, LogoPicker, CompanyLogo, draftFrom, draftToBody, type CompanyDraft } from '../../components/company/CompanyParts'
import { TemporaryPassword } from '../../components/company/AccessCard'
import Icon from '../../components/ui/Icon'
import Logo from '../../components/brand/Logo'

const STEPS = ['Apps', 'Company', 'Team', 'Done'] as const
const errMsg = (e: any) => e?.response?.data?.message || 'Something went wrong'
type Person = { firstName: string; lastName: string; email: string; role: 'employee' | 'manager' | 'hr_admin' | 'payroll_admin' }
const blank = (): Person => ({ firstName: '', lastName: '', email: '', role: 'employee' })
type Added = { name: string; email: string; role: string; password?: string; error?: string }

// First run for a new company: pick apps, describe the company, add the first people with their logins
export default function OnboardingPage() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const toast = useToast()
  const { data: company } = useCompany()
  const { update, setApps, complete } = useCompanyWrite()
  const [step, setStep] = useState(0)
  const dir = useRef(1)
  const [apps, setAppsSel] = useState<AppKey[]>(APPS.map((a) => a.key))
  const [draft, setDraft] = useState<CompanyDraft | null>(null)
  const [people, setPeople] = useState<Person[]>([blank()])
  const [added, setAdded] = useState<Added[]>([])
  const [busy, setBusy] = useState(false)
  const body = useRef<HTMLDivElement>(null)
  const d = draft ?? (company ? draftFrom(company) : null)

  useLayoutEffect(() => {
    if (body.current && !reduced()) gsap.fromTo(body.current, { opacity: 0, x: dir.current * 40 }, { opacity: 1, x: 0, duration: 0.55, ease: 'power3.out', clearProps: 'opacity,transform' })
  }, [step])
  const go = (n: number) => { dir.current = n > step ? 1 : -1; setStep(n); window.scrollTo({ top: 0, behavior: reduced() ? 'auto' : 'smooth' }) }

  const saveApps = async () => {
    setBusy(true)
    try { await setApps.mutateAsync(apps); go(1) } catch (e) { toast(errMsg(e), 'error') } finally { setBusy(false) }
  }
  const saveCompany = async () => {
    if (!d?.name.trim()) return toast('Enter the company name', 'error')
    setBusy(true)
    try { await update.mutateAsync(draftToBody(d)); go(2) } catch (e) { toast(errMsg(e), 'error') } finally { setBusy(false) }
  }
  const addPeople = async () => {
    const rows = people.filter((p) => p.firstName.trim() && p.email.trim())
    if (!rows.length) return go(3)
    setBusy(true)
    const tree = (await api.get('/employees/org-units/tree')).data.data
    const rootId = (Array.isArray(tree) ? tree[0] : tree)?.id
    const out: Added[] = await Promise.all(rows.map(async (p) => {
      const name = `${p.firstName.trim()} ${p.lastName.trim()}`.trim()
      try {
        const emp = (await api.post('/employees', { firstName: p.firstName.trim(), lastName: p.lastName.trim() || '-', workEmail: p.email.trim().toLowerCase(), orgUnitId: rootId, hireDate: new Date().toISOString().slice(0, 10), employmentType: 'full_time', ...(user?.employee?.id && { managerId: user.employee.id }) })).data.data.employee
        const acc = (await api.put(`/employees/${emp.id}/access`, { roles: p.role === 'employee' ? [] : [p.role], password: 'generate', loginEnabled: true })).data.data
        return { name, email: acc.email, role: p.role, password: acc.temporaryPassword }
      } catch (e) { return { name, email: p.email, role: p.role, error: errMsg(e) } }
    }))
    setAdded((a) => [...a, ...out])
    setPeople([blank()])
    setBusy(false)
    const failed = out.filter((x) => x.error).length
    toast(failed ? `${out.length - failed} added, ${failed} need attention` : `${out.length} ${out.length === 1 ? 'person' : 'people'} added`, failed ? 'error' : 'ok')
  }
  const finish = async () => {
    setBusy(true)
    try { await complete.mutateAsync(); navigate('/dashboard', { replace: true }) } catch (e) { toast(errMsg(e), 'error'); setBusy(false) }
  }

  return (
    <div className="canvas" style={{ minHeight: '100vh', padding: '18px clamp(14px, 3vw, 40px) 60px' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 12, maxWidth: 1100, margin: '0 auto' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10, height: 44, padding: '0 16px 0 6px', borderRadius: 999, background: 'var(--card-2)', border: '1px solid var(--hair)', boxShadow: 'var(--shadow)' }}>
          <CompanyLogo name={d?.name || user?.tenant?.name || ''} src={d?.logoUrl ?? user?.tenant?.logoUrl} size={32} />
          <span style={{ fontFamily: 'var(--font-display)', fontSize: 17 }}>{d?.name || user?.tenant?.name}</span>
        </span>
        <span className="muted desktop-only" style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 6 }}>on <Logo size={15} /></span>
        <button className="link" style={{ marginLeft: 'auto' }} onClick={() => logout().then(() => navigate('/login'))}>Sign out</button>
      </header>

      <div style={{ maxWidth: 1100, margin: '28px auto 0' }}>
        <ol aria-label="Setup steps" style={{ listStyle: 'none', display: 'grid', gridTemplateColumns: `repeat(${STEPS.length}, minmax(0, 1fr))`, gap: 8 }}>
          {STEPS.map((s, i) => (
            <li key={s} aria-current={i === step ? 'step' : undefined}>
              <div className={`seg ${i < step ? 'night' : i === step ? 'honey' : 'outline'}`} style={{ height: 10, padding: 0, transition: 'background-color .5s var(--ease)' }} />
              <div className={i <= step ? '' : 'muted'} style={{ fontSize: 12, marginTop: 6, fontWeight: i === step ? 600 : 400 }}>{i + 1}. {s}</div>
            </li>
          ))}
        </ol>

        <div ref={body} style={{ marginTop: 28 }}>
          {step === 0 && (
            <>
              <h1 style={{ fontSize: 'clamp(32px, 4vw, 48px)' }}>Which apps do you need?</h1>
              <p className="dim" style={{ marginTop: 8, marginBottom: 22, maxWidth: 620 }}>People, approvals, tasks and notifications are always included. Pick the rest; you can add or remove apps any time in Settings.</p>
              <AppPicker value={apps} onChange={setAppsSel} />
              <Footer next={<button className="btn btn-primary" disabled={busy} onClick={saveApps}>{busy ? 'Saving…' : <>Continue with {apps.length} {apps.length === 1 ? 'app' : 'apps'} <Icon name="arrowRight" size={15} /></>}</button>}
                left={<span className="dim" style={{ fontSize: 13 }}>{apps.length ? APPS.filter((a) => apps.includes(a.key)).map((a) => a.name).join(', ') : 'Core only'}</span>} />
            </>
          )}

          {step === 1 && d && (
            <>
              <h1 style={{ fontSize: 'clamp(32px, 4vw, 48px)' }}>Tell us about {d.name || 'your company'}</h1>
              <p className="dim" style={{ marginTop: 8, marginBottom: 22 }}>Your name and logo appear across the workspace. Country, currency and time zone drive leave, attendance and payroll.</p>
              <div className="card" style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 20 }}>
                <LogoPicker name={d.name} value={d.logoUrl} onChange={(v) => setDraft({ ...d, logoUrl: v })} />
                <CompanyFields draft={d} set={(p) => setDraft({ ...d, ...p })} />
              </div>
              <Footer back={() => go(0)} next={<button className="btn btn-primary" disabled={busy || !d.name.trim()} onClick={saveCompany}>{busy ? 'Saving…' : <>Continue <Icon name="arrowRight" size={15} /></>}</button>} />
            </>
          )}

          {step === 2 && (
            <>
              <h1 style={{ fontSize: 'clamp(32px, 4vw, 48px)' }}>Add your first people</h1>
              <p className="dim" style={{ marginTop: 8, marginBottom: 22, maxWidth: 680 }}>Each person gets a login with a temporary password you share with them; they choose their own at first sign-in. Managers approve their team's requests; HR admins help you run the company. You can add more later from People.</p>
              <div className="card" style={{ padding: 18 }}>
                {people.map((p, i) => (
                  <div key={i} className="person-row">
                    <input className="input" aria-label="First name" placeholder="First name" value={p.firstName} onChange={(e) => setPeople(people.map((x, j) => (j === i ? { ...x, firstName: e.target.value } : x)))} />
                    <input className="input" aria-label="Last name" placeholder="Last name" value={p.lastName} onChange={(e) => setPeople(people.map((x, j) => (j === i ? { ...x, lastName: e.target.value } : x)))} />
                    <input className="input" aria-label="Work email" type="email" placeholder="work@email.com" value={p.email} onChange={(e) => setPeople(people.map((x, j) => (j === i ? { ...x, email: e.target.value } : x)))} />
                    <select className="input select" aria-label="Role" value={p.role} onChange={(e) => setPeople(people.map((x, j) => (j === i ? { ...x, role: e.target.value as Person['role'] } : x)))}>
                      <option value="employee">Employee</option><option value="manager">Manager</option><option value="hr_admin">HR admin</option><option value="payroll_admin">Payroll / finance</option>
                    </select>
                    <button className="btn btn-ghost btn-icon" aria-label="Remove row" disabled={people.length === 1} onClick={() => setPeople(people.filter((_, j) => j !== i))}><Icon name="x" size={14} /></button>
                  </div>
                ))}
                <div style={{ display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
                  <button className="btn btn-ghost btn-sm" onClick={() => setPeople([...people, blank()])}><Icon name="plus" size={13} /> Another person</button>
                  <button className="btn btn-primary btn-sm" disabled={busy || !people.some((p) => p.firstName.trim() && p.email.trim())} onClick={addPeople} style={{ marginLeft: 'auto' }}>{busy ? 'Adding…' : 'Add and create logins'}</button>
                </div>
              </div>
              {added.length > 0 && (
                <div style={{ marginTop: 'var(--gap)', display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {added.map((a, i) => a.error
                    ? <div key={i} role="alert" style={{ background: 'var(--danger-bg)', color: 'var(--danger)', borderRadius: 14, padding: '10px 14px', fontSize: 13 }}>{a.name} ({a.email}): {a.error}</div>
                    : <div key={i}><div style={{ fontSize: 13, marginBottom: 6 }}><strong>{a.name}</strong> <span className="pill mute" style={{ marginLeft: 6 }}>{a.role.replace('_', ' ')}</span></div><TemporaryPassword email={a.email} password={a.password!} workspace={user?.tenant?.slug} /></div>)}
                </div>
              )}
              <Footer back={() => go(1)} next={<button className="btn btn-primary" onClick={() => go(3)}>{added.some((a) => !a.error) ? 'Continue' : 'Skip for now'} <Icon name="arrowRight" size={15} /></button>} />
            </>
          )}

          {step === 3 && d && (
            <div className="card" style={{ padding: 'clamp(24px, 4vw, 48px)', textAlign: 'center', maxWidth: 640, margin: '0 auto' }}>
              <CompanyLogo name={d.name} src={d.logoUrl} size={88} />
              <h1 style={{ fontSize: 'clamp(32px, 4vw, 46px)', marginTop: 18 }}>{d.name} is ready</h1>
              <p className="dim" style={{ marginTop: 8, lineHeight: 1.6 }}>
                {apps.length} {apps.length === 1 ? 'app' : 'apps'} installed{added.filter((a) => !a.error).length ? `, ${added.filter((a) => !a.error).length} people invited` : ''}. Your workspace address is <code style={{ background: 'var(--well)', padding: '2px 8px', borderRadius: 8 }}>{user?.tenant?.slug}</code>; people can sign in with just their email.
              </p>
              <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginTop: 24, flexWrap: 'wrap' }}>
                <button className="btn btn-ghost" onClick={() => go(2)}><Icon name="chevronLeft" size={15} /> Back</button>
                <button className="btn btn-primary" disabled={busy} onClick={finish}>{busy ? 'Opening…' : <>Open my dashboard <Icon name="arrowRight" size={15} /></>}</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function Footer({ back, next, left }: { back?: () => void; next: React.ReactNode; left?: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 24, flexWrap: 'wrap' }}>
      {back && <button className="btn btn-ghost" onClick={back}><Icon name="chevronLeft" size={15} /> Back</button>}
      {left}
      <span style={{ marginLeft: 'auto' }}>{next}</span>
    </div>
  )
}
