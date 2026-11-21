import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import api from '../../lib/api'
import { useAuth } from '../../contexts/AuthContext'
import { useCompany, useCompanyWrite } from '../../lib/hooks/useCompany'
import { useToast } from '../../components/ui/Toast'
import PageHeader from '../../components/ui/PageHeader'

type Feature = { key: string; name: string; blurb: string; status: 'live' | 'planned' }
type Plan = { key: string; name: string; tagline: string; features: string[] }

// Plan and add-ons for this company. Billing is not built yet: a system admin picks the plan and the API applies it at once.
export default function PlanPage() {
  const { hasRole } = useAuth()
  const toast = useToast()
  const { data: company } = useCompany()
  const { setPlan } = useCompanyWrite()
  const cat = useQuery({ queryKey: ['plans'], queryFn: async () => (await api.get('/company/plans')).data.data as { plans: Plan[]; features: Feature[] } })
  const [plan, setP] = useState('growth')
  const [addons, setA] = useState<string[]>([])
  useEffect(() => { if (company) { setP(company.plan); setA(company.addons ?? []) } }, [company])
  const canEdit = hasRole('system_admin')
  if (!cat.data || !company) return <PageHeader title="Plan" sub="Loading…" />
  const cur = cat.data.plans.find((p) => p.key === plan)!
  const inPlan = (k: string) => cur.features.includes(k)
  const dirty = plan !== company.plan || JSON.stringify([...addons].sort()) !== JSON.stringify([...(company.addons ?? [])].sort())
  const save = async () => { try { await setPlan.mutateAsync({ plan, addons: addons.filter((a) => !inPlan(a)) }); toast('Plan updated') } catch (e: any) { toast(e?.response?.data?.message || 'Could not change the plan', 'error') } }
  return (
    <div>
      <PageHeader title="Plan" sub={canEdit ? 'Pick a plan and add what you need on top. Apps that fall outside the plan are switched off; their data is kept.' : 'Your company plan. A system admin can change it.'}
        actions={canEdit ? <button className="btn btn-primary" disabled={!dirty || setPlan.isPending} onClick={save}>{setPlan.isPending ? 'Saving…' : 'Save plan'}</button> : undefined} />
      <div className="chips" role="radiogroup" aria-label="Plan" style={{ marginBottom: 20 }}>
        {cat.data.plans.map((p) => (
          <button key={p.key} type="button" role="radio" aria-checked={plan === p.key} disabled={!canEdit} className={`chip${plan === p.key ? ' is-on' : ''}`} onClick={() => setP(p.key)}>{p.name}</button>
        ))}
      </div>
      <p style={{ margin: '0 0 16px', color: 'var(--muted, #5c5a54)' }}>{cur.tagline}</p>
      <div className="card" style={{ padding: 8 }}>
        {cat.data.features.map((f) => {
          const included = inPlan(f.key), added = addons.includes(f.key)
          return (
            <div key={f.key} style={{ display: 'flex', gap: 14, alignItems: 'center', padding: '12px 14px', borderBottom: '1px solid var(--line-2)' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{f.name} {f.status === 'planned' && <span className="pill mute">coming soon</span>}</div>
                <div style={{ fontSize: 13, color: 'var(--muted, #5c5a54)' }}>{f.blurb}</div>
              </div>
              {included ? <span className="pill ok">In plan</span> : (
                <label style={{ display: 'flex', gap: 8, alignItems: 'center', minHeight: 44 }}>
                  <input type="checkbox" checked={added} disabled={!canEdit} onChange={(e) => setA(e.target.checked ? [...addons, f.key] : addons.filter((a) => a !== f.key))} /> Add-on
                </label>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
