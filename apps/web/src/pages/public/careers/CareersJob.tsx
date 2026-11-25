import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import Icon from '../../../components/ui/Icon'
import { getOpening, applyTo, useDocMeta, postedText, salaryText, CareersError, type CareersCompany, type CareersOpening } from './careersApi'
import CareersShell, { Unavailable } from './CareersShell'

const MAX_CV = 5 * 1024 * 1024
const EMAIL = /^[^\s@<>"',;:]+@[^\s@<>"',;:]+\.[A-Za-z]{2,}$/
const PHONE = /^\+?\d[\d\s().-]{5,24}$/
const size = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`)

// /careers/:slug/:openingId: the full description and the application form
export default function CareersJob() {
  const { slug = '', openingId = '' } = useParams()
  const [data, setData] = useState<{ company: CareersCompany; opening: CareersOpening } | null>(null)
  const [state, setState] = useState<'loading' | 'ok' | 'gone' | 'error'>('loading')
  const formRef = useRef<HTMLElement>(null)

  useEffect(() => {
    let live = true
    setState('loading')
    getOpening(slug, openingId).then((d) => { if (live) { setData(d); setState('ok') } }).catch((e) => { if (live) setState(e instanceof CareersError && e.status === 404 ? 'gone' : 'error') })
    return () => { live = false }
  }, [slug, openingId])

  useDocMeta(data ? `${data.opening.title} · ${data.company.name}` : 'Careers', data ? data.opening.excerpt : undefined)

  if (state === 'gone') return <Unavailable slug={slug} title="This position is not open any more" body="It may have been filled or taken down. Have a look at the other openings." />
  if (state === 'error') return <Unavailable slug={slug} title="We could not load this page" body="Please check your connection and try again in a moment." />
  const c = data?.company, o = data?.opening
  return (
    <CareersShell company={c} slug={slug}>
      {state === 'loading' || !c || !o ? <div className="skeleton" style={{ height: 380, borderRadius: 28, marginTop: 16 }} /> : (
        <>
          <Link to={`/careers/${slug}`} className="link" style={{ display: 'inline-block', margin: '14px 0 6px', fontSize: 13.5 }}>← All openings</Link>
          <article style={{ display: 'grid', gap: 14, padding: '8px 0 22px' }}>
            <h1 style={{ fontSize: 'clamp(30px, 5.4vw, 48px)', lineHeight: 1.08, letterSpacing: '-0.02em' }}>{o.title}</h1>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              {o.department && <span className="pill mute" style={{ textTransform: 'none' }}>{o.department}</span>}
              {o.location && <span className="pill mute" style={{ textTransform: 'none' }}>{o.location}</span>}
              <span className="pill honey" style={{ textTransform: 'none' }}>{o.employmentTypeLabel}</span>
              {o.salary && <span className="pill info" style={{ textTransform: 'none' }}>{salaryText(o.salary)}</span>}
              <span className="muted" style={{ fontSize: 12.5, marginLeft: 4 }}>{postedText(o.postedAt)}</span>
            </div>
            <div className="card" style={{ padding: 'clamp(18px, 4vw, 28px)' }}>
              <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.7, fontSize: 15.5, overflowWrap: 'anywhere' }}>{o.description}</div>
            </div>
            <div><button type="button" className="btn btn-primary" style={{ height: 46, padding: '0 28px' }} onClick={() => formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>Apply for this role</button></div>
          </article>
          <ApplyForm slug={slug} opening={o} company={c} formRef={formRef} />
        </>
      )}
    </CareersShell>
  )
}

function ApplyForm({ slug, opening, company, formRef }: { slug: string; opening: CareersOpening; company: CareersCompany; formRef: React.RefObject<HTMLElement | null> }) {
  const startedAt = useRef(Date.now())
  const pick = useRef<HTMLInputElement>(null)
  const [f, setF] = useState({ firstName: '', lastName: '', email: '', phone: '', message: '', consent: false, website: '' })
  const [cv, setCv] = useState<File | null>(null)
  const [drag, setDrag] = useState(false)
  const [errs, setErrs] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [fail, setFail] = useState<{ message: string; closed?: boolean } | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const set = (k: string) => (e: any) => { setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }); if (errs[k]) setErrs({ ...errs, [k]: '' }) }

  const take = (file?: File | null) => {
    if (!file) return
    const ok = /\.(pdf|docx?)$/i.test(file.name)
    if (!ok) return setErrs({ ...errs, cv: 'Use a PDF, DOC or DOCX file' })
    if (file.size > MAX_CV) return setErrs({ ...errs, cv: 'A CV can be up to 5 MB' })
    setErrs({ ...errs, cv: '' }); setCv(file)
  }
  const check = () => {
    const e: Record<string, string> = {}
    if (!f.firstName.trim()) e.firstName = 'Enter your first name'
    if (!f.lastName.trim()) e.lastName = 'Enter your last name'
    if (!EMAIL.test(f.email.trim())) e.email = 'Enter a valid email address'
    if (f.phone.trim() && !PHONE.test(f.phone.trim())) e.phone = 'Use digits, spaces and + only, for example +260 97 1234567'
    if (f.message.length > 2000) e.message = 'Keep the message under 2,000 characters'
    if (!f.consent) e.consent = 'Please agree to the use of your details'
    setErrs(e)
    return !Object.keys(e).length
  }
  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault()
    setFail(null)
    if (!check()) return
    const fd = new FormData()
    for (const [k, v] of Object.entries({ firstName: f.firstName, lastName: f.lastName, email: f.email, phone: f.phone, message: f.message, website: f.website })) fd.append(k, String(v).trim())
    fd.append('consent', 'true'); fd.append('startedAt', String(startedAt.current))
    if (cv) fd.append('cv', cv)
    setBusy(true)
    try { await applyTo(slug, opening.id, fd); setDone(f.firstName.trim()) } catch (e) {
      const err = e as CareersError
      if (err.fields) setErrs(err.fields)
      setFail({ message: err.message, closed: err.status === 404 })
      if (err.code === 'TOO_FAST') startedAt.current = Date.now() - 4000 // a person who was simply quick can send again at once
    } finally { setBusy(false) }
  }

  if (done) return (
    <section ref={formRef} className="card" style={{ padding: 'clamp(22px, 5vw, 36px)', display: 'grid', gap: 10, textAlign: 'center', justifyItems: 'center' }} role="status">
      <span aria-hidden="true" style={{ width: 54, height: 54, borderRadius: '50%', background: 'var(--ok-bg)', color: 'var(--ok)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}><Icon name="checkCircle" size={28} /></span>
      <h2 style={{ fontSize: 28 }}>Thank you, {done}</h2>
      <p className="dim" style={{ lineHeight: 1.65, maxWidth: 520 }}>We have received your application for <strong>{opening.title}</strong>. A confirmation is on its way to your email. Our team reads every application and will get in touch if your profile fits the role. You do not need to do anything else.</p>
      <Link className="btn btn-ghost" to={`/careers/${slug}`}>See other openings</Link>
    </section>
  )

  const label: React.CSSProperties = { display: 'grid', gap: 6, fontSize: 13.5, fontWeight: 500 }
  const err = (k: string) => errs[k] ? <span role="alert" style={{ color: 'var(--danger)', fontSize: 12.5, fontWeight: 400 }}>{errs[k]}</span> : null
  return (
    <section ref={formRef} id="apply" className="card" style={{ padding: 'clamp(18px, 4vw, 30px)', scrollMarginTop: 16 }} aria-labelledby="apply-title">
      <form onSubmit={submit} noValidate style={{ display: 'grid', gap: 16 }}>
        <div><h2 id="apply-title" style={{ fontSize: 26 }}>Apply for {opening.title}</h2><p className="dim" style={{ marginTop: 4 }}>It takes about two minutes. Fields marked * are needed.</p></div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))', gap: 14 }}>
          <label style={label}>First name *<input className="input" value={f.firstName} onChange={set('firstName')} autoComplete="given-name" maxLength={60} aria-invalid={!!errs.firstName} />{err('firstName')}</label>
          <label style={label}>Last name *<input className="input" value={f.lastName} onChange={set('lastName')} autoComplete="family-name" maxLength={60} aria-invalid={!!errs.lastName} />{err('lastName')}</label>
          <label style={label}>Email *<input className="input" type="email" inputMode="email" value={f.email} onChange={set('email')} autoComplete="email" maxLength={200} aria-invalid={!!errs.email} />{err('email')}</label>
          <label style={label}>Phone<input className="input" type="tel" inputMode="tel" value={f.phone} onChange={set('phone')} autoComplete="tel" maxLength={30} placeholder="Optional" aria-invalid={!!errs.phone} />{err('phone')}</label>
        </div>
        <label style={label}>A few words about you<textarea className="input" rows={4} value={f.message} onChange={set('message')} maxLength={2000} placeholder="Optional: why this role, and what you have done that fits it" style={{ height: 'auto', padding: 12, borderRadius: 18, resize: 'vertical' }} /><span className="muted" style={{ fontSize: 12, fontWeight: 400, textAlign: 'right' }}>{f.message.length}/2000</span>{err('message')}</label>

        <div style={label}>
          <span>CV <span className="muted" style={{ fontWeight: 400 }}>(optional, PDF or Word, up to 5 MB)</span></span>
          {cv ? (
            <div className="well" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', borderRadius: 16 }}>
              <Icon name="file" size={18} /><span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{cv.name}</span><span className="muted" style={{ fontSize: 12.5 }}>{size(cv.size)}</span>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setCv(null); if (pick.current) pick.current.value = '' }} aria-label="Remove the CV">Remove</button>
            </div>
          ) : (
            <div onDragOver={(e) => { e.preventDefault(); setDrag(true) }} onDragLeave={() => setDrag(false)} onDrop={(e) => { e.preventDefault(); setDrag(false); take(e.dataTransfer.files?.[0]) }}
              style={{ border: `2px dashed ${drag ? 'var(--ink)' : 'var(--line-2)'}`, borderRadius: 18, padding: '22px 14px', textAlign: 'center', background: drag ? 'var(--honey-soft)' : 'transparent', transition: 'background .15s' }}>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => pick.current?.click()}>Choose a file</button>
              <p className="muted" style={{ fontSize: 12.5, marginTop: 8, fontWeight: 400 }}>or drop it here</p>
            </div>
          )}
          <input ref={pick} type="file" accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document" hidden onChange={(e) => take(e.target.files?.[0])} />
          {err('cv')}
        </div>

        {/* a hidden field for software that fills every box: a person never sees or fills it */}
        <div aria-hidden="true" style={{ position: 'absolute', left: -9999, width: 1, height: 1, overflow: 'hidden' }}><label>Website<input tabIndex={-1} autoComplete="off" value={f.website} onChange={set('website')} /></label></div>

        <div className="well" style={{ padding: 16, borderRadius: 18, display: 'grid', gap: 10, fontSize: 13.5, lineHeight: 1.6 }}>
          <strong style={{ fontWeight: 600 }}>What we collect and who sees it</strong>
          <span className="dim">Your name, email and anything else you fill in above, including your CV if you add one. It is seen only by {company.name}'s HR team, the hiring manager and the people who interview you for this role, and is used only to consider your application.{company.contactEmail ? <> To ask for it to be removed, write to <a className="link" href={`mailto:${company.contactEmail}`}>{company.contactEmail}</a>.</> : ''}</span>
          {company.applyNote && <span className="dim" style={{ whiteSpace: 'pre-line' }}>{company.applyNote}</span>}
          <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', fontWeight: 500 }}>
            <input type="checkbox" checked={f.consent} onChange={set('consent')} style={{ marginTop: 3 }} aria-invalid={!!errs.consent} />
            <span>I agree that {company.name} keeps my details and CV for this application.</span>
          </label>
          {err('consent')}
        </div>

        {fail && (
          <div role="alert" style={{ background: 'var(--danger-bg)', color: 'var(--danger)', borderRadius: 14, padding: '12px 14px', fontSize: 13.5, lineHeight: 1.5 }}>
            {fail.closed ? <>This position is not open any more. <Link className="link" to={`/careers/${slug}`}>See the other openings</Link>.</> : fail.message}
          </div>
        )}
        <button className="btn btn-primary" type="submit" disabled={busy} style={{ height: 48, justifySelf: 'start', padding: '0 30px' }}>{busy ? 'Sending…' : 'Send my application'}</button>
      </form>
    </section>
  )
}
