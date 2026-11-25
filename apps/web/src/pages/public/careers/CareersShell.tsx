import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { CompanyLogo } from '../../../components/company/CompanyParts'
import type { CareersCompany } from './careersApi'

// The frame of every public careers page: company header, content, footer. No app shell, no sign-in.
export default function CareersShell({ company, slug, children }: { company?: CareersCompany | null; slug: string; children: ReactNode }) {
  return (
    <div className="canvas" style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <header style={{ maxWidth: 920, width: '100%', margin: '0 auto', padding: '20px 16px 0', display: 'flex', alignItems: 'center', gap: 12 }}>
        {company ? (
          <Link to={`/careers/${slug}`} style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }} aria-label={`${company.name}: all openings`}>
            <CompanyLogo name={company.name} src={company.logoUrl} size={44} />
            <span style={{ fontFamily: 'var(--font-display)', fontSize: 20, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{company.name}</span>
          </Link>
        ) : <span className="skeleton" style={{ width: 180, height: 44, borderRadius: 14 }} />}
      </header>
      <main style={{ maxWidth: 920, width: '100%', margin: '0 auto', padding: '8px 16px 40px', flex: 1 }}>{children}</main>
      <footer style={{ maxWidth: 920, width: '100%', margin: '0 auto', padding: '0 16px 28px', fontSize: 12.5, color: 'var(--faint)', display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'space-between' }}>
        <span>Powered by MarichiHR</span>
        <span>No cookies, no tracking. Your details are used only to consider your application.</span>
      </footer>
    </div>
  )
}

export function Unavailable({ slug, title = 'This page is not available', body = 'The careers page you are looking for does not exist, or the company is not showing any openings right now.' }: { slug?: string; title?: string; body?: string }) {
  return (
    <div className="canvas" style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 18 }}>
      <div className="card" style={{ width: 'min(480px, 100%)', padding: 30, textAlign: 'center', display: 'grid', gap: 10 }}>
        <h1 style={{ fontSize: 30 }}>{title}</h1>
        <p className="dim" style={{ lineHeight: 1.6 }}>{body}</p>
        {slug && <Link className="btn btn-ghost" to={`/careers/${slug}`} style={{ justifySelf: 'center' }}>See all openings</Link>}
      </div>
    </div>
  )
}
