import { useEffect, useState } from 'react'
import { useAuth } from '../../contexts/AuthContext'
import { useCompany, useCompanyWrite } from '../../lib/hooks/useCompany'
import { useReveal } from '../../lib/motion'
import { useToast } from '../../components/ui/Toast'
import { APPS, type AppKey } from '../../lib/apps'
import PageHeader from '../../components/ui/PageHeader'
import { AppPicker, CompanyFields, LogoPicker, draftFrom, draftToBody, type CompanyDraft } from '../../components/company/CompanyParts'

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
    </div>
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
