import { useState } from 'react'
import { useStructures, useStructureTypes, useRuleCategories, useSalaryWrite, checkRule, errMsg } from '../../lib/hooks/useSalary'
import Modal from '../../components/ui/Modal'
import { FormField, inputStyle, selectStyle } from '../../components/ui/FormField'
import { card, th, td, empty, primaryBtn, ghostBtn, linkBtn, errorBox, grid2, footer } from './styles'

const mono: React.CSSProperties = { ...inputStyle, fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: 12 }

function describe(r: any): string {
  if (r.amountType === 'fixed') return `Fixed ${r.amountFixed ?? 0}`
  if (r.amountType === 'percentage') return `${(r.amountPercentage ?? 0) * 100}% of ${r.amountPercentageBase}`
  return r.pythonCode || ''
}

export default function StructuresTab({ canEdit }: { canEdit: boolean }) {
  const { data: structures = [], isLoading } = useStructures()
  const write = useSalaryWrite()
  const [selectedId, setSelectedId] = useState<string>('')
  const [structureForm, setStructureForm] = useState<any>(null)
  const [ruleForm, setRuleForm] = useState<any>(null)
  const [error, setError] = useState('')

  const selected = structures.find((s: any) => s.id === selectedId) ?? structures[0]

  const removeRule = async (id: string) => {
    setError('')
    try { await write.mutateAsync({ method: 'delete', path: `/salary/rules/${id}` }) } catch (err) { setError(errMsg(err)) }
  }
  const archiveStructure = async (id: string) => {
    setError('')
    try { await write.mutateAsync({ method: 'patch', path: `/salary/structures/${id}`, body: { active: false } }); setSelectedId('') } catch (err) { setError(errMsg(err)) }
  }

  if (isLoading) return <div style={empty}>Loading...</div>

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(180px, 240px) minmax(0, 1fr)', gap: 16, alignItems: 'start' }}>
      <div style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px', borderBottom: '1px solid var(--line)', backgroundColor: 'var(--solid)' }}>
          <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--faint)' }}>Structures</span>
          {canEdit && <button style={linkBtn} onClick={() => setStructureForm({ structureTypeId: '', name: '', code: '', countryCode: '', description: '' })}>+ New</button>}
        </div>
        {structures.length === 0 ? <div style={empty}>None yet.</div> : structures.map((s: any) => (
          <button key={s.id} onClick={() => setSelectedId(s.id)} style={{ display: 'block', width: '100%', textAlign: 'left', padding: '10px 14px', border: 'none', borderBottom: '1px solid var(--well)', borderLeft: `2px solid ${selected?.id === s.id ? 'var(--brand)' : 'transparent'}`, backgroundColor: selected?.id === s.id ? 'var(--honey-soft)' : 'var(--card-2)', cursor: 'pointer' }}>
            <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--ink)' }}>{s.name}</div>
            <div style={{ fontSize: 11, color: 'var(--faint)' }}>{s.code} · {s.structureType?.name}{s.countryCode ? ` · ${s.countryCode}` : ''} · {s._count?.contracts ?? 0} contract(s)</div>
          </button>
        ))}
      </div>

      <div>
        {selected && (
          <div style={{ ...card, overflowX: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: '14px 16px', borderBottom: '1px solid var(--line)' }}>
              <div>
                <div style={{ fontSize: 15, fontWeight: 500 }}>{selected.name} <span style={{ fontSize: 12, color: 'var(--faint)', fontWeight: 400 }}>{selected.code}</span></div>
                {selected.description && <div style={{ fontSize: 12, color: 'var(--faint)', marginTop: 2 }}>{selected.description}</div>}
              </div>
              {canEdit && (
                <div style={{ display: 'flex', gap: 6 }}>
                  <button style={linkBtn} onClick={() => setStructureForm({ id: selected.id, structureTypeId: selected.structureType?.id, name: selected.name, code: selected.code, countryCode: selected.countryCode || '', description: selected.description || '' })}>Edit</button>
                  <button style={{ ...linkBtn, color: 'var(--danger)' }} onClick={() => archiveStructure(selected.id)}>Archive</button>
                  <button style={{ ...primaryBtn, padding: '7px 14px' }} onClick={() => setRuleForm({ salaryStructureId: selected.id, categoryId: '', name: '', code: '', sequence: (Math.max(0, ...selected.rules.map((r: any) => r.sequence)) + 10), amountType: 'python_code', amountFixed: '', amountPercentage: '', amountPercentageBase: '', pythonCode: 'result = ', conditionSelect: 'always', conditionExpr: '', appearsOnPayslip: true })}>+ Rule</button>
                </div>
              )}
            </div>
            {selected.rules.length === 0 ? <div style={empty}>No rules yet. Add BASIC, GROSS and NET first.</div> : (
              <table style={{ width: '100%', minWidth: 640, borderCollapse: 'collapse' }}>
                <thead><tr>{['Seq', 'Code', 'Name', 'Category', 'Amount', ''].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
                <tbody>
                  {selected.rules.map((r: any) => (
                    <tr key={r.id}>
                      <td style={{ ...td, color: 'var(--faint)' }}>{r.sequence}</td>
                      <td style={{ ...td, fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12 }}>{r.code}</td>
                      <td style={td}>{r.name}{!r.appearsOnPayslip && <span style={{ fontSize: 11, color: 'var(--faint)' }}> (hidden)</span>}</td>
                      <td style={td}>{r.category?.code}</td>
                      <td style={{ ...td, fontFamily: r.amountType === 'python_code' ? 'ui-monospace, Consolas, monospace' : undefined, fontSize: 12, minWidth: 200, overflowWrap: 'anywhere' }}>
                        {describe(r)}{r.conditionSelect === 'python_expression' && <div style={{ color: 'var(--warn)' }}>if {r.conditionExpr}</div>}
                      </td>
                      <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                        {canEdit && <><button style={linkBtn} onClick={() => setRuleForm({ ...r, id: r.id, salaryStructureId: selected.id, amountFixed: r.amountFixed ?? '', amountPercentage: r.amountPercentage ?? '', amountPercentageBase: r.amountPercentageBase ?? '', pythonCode: r.pythonCode ?? '', conditionExpr: r.conditionExpr ?? '' })}>Edit</button><button style={{ ...linkBtn, color: 'var(--danger)' }} onClick={() => removeRule(r.id)}>Remove</button></>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
        {error && <div style={errorBox}>{error}</div>}
      </div>

      {structureForm && <StructureModal form={structureForm} onClose={() => setStructureForm(null)} onSaved={(id) => { setStructureForm(null); setSelectedId(id) }} />}
      {ruleForm && <RuleModal form={ruleForm} onClose={() => setRuleForm(null)} />}
    </div>
  )
}

function StructureModal({ form: initial, onClose, onSaved }: { form: any; onClose: () => void; onSaved: (id: string) => void }) {
  const { data: types = [] } = useStructureTypes()
  const write = useSalaryWrite()
  const [f, setF] = useState(initial)
  const [error, setError] = useState('')
  const set = (k: string, v: string) => setF((p: any) => ({ ...p, [k]: v }))

  const save = async () => {
    setError('')
    try {
      const body: any = { structureTypeId: f.structureTypeId, name: f.name.trim(), description: f.description.trim() || (f.id ? null : undefined), countryCode: f.countryCode.trim().toUpperCase() || (f.id ? null : undefined) }
      const res = f.id
        ? await write.mutateAsync({ method: 'patch', path: `/salary/structures/${f.id}`, body })
        : await write.mutateAsync({ method: 'post', path: '/salary/structures', body: { ...body, code: f.code.trim().toUpperCase() } })
      onSaved(res.id)
    } catch (err) { setError(errMsg(err)) }
  }

  return (
    <Modal open onClose={onClose} title={f.id ? 'Edit structure' : 'New salary structure'} width={520}>
      <div style={grid2}>
        <FormField label="Name" required><input style={inputStyle} value={f.name} onChange={(e) => set('name', e.target.value)} /></FormField>
        <FormField label="Code" required><input style={inputStyle} value={f.code} disabled={!!f.id} placeholder="ZM-STD" onChange={(e) => set('code', e.target.value)} /></FormField>
        <FormField label="Structure type" required>
          <select style={selectStyle} value={f.structureTypeId} onChange={(e) => set('structureTypeId', e.target.value)}>
            <option value="">Select type</option>
            {types.map((t: any) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </FormField>
        <FormField label="Country"><input style={inputStyle} value={f.countryCode} maxLength={2} placeholder="ZM" onChange={(e) => set('countryCode', e.target.value)} /></FormField>
        <FormField label="Description" style={{ gridColumn: '1 / -1' }}><input style={inputStyle} value={f.description} onChange={(e) => set('description', e.target.value)} /></FormField>
      </div>
      {error && <div style={errorBox}>{error}</div>}
      <div style={footer}><button style={ghostBtn} onClick={onClose}>Cancel</button><button style={primaryBtn} disabled={!f.name.trim() || !f.code.trim() || !f.structureTypeId || write.isPending} onClick={save}>Save</button></div>
    </Modal>
  )
}

function RuleModal({ form: initial, onClose }: { form: any; onClose: () => void }) {
  const { data: categories = [] } = useRuleCategories()
  const write = useSalaryWrite()
  const [f, setF] = useState(initial)
  const [sampleWage, setSampleWage] = useState('10000')
  const [test, setTest] = useState<any>(null)
  const [error, setError] = useState('')
  const set = (k: string, v: unknown) => { setF((p: any) => ({ ...p, [k]: v })); setTest(null) }

  const num = (v: any) => (v === '' || v == null ? null : Number(v))
  const ruleBody = () => ({
    categoryId: f.categoryId, name: f.name.trim(), code: f.code.trim().toUpperCase(), sequence: Number(f.sequence), amountType: f.amountType,
    amountFixed: f.amountType === 'fixed' ? num(f.amountFixed) : null,
    amountPercentage: f.amountType === 'percentage' ? num(f.amountPercentage) : null,
    amountPercentageBase: f.amountType === 'percentage' ? f.amountPercentageBase.trim() || null : null,
    pythonCode: f.amountType === 'python_code' ? f.pythonCode : null,
    conditionSelect: f.conditionSelect,
    conditionExpr: f.conditionSelect === 'python_expression' ? f.conditionExpr : null,
    appearsOnPayslip: !!f.appearsOnPayslip,
  })

  const runTest = async () => {
    setError('')
    setTest(null)
    try {
      setTest(await checkRule({ salaryStructureId: f.salaryStructureId, ...(f.id && { ruleId: f.id }), sampleWage: Number(sampleWage) || 10000, rule: ruleBody() }))
    } catch (err) { setError(errMsg(err, 'Formula check failed')) }
  }

  const save = async () => {
    setError('')
    try {
      await write.mutateAsync(f.id
        ? { method: 'patch', path: `/salary/rules/${f.id}`, body: ruleBody() }
        : { method: 'post', path: '/salary/rules', body: { salaryStructureId: f.salaryStructureId, ...ruleBody() } })
      onClose()
    } catch (err) { setError(errMsg(err)) }
  }

  const ready = f.categoryId && f.name.trim() && f.code.trim() && f.sequence !== ''

  return (
    <Modal open onClose={onClose} title={f.id ? `Edit rule ${f.code}` : 'New salary rule'} width={680}>
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1.4fr', gap: 12 }}>
        <FormField label="Name" required><input style={inputStyle} value={f.name} onChange={(e) => set('name', e.target.value)} /></FormField>
        <FormField label="Code" required><input style={inputStyle} value={f.code} placeholder="HRA" onChange={(e) => set('code', e.target.value)} /></FormField>
        <FormField label="Sequence" required><input type="number" style={inputStyle} value={f.sequence} onChange={(e) => set('sequence', e.target.value)} /></FormField>
        <FormField label="Category" required>
          <select style={selectStyle} value={f.categoryId} onChange={(e) => set('categoryId', e.target.value)}>
            <option value="">Select</option>
            {categories.map((c: any) => <option key={c.id} value={c.id}>{c.code} — {c.name}</option>)}
          </select>
        </FormField>
      </div>

      <div style={{ display: 'flex', gap: 6, margin: '16px 0 10px' }}>
        {[['python_code', 'Formula'], ['percentage', 'Percentage'], ['fixed', 'Fixed']].map(([k, label]) => (
          <button key={k} onClick={() => set('amountType', k)} style={{ padding: '6px 14px', borderRadius: 14, fontSize: 12, cursor: 'pointer', border: `1px solid ${f.amountType === k ? 'var(--brand)' : 'var(--line)'}`, backgroundColor: f.amountType === k ? 'var(--honey-soft)' : 'var(--card-2)', color: f.amountType === k ? 'var(--brand)' : 'var(--dim)' }}>{label}</button>
        ))}
      </div>

      {f.amountType === 'fixed' && <FormField label="Amount (prorated for BASIC/ALW)"><input type="number" style={inputStyle} value={f.amountFixed} onChange={(e) => set('amountFixed', e.target.value)} /></FormField>}
      {f.amountType === 'percentage' && (
        <div style={grid2}>
          <FormField label="Rate (0.2 = 20%)"><input type="number" step="0.01" style={inputStyle} value={f.amountPercentage} onChange={(e) => set('amountPercentage', e.target.value)} /></FormField>
          <FormField label="Of (earlier rule code or category)"><input style={inputStyle} value={f.amountPercentageBase} placeholder="BASIC" onChange={(e) => set('amountPercentageBase', e.target.value)} /></FormField>
        </div>
      )}
      {f.amountType === 'python_code' && (
        <FormField label="Formula">
          <textarea style={{ ...mono, minHeight: 64, resize: 'vertical' }} value={f.pythonCode} spellCheck={false} onChange={(e) => set('pythonCode', e.target.value)} />
        </FormField>
      )}

      <div style={{ ...grid2, marginTop: 12 }}>
        <FormField label="Applies">
          <select style={selectStyle} value={f.conditionSelect} onChange={(e) => set('conditionSelect', e.target.value)}>
            <option value="always">Always</option>
            <option value="python_expression">Only when condition is true</option>
          </select>
        </FormField>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginTop: 22 }}>
          <input type="checkbox" checked={!!f.appearsOnPayslip} onChange={(e) => set('appearsOnPayslip', e.target.checked)} /> Show on payslip
        </label>
      </div>
      {f.conditionSelect === 'python_expression' && (
        <FormField label="Condition" style={{ marginTop: 10 }}>
          <input style={mono} value={f.conditionExpr} placeholder="categories.GROSS > 5000" spellCheck={false} onChange={(e) => set('conditionExpr', e.target.value)} />
        </FormField>
      )}

      <div style={{ marginTop: 12, fontSize: 11, color: 'var(--faint)', lineHeight: 1.6, backgroundColor: 'var(--solid)', borderRadius: 12, padding: '8px 10px' }}>
        Available: <code>contract.wageMonthly</code> (prorated), <code>contract.fullWageMonthly</code>, <code>contract.ctcAnnual</code>, <code>categories.BASIC|ALW|GROSS|DED|TAX</code>, <code>rules.CODE</code> (earlier rules only), <code>inputs.CODE</code>, <code>payslip.paidDays|workingDays|lwpDays|factor</code>, <code>compute_zra_paye(x)</code>, <code>min</code>, <code>max</code>, <code>round</code>. Formulas run in a sandbox, never as code.
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14 }}>
        <span style={{ fontSize: 12, color: 'var(--dim)' }}>Test on monthly wage</span>
        <input type="number" style={{ ...inputStyle, width: 120 }} value={sampleWage} onChange={(e) => { setSampleWage(e.target.value); setTest(null) }} />
        <button style={ghostBtn} disabled={!ready} onClick={runTest}>Test formula</button>
      </div>
      {test && (
        <div style={{ marginTop: 10, border: '1px solid var(--honey-2)', backgroundColor: 'var(--honey-soft)', borderRadius: 12, padding: '10px 12px', fontSize: 12 }}>
          <div style={{ fontWeight: 500, color: 'var(--brand)', marginBottom: 6 }}>
            ✓ {f.code.toUpperCase()} = {test.skippedByCondition ? 'skipped (condition false)' : test.amount} · gross {test.gross} · net {test.netPay}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '2px 16px', color: 'var(--dim)' }}>
            {test.lines.map((l: any) => <div key={l.code}><span style={{ fontFamily: 'ui-monospace, Consolas, monospace' }}>{l.code}</span> {l.amount}</div>)}
          </div>
          {test.warnings?.map((w: string) => <div key={w} style={{ color: 'var(--warn)', marginTop: 4 }}>{w}</div>)}
        </div>
      )}

      {error && <div style={errorBox}>{error}</div>}
      <div style={footer}><button style={ghostBtn} onClick={onClose}>Cancel</button><button style={primaryBtn} disabled={!ready || write.isPending} onClick={save}>{write.isPending ? 'Validating...' : 'Save rule'}</button></div>
    </Modal>
  )
}
