import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { getCompany, useDocMeta, postedText, salaryText, CareersError, type CareersCompany, type CareersOpening } from './careersApi'
import CareersShell, { Unavailable } from './CareersShell'

// /careers/:slug: the company's published openings, with search and filters
export default function CareersList() {
  const { slug = '' } = useParams()
  const [data, setData] = useState<{ company: CareersCompany; openings: CareersOpening[] } | null>(null)
  const [state, setState] = useState<'loading' | 'ok' | 'gone' | 'error'>('loading')
  const [q, setQ] = useState('')
  const [dept, setDept] = useState('')
  const [place, setPlace] = useState('')
  const [type, setType] = useState('')

  useEffect(() => {
    let live = true
    setState('loading')
    getCompany(slug).then((d) => { if (live) { setData(d); setState('ok') } }).catch((e) => { if (live) setState(e instanceof CareersError && e.status === 404 ? 'gone' : 'error') })
    return () => { live = false }
  }, [slug])

  useDocMeta(data ? `Careers at ${data.company.name}` : 'Careers', data ? `${data.openings.length} open position${data.openings.length === 1 ? '' : 's'} at ${data.company.name}. ${data.company.intro}`.slice(0, 280) : undefined)

  const opts = (pick: (o: CareersOpening) => string | null) => [...new Set((data?.openings ?? []).map(pick).filter((x): x is string => !!x))].sort()
  const depts = useMemo(() => opts((o) => o.department), [data]) // eslint-disable-line react-hooks/exhaustive-deps
  const places = useMemo(() => opts((o) => o.location), [data]) // eslint-disable-line react-hooks/exhaustive-deps
  const types = useMemo(() => opts((o) => o.employmentTypeLabel), [data]) // eslint-disable-line react-hooks/exhaustive-deps
  const shown = (data?.openings ?? []).filter((o) => (!dept || o.department === dept) && (!place || o.location === place) && (!type || o.employmentTypeLabel === type)
    && (!q.trim() || `${o.title} ${o.department ?? ''} ${o.location ?? ''} ${o.excerpt}`.toLowerCase().includes(q.trim().toLowerCase())))

  if (state === 'gone') return <Unavailable />
  if (state === 'error') return <Unavailable title="We could not load this page" body="Please check your connection and try again in a moment." />
  const c = data?.company
  return (
    <CareersShell company={c} slug={slug}>
      {state === 'loading' || !c ? <div className="skeleton" style={{ height: 320, borderRadius: 28, marginTop: 16 }} /> : (
        <>
          <section style={{ padding: 'clamp(20px, 5vw, 44px) 0 20px', display: 'grid', gap: 12 }}>
            <h1 style={{ fontSize: 'clamp(32px, 6vw, 54px)', lineHeight: 1.05, letterSpacing: '-0.02em' }}>{c.headline}</h1>
            {c.intro && <p className="dim" style={{ fontSize: 16, lineHeight: 1.65, maxWidth: 680, whiteSpace: 'pre-line' }}>{c.intro}</p>}
          </section>

          {data!.openings.length > 0 && (
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
              <input className="input" type="search" aria-label="Search openings" placeholder="Search by role or keyword" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: '2 1 240px', minWidth: 0 }} />
              {depts.length > 1 && <select className="input" aria-label="Department" value={dept} onChange={(e) => setDept(e.target.value)} style={{ flex: '1 1 150px' }}><option value="">All departments</option>{depts.map((d) => <option key={d}>{d}</option>)}</select>}
              {places.length > 1 && <select className="input" aria-label="Location" value={place} onChange={(e) => setPlace(e.target.value)} style={{ flex: '1 1 150px' }}><option value="">All locations</option>{places.map((d) => <option key={d}>{d}</option>)}</select>}
              {types.length > 1 && <select className="input" aria-label="Type of job" value={type} onChange={(e) => setType(e.target.value)} style={{ flex: '1 1 150px' }}><option value="">All types</option>{types.map((d) => <option key={d}>{d}</option>)}</select>}
            </div>
          )}

          {data!.openings.length === 0 ? (
            <div className="card" style={{ padding: 28, textAlign: 'center', display: 'grid', gap: 8 }}>
              <h2 style={{ fontSize: 24 }}>No open positions right now</h2>
              <p className="dim" style={{ lineHeight: 1.6 }}>We are not hiring for any role at the moment, but we would still like to hear from you.{c.contactEmail ? <> Write to <a className="link" href={`mailto:${c.contactEmail}`}>{c.contactEmail}</a>.</> : ' Please check back soon.'}</p>
            </div>
          ) : shown.length === 0 ? (
            <div className="card" style={{ padding: 24, textAlign: 'center' }}><p className="dim">No openings match your search. <button type="button" className="link" onClick={() => { setQ(''); setDept(''); setPlace(''); setType('') }}>Clear the filters</button></p></div>
          ) : (
            <div style={{ display: 'grid', gap: 12 }} aria-live="polite">
              <p className="dim" style={{ fontSize: 13 }}>{shown.length} open position{shown.length === 1 ? '' : 's'}</p>
              {shown.map((o) => (
                <Link key={o.id} to={`/careers/${slug}/${o.id}`} className="card" style={{ padding: 20, display: 'grid', gap: 10, textDecoration: 'none' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>
                    <h2 style={{ fontSize: 'clamp(19px, 3.2vw, 24px)', lineHeight: 1.2 }}>{o.title}</h2>
                    <span aria-hidden="true" style={{ fontSize: 20, color: 'var(--faint)' }}>→</span>
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {o.department && <span className="pill mute" style={{ textTransform: 'none' }}>{o.department}</span>}
                    {o.location && <span className="pill mute" style={{ textTransform: 'none' }}>{o.location}</span>}
                    <span className="pill honey" style={{ textTransform: 'none' }}>{o.employmentTypeLabel}</span>
                    {o.salary && <span className="pill info" style={{ textTransform: 'none' }}>{salaryText(o.salary)}</span>}
                  </div>
                  {o.excerpt && <p className="dim" style={{ lineHeight: 1.55 }}>{o.excerpt}</p>}
                  <span className="muted" style={{ fontSize: 12.5 }}>{postedText(o.postedAt)}</span>
                </Link>
              ))}
            </div>
          )}
        </>
      )}
    </CareersShell>
  )
}
