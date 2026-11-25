import { useState } from 'react'
import { useAddSkill, useRemoveSkill, useAddResumeLine, useRemoveResumeLine, useSkillTypes } from '../../lib/hooks/useEmployees'
import { useToast } from '../../components/ui/Toast'

// Skills and resume of a person. HR edits anyone's; a person edits their own.
const errMsg = (e: any) => e?.response?.data?.message || 'Something went wrong'
const month = (d?: string | null) => (d ? new Date(d).toLocaleDateString(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' }) : '')
const LINE_TYPES: [string, string][] = [['experience', 'Experience'], ['education', 'Education'], ['certification', 'Certification'], ['award', 'Award']]

export function SkillsTab({ employee, canEdit }: { employee: any; canEdit: boolean }) {
  const toast = useToast()
  const { data: types = [] } = useSkillTypes()
  const add = useAddSkill(employee.id)
  const remove = useRemoveSkill(employee.id)
  const [skillId, setSkillId] = useState('')
  const [levelId, setLevelId] = useState('')
  const [why, setWhy] = useState('')
  const all = (types as any[]).flatMap((t) => (t.skills ?? []).map((s: any) => ({ ...s, typeName: t.name })))
  const chosen = all.find((s) => s.id === skillId)
  const have = new Set((employee.skills ?? []).map((x: any) => x.skillId ?? x.skill?.id))
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    try { await add.mutateAsync({ skillId, ...(levelId && { skillLevelId: levelId }), ...(why.trim() && { justification: why.trim() }) }); setSkillId(''); setLevelId(''); setWhy(''); toast('Skill added') } catch (err) { toast(errMsg(err), 'error') }
  }
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {employee.skills?.length === 0 ? <p className="dim">No skills added yet.</p> : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 10 }}>
          {employee.skills?.map((es: any) => (
            <div key={es.id} className="well" style={{ padding: 12, display: 'grid', gap: 4 }}>
              <span className="dim" style={{ fontSize: 11 }}>{es.skill?.skillType?.name}</span>
              <strong style={{ fontWeight: 500 }}>{es.skill?.name}</strong>
              {es.skillLevel && <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}><span style={{ flex: 1, height: 4, background: 'var(--line)', borderRadius: 2, overflow: 'hidden' }}><span style={{ display: 'block', height: '100%', width: `${es.skillLevel.progressPct}%`, background: 'var(--brand)' }} /></span><span className="dim" style={{ fontSize: 11 }}>{es.skillLevel.levelName}</span></span>}
              {canEdit && <button type="button" className="link" style={{ justifySelf: 'start', fontSize: 12 }} disabled={remove.isPending} onClick={() => remove.mutate(es.id, { onError: (err) => toast(errMsg(err), 'error') })}>Remove</button>}
            </div>
          ))}
        </div>
      )}
      {canEdit && (
        all.length === 0 ? <p className="dim" style={{ fontSize: 13 }}>No skills are set up yet. HR adds the skill list first.</p> : (
          <form onSubmit={submit} className="well" style={{ padding: 14, display: 'grid', gap: 10 }}>
            <strong style={{ fontWeight: 600, fontSize: 14 }}>Add a skill</strong>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
              <label className="field"><span>Skill</span>
                <select className="input select" value={skillId} onChange={(e) => { setSkillId(e.target.value); setLevelId('') }} required>
                  <option value="">Choose…</option>
                  {(types as any[]).map((t) => <optgroup key={t.id} label={t.name}>{(t.skills ?? []).filter((s: any) => !have.has(s.id)).map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}</optgroup>)}
                </select></label>
              <label className="field"><span>Level</span>
                <select className="input select" value={levelId} onChange={(e) => setLevelId(e.target.value)} disabled={!chosen?.levels?.length}>
                  <option value="">Not set</option>{(chosen?.levels ?? []).map((l: any) => <option key={l.id} value={l.id}>{l.levelName}</option>)}
                </select></label>
            </div>
            <label className="field"><span>Note (optional)</span><input className="input" maxLength={200} value={why} onChange={(e) => setWhy(e.target.value)} placeholder="Where it was used or learned" /></label>
            <div><button className="btn btn-primary btn-sm" disabled={!skillId || add.isPending}>{add.isPending ? 'Adding…' : 'Add skill'}</button></div>
          </form>
        )
      )}
    </div>
  )
}

export function ResumeTab({ employee, canEdit }: { employee: any; canEdit: boolean }) {
  const toast = useToast()
  const add = useAddResumeLine(employee.id)
  const remove = useRemoveResumeLine(employee.id)
  const blank = { lineType: 'experience', name: '', organisation: '', dateStart: '', dateEnd: '', description: '' }
  const [f, setF] = useState(blank)
  const bad = !!(f.dateStart && f.dateEnd && f.dateEnd < f.dateStart)
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (bad) return toast('The end date is before the start date', 'error')
    try {
      await add.mutateAsync({ lineType: f.lineType, name: f.name.trim(), ...(f.organisation.trim() && { organisation: f.organisation.trim() }), ...(f.dateStart && { dateStart: f.dateStart }), ...(f.dateEnd && { dateEnd: f.dateEnd }), ...(f.description.trim() && { description: f.description.trim() }) })
      setF(blank); toast('Added to the resume')
    } catch (err) { toast(errMsg(err), 'error') }
  }
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {employee.resumeLines?.length === 0 ? <p className="dim">No resume lines added yet.</p> : (
        <div style={{ display: 'grid', gap: 10 }}>
          {employee.resumeLines?.map((line: any) => (
            <div key={line.id} className="well" style={{ padding: 14, display: 'grid', gap: 2 }}>
              <span className="dim" style={{ fontSize: 11, textTransform: 'capitalize' }}>{line.lineType}</span>
              <strong style={{ fontWeight: 500 }}>{line.name}</strong>
              {line.organisation && <span className="dim" style={{ fontSize: 13 }}>{line.organisation}</span>}
              {(line.dateStart || line.dateEnd) && <span className="dim" style={{ fontSize: 12 }}>{month(line.dateStart)}{line.dateEnd ? ` → ${month(line.dateEnd)}` : line.dateStart ? ' → Present' : ''}</span>}
              {line.description && <span style={{ fontSize: 12, marginTop: 4 }}>{line.description}</span>}
              {canEdit && <button type="button" className="link" style={{ justifySelf: 'start', fontSize: 12, marginTop: 4 }} disabled={remove.isPending} onClick={() => remove.mutate(line.id, { onError: (err) => toast(errMsg(err), 'error') })}>Remove</button>}
            </div>
          ))}
        </div>
      )}
      {canEdit && (
        <form onSubmit={submit} className="well" style={{ padding: 14, display: 'grid', gap: 10 }}>
          <strong style={{ fontWeight: 600, fontSize: 14 }}>Add to the resume</strong>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
            <label className="field"><span>Kind</span><select className="input select" value={f.lineType} onChange={(e) => setF({ ...f, lineType: e.target.value })}>{LINE_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
            <label className="field"><span>Title</span><input className="input" required maxLength={160} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
            <label className="field"><span>Organisation</span><input className="input" maxLength={160} value={f.organisation} onChange={(e) => setF({ ...f, organisation: e.target.value })} /></label>
            <label className="field"><span>From</span><input className="input" type="date" value={f.dateStart} onChange={(e) => setF({ ...f, dateStart: e.target.value })} /></label>
            <label className="field"><span>To (blank = now)</span><input className="input" type="date" min={f.dateStart || undefined} value={f.dateEnd} onChange={(e) => setF({ ...f, dateEnd: e.target.value })} /></label>
          </div>
          <label className="field"><span>Details (optional)</span><textarea className="input" rows={2} maxLength={1000} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></label>
          {bad && <span role="alert" style={{ color: 'var(--danger)', fontSize: 13 }}>The end date is before the start date.</span>}
          <div><button className="btn btn-primary btn-sm" disabled={!f.name.trim() || bad || add.isPending}>{add.isPending ? 'Adding…' : 'Add line'}</button></div>
        </form>
      )}
    </div>
  )
}
