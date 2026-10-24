import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import api from '../../lib/api'
import Modal from '../../components/ui/Modal'
import { useToast } from '../../components/ui/Toast'

// Legal entities of a group: each employs people and can run its own payroll in its own currency
type Entity = { id: string; name: string; legalName: string | null; country: string; currency: string; taxId: string | null; address: string | null; active: boolean; people: number }
const errMsg = (e: any) => e?.response?.data?.message || 'Something went wrong'

export function EntitiesSection({ country, currency }: { country?: string | null; currency?: string | null }) {
  const { data = [] } = useQuery({ queryKey: ['legal-entities'], queryFn: async () => (await api.get('/company/entities')).data.data as Entity[] })
  const [edit, setEdit] = useState<Partial<Entity> | null>(null)
  return (
    <section data-card className="card" style={{ padding: 24, display: 'grid', gap: 12, marginTop: 'var(--gap)' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}><h3 style={{ fontSize: 16, flex: 1 }}>Legal entities</h3><button className="btn btn-ghost btn-sm" onClick={() => setEdit({ country: country ?? 'ZM', currency: currency ?? 'ZMW', active: true })}>+ Entity</button></div>
      <p className="dim" style={{ fontSize: 13 }}>Only for groups with more than one registered company (for example a Zambian and a Kenyan company). Each employs its own people, set on their record, and can run its own payroll. A single company needs none.</p>
      {data.map((e) => (
        <div key={e.id} style={{ display: 'flex', gap: 10, alignItems: 'center', borderTop: '1px solid var(--line)', paddingTop: 10, flexWrap: 'wrap', opacity: e.active ? 1 : 0.55 }}>
          <span style={{ flex: 1, minWidth: 200 }}><strong style={{ fontWeight: 500 }}>{e.name}</strong> <span className="pill mute">{e.country} · {e.currency}</span><div className="dim" style={{ fontSize: 12 }}>{e.legalName ?? ''}{e.taxId ? ` · tax id ${e.taxId}` : ''} · {e.people} {e.people === 1 ? 'person' : 'people'}</div></span>
          <button className="btn btn-ghost btn-sm" onClick={() => setEdit(e)}>Edit</button>
        </div>
      ))}
      {edit && <EntityModal entity={edit} onClose={() => setEdit(null)} />}
    </section>
  )
}

function EntityModal({ entity, onClose }: { entity: Partial<Entity>; onClose: () => void }) {
  const toast = useToast()
  const qc = useQueryClient()
  const [f, setF] = useState({ name: entity.name ?? '', legalName: entity.legalName ?? '', country: entity.country ?? '', currency: entity.currency ?? '', taxId: entity.taxId ?? '', address: entity.address ?? '', active: entity.active ?? true })
  const save = useMutation({
    mutationFn: () => {
      const body = { name: f.name.trim(), legalName: f.legalName.trim() || null, country: f.country.toUpperCase(), currency: f.currency.toUpperCase(), taxId: f.taxId.trim() || null, address: f.address.trim() || null, active: f.active }
      return entity.id ? api.put(`/company/entities/${entity.id}`, body) : api.post('/company/entities', body)
    },
    onSuccess: () => { toast('Saved'); qc.invalidateQueries({ queryKey: ['legal-entities'] }); onClose() },
    onError: (e) => toast(errMsg(e), 'error'),
  })
  const field = (k: keyof typeof f, label: string, extra: object = {}) => <label className="field"><span>{label}</span><input className="input" value={String(f[k])} onChange={(e) => setF({ ...f, [k]: e.target.value })} {...extra} /></label>
  return (
    <Modal open onClose={onClose} title={entity.id ? 'Edit entity' : 'New entity'} width={560}>
      <div style={{ display: 'grid', gap: 12 }}>
        {field('name', 'Short name', { maxLength: 120, placeholder: 'e.g. Marichi Zambia' })}
        {field('legalName', 'Registered name (optional)', { maxLength: 200 })}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 2fr', gap: 8 }}>
          {field('country', 'Country', { maxLength: 2, placeholder: 'ZM' })}
          {field('currency', 'Currency', { maxLength: 3, placeholder: 'ZMW' })}
          {field('taxId', 'Tax id (TPIN, PAN, KRA PIN…)', { maxLength: 60 })}
        </div>
        {field('address', 'Address (optional)', { maxLength: 500 })}
        {entity.id && <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Active</label>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={save.isPending || f.name.trim().length < 2 || !/^[A-Za-z]{2}$/.test(f.country) || !/^[A-Za-z]{3}$/.test(f.currency)} onClick={() => save.mutate()}>Save</button></div>
      </div>
    </Modal>
  )
}
