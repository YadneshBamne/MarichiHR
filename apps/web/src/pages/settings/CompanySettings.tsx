import { useEffect, useState } from 'react'
import { useAuth } from '../../contexts/AuthContext'
import { useCompany, useCompanyWrite } from '../../lib/hooks/useCompany'
import { useReveal } from '../../lib/motion'
import { useToast } from '../../components/ui/Toast'
import { APPS, type AppKey } from '../../lib/apps'
import PageHeader from '../../components/ui/PageHeader'
import { AppPicker, CompanyFields, LogoPicker, draftFrom, draftToBody, type CompanyDraft } from '../../components/company/CompanyParts'
import { EntitiesSection } from './EntitiesSection'
import { ALL_ITEMS, HIDEABLE } from '../../lib/nav'

const errMsg = (e: any) => e?.response?.data?.message || 'Something went wrong'

export function CompanySettingsPage() {
  const { data: company } = useCompany()
  const { update } = useCompanyWrite()
  const toast = useToast()
  const [d, setD] = useState<CompanyDraft | null>(null)
  const ref = useReveal<HTMLDivElement>(!!company)
  useEffect(() => { if (company && !d) setD(draftFrom(company)) }, [company, d])
  const dirty = !!(d && company && JSON.stringify(draftToBody(d)) !== JSON.stringify(draftToBody(draftFrom(company))))
  const save = async () => {
    try { await update.mutateAsync(draftToBody(d!)); toast('Company profile saved') } catch (e) { toast(errMsg(e), 'error') }
  }
  return (
    <div ref={ref}>
      <PageHeader title="Company profile" sub={company ? <>Workspace address <code style={{ background: 'var(--well)', padding: '2px 8px', borderRadius: 8 }}>{company.slug}</code></> : ' '}
        actions={<>
          {dirty && <button className="btn btn-ghost" onClick={() => setD(draftFrom(company))}>Discard</button>}
          <button className="btn btn-primary" disabled={!dirty || update.isPending || !d?.name.trim()} onClick={save}>{update.isPending ? 'Saving…' : 'Save changes'}</button>
        </>} />
      {!d ? <div className="skeleton" style={{ height: 360, borderRadius: 'var(--r-card)' }} /> : (
        <section data-card className="card" style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 20 }}>
          <LogoPicker name={d.name} value={d.logoUrl} onChange={(v) => setD({ ...d, logoUrl: v })} />
          <CompanyFields draft={d} set={(p) => setD({ ...d, ...p })} />
        </section>
      )}
      {company && <ContactCard company={company} />}
      {company && <MenuCard company={company} />}
      {d && <EntitiesSection country={d.primaryCountry} currency={d.baseCurrency} />}
    </div>
  )
}

// Address and contacts: printed on payslips under the company name
function ContactCard({ company }: { company: any }) {
  const { update } = useCompanyWrite()
  const toast = useToast()
  const from = () => ({ address: company.address ?? '', poBox: company.poBox ?? '', phone: company.phone ?? '', mobile: company.mobile ?? '', contactEmail: company.contactEmail ?? '', website: company.website ?? '' })
  const [f, setF] = useState(from)
  useEffect(() => setF(from()), [company.address, company.poBox, company.phone, company.mobile, company.contactEmail, company.website]) // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = JSON.stringify(f) !== JSON.stringify(from())
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value })
  const save = async () => {
    try { await update.mutateAsync(Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.trim() || null]))); toast('Address and contacts saved') } catch (e) { toast(errMsg(e), 'error') }
  }
  return (
    <section data-card className="card" style={{ padding: 24, display: 'grid', gap: 14, marginTop: 'var(--gap)' }}>
      <div><h2 style={{ fontSize: 18 }}>Address and contacts</h2><p className="dim" style={{ fontSize: 13, marginTop: 2 }}>Printed on every payslip under the company name.</p></div>
      <label className="field"><span>Address</span><textarea className="input" rows={2} maxLength={240} value={f.address} onChange={set('address')} placeholder="Plot 1633 Malambo Road, Light Industrial Area, Lusaka, Zambia" /></label>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
        <label className="field"><span>P.O. Box</span><input className="input" maxLength={40} value={f.poBox} onChange={set('poBox')} /></label>
        <label className="field"><span>Telephone</span><input className="input" maxLength={40} value={f.phone} onChange={set('phone')} /></label>
        <label className="field"><span>Mobile</span><input className="input" maxLength={40} value={f.mobile} onChange={set('mobile')} /></label>
        <label className="field"><span>Email</span><input className="input" type="email" maxLength={120} value={f.contactEmail} onChange={set('contactEmail')} /></label>
        <label className="field"><span>Website</span><input className="input" maxLength={120} value={f.website} onChange={set('website')} /></label>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn btn-primary" disabled={!dirty || update.isPending} onClick={save}>{update.isPending ? 'Saving…' : 'Save address and contacts'}</button>
        {dirty && <button className="btn btn-ghost" onClick={() => setF(from())}>Discard</button>}
      </div>
    </section>
  )
}

// Menu: hide the always-on pages a company does not use, so people see only what matters to them. Hidden pages are only left out of the menu.
function MenuCard({ company }: { company: any }) {
  const { update } = useCompanyWrite()
  const { hasRole } = useAuth()
  const toast = useToast()
  const hidden: string[] = company.hiddenNav ?? []
  const [sel, setSel] = useState<string[]>(hidden)
  useEffect(() => setSel(company.hiddenNav ?? []), [JSON.stringify(company.hiddenNav ?? [])]) // eslint-disable-line react-hooks/exhaustive-deps
  const items = ALL_ITEMS.filter((i) => HIDEABLE.includes(i.path))
  const dirty = JSON.stringify([...sel].sort()) !== JSON.stringify([...hidden].sort())
  const canEdit = hasRole('system_admin') || hasRole('hr_admin')
  const toggle = (p: string) => setSel(sel.includes(p) ? sel.filter((x) => x !== p) : [...sel, p])
  const save = async () => { try { await update.mutateAsync({ hiddenNav: sel }); toast('Menu saved') } catch (e) { toast(errMsg(e), 'error') } }
  return (
    <section data-card className="card" style={{ padding: 24, display: 'grid', gap: 12, marginTop: 'var(--gap)' }}>
      <div><h2 style={{ fontSize: 18 }}>Menu</h2><p className="dim" style={{ fontSize: 13, marginTop: 2 }}>Tick the pages your company does not use and they disappear from everyone's menu. The pages stay available if someone opens their address, and you can bring them back any time.</p></div>
      <div className="chips" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {items.map((i) => <button key={i.path} type="button" className={`chip${sel.includes(i.path) ? ' is-on' : ''}`} aria-pressed={sel.includes(i.path)} disabled={!canEdit} onClick={() => toggle(i.path)}>{sel.includes(i.path) ? 'Hidden: ' : ''}{i.label}</button>)}
      </div>
      {canEdit && <div style={{ display: 'flex', gap: 8 }}><button className="btn btn-primary" disabled={!dirty || update.isPending} onClick={save}>{update.isPending ? 'Saving…' : 'Save menu'}</button>{dirty && <button className="btn btn-ghost" onClick={() => setSel(hidden)}>Discard</button>}</div>}
    </section>
  )
}

export function AppsSettingsPage() {
  const { user, hasRole } = useAuth()
  const { setApps } = useCompanyWrite()
  const toast = useToast()
  const installed = (user?.tenant?.modules ?? []) as AppKey[]
  const [sel, setSel] = useState<AppKey[]>(installed)
  const ref = useReveal<HTMLDivElement>()
  const canEdit = hasRole('system_admin')
  const removed = installed.filter((k) => !sel.includes(k))
  const dirty = JSON.stringify([...sel].sort()) !== JSON.stringify([...installed].sort())
  const save = async () => {
    if (removed.length && !window.confirm(`Remove ${removed.map((k) => APPS.find((a) => a.key === k)?.name).join(', ')}? People lose access to it; its data is kept and comes back if you add it again.`)) return
    try { await setApps.mutateAsync(sel); toast('Apps updated') } catch (e) { toast(errMsg(e), 'error') }
  }
  return (
    <div ref={ref}>
      <PageHeader title="Apps" sub={canEdit ? 'Add or remove apps for the whole company. Removing an app hides it; its data is kept.' : 'Apps installed for your company. A system admin can change them.'}
        actions={canEdit ? <button className="btn btn-primary" disabled={!dirty || setApps.isPending} onClick={save}>{setApps.isPending ? 'Saving…' : 'Save apps'}</button> : undefined} />
      <div style={{ pointerEvents: canEdit ? 'auto' : 'none', opacity: canEdit ? 1 : 0.85 }}>
        <AppPicker value={sel} onChange={setSel} />
      </div>
    </div>
  )
}
