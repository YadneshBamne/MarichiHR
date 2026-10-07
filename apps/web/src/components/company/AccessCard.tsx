import { useEffect, useState } from 'react'
import { useAuth } from '../../contexts/AuthContext'
import { useEmployeeAccess, useSetEmployeeAccess, ROLE_INFO } from '../../lib/hooks/useCompany'
import { useToast } from '../ui/Toast'
import Icon from '../ui/Icon'

const errMsg = (e: any) => e?.response?.data?.message || 'Something went wrong'

// Who can sign in and with which roles. HR issues a temporary password that the person must change at first sign-in.
export function TemporaryPassword({ email, password, workspace }: { email: string; password: string; workspace?: string }) {
  const toast = useToast()
  const text = `Sign in at ${window.location.origin}/login\nEmail: ${email}\nTemporary password: ${password}${workspace ? `\nOrganisation: ${workspace}` : ''}\nYou'll be asked to choose your own password.`
  return (
    <div role="status" style={{ background: 'var(--night)', color: 'var(--night-ink)', borderRadius: 18, padding: 16 }}>
      <div style={{ fontSize: 12, color: 'var(--night-dim)' }}>Temporary password for {email}. It's shown only once.</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
        <code style={{ fontSize: 20, letterSpacing: '.04em', color: 'var(--honey)', flex: 1, wordBreak: 'break-all' }}>{password}</code>
        <button type="button" className="btn btn-honey btn-sm" onClick={() => navigator.clipboard.writeText(text).then(() => toast('Sign-in details copied'), () => toast('Copy failed; select the text instead', 'error'))}>Copy sign-in details</button>
      </div>
    </div>
  )
}

export default function AccessCard({ employeeId, isSelf }: { employeeId: string; isSelf: boolean }) {
  const { hasRole, user } = useAuth()
  const toast = useToast()
  const isSys = hasRole('system_admin')
  const { data: access, isLoading } = useEmployeeAccess(employeeId)
  const save = useSetEmployeeAccess(employeeId)
  const [roles, setRoles] = useState<string[]>([])
  const [issued, setIssued] = useState<string | null>(null)
  useEffect(() => { if (access) setRoles(access.roles) }, [access])

  if (isLoading || !access) return <div className="skeleton" style={{ height: 160, borderRadius: 'var(--r-card)' }} />
  const dirty = JSON.stringify([...roles].sort()) !== JSON.stringify([...access.roles].sort())
  const run = async (body: any, msg: string) => {
    try {
      const r = await save.mutateAsync(body)
      if (r.temporaryPassword) setIssued(r.temporaryPassword)
      toast(msg)
    } catch (e) { toast(errMsg(e), 'error') }
  }

  return (
    <section className="card" style={{ padding: 22 }} data-card>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <h2 style={{ fontSize: 22, flex: 1 }}>Login & access</h2>
        <span className={`pill ${access.loginEnabled ? 'ok' : 'mute'}`}>{access.loginEnabled ? 'Can sign in' : access.active ? 'No password yet' : 'Login disabled'}</span>
        {access.mustChangePassword && <span className="pill warn">Must set own password</span>}
        {access.mfaEnabled && <span className="pill info">2FA on</span>}
        {access.googleLinked && <span className="pill mute">Google linked</span>}
      </div>
      <p className="dim" style={{ fontSize: 13, marginTop: 4 }}>Signs in as <strong>{access.email}</strong>{access.lastLoginAt ? ` · last sign-in ${new Date(access.lastLoginAt).toLocaleString()}` : ' · never signed in'}</p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 8, marginTop: 16 }}>
        <label className="well" style={{ display: 'flex', gap: 10, padding: 12, opacity: 0.8 }}>
          <input type="checkbox" checked disabled /> <span><strong style={{ fontWeight: 500 }}>Employee</strong><br /><span className="dim" style={{ fontSize: 12 }}>Self-service: leave, attendance, payslips, expenses</span></span>
        </label>
        {ROLE_INFO.map((r) => {
          const locked = (r.sysOnly && !isSys) || (isSelf && ['hr_admin', 'system_admin'].includes(r.name) && access.roles.includes(r.name))
          return (
            <label key={r.name} className="well" style={{ display: 'flex', gap: 10, padding: 12, cursor: locked ? 'not-allowed' : 'pointer', opacity: locked ? 0.6 : 1, border: roles.includes(r.name) ? '1px solid var(--night)' : '1px solid transparent' }} title={locked ? (isSelf ? 'You cannot remove your own admin access' : 'Only a system admin can change this') : undefined}>
              <input type="checkbox" disabled={locked} checked={roles.includes(r.name)} onChange={(e) => setRoles(e.target.checked ? [...roles, r.name] : roles.filter((x) => x !== r.name))} />
              <span><strong style={{ fontWeight: 500 }}>{r.label}</strong><br /><span className="dim" style={{ fontSize: 12 }}>{r.hint}</span></span>
            </label>
          )
        })}
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
        <button className="btn btn-primary" disabled={!dirty || save.isPending} onClick={() => run({ roles }, 'Roles updated. They take effect at the next sign-in.')}>Save roles</button>
        {!isSelf && <button className="btn btn-ghost" disabled={save.isPending} onClick={() => run({ password: 'generate', loginEnabled: true }, 'Temporary password created')}><Icon name="key" size={15} /> {access.hasPassword ? 'Reset password' : 'Create login'}</button>}
        {!isSelf && access.active && access.hasPassword && <button className="btn btn-danger" disabled={save.isPending} onClick={() => run({ loginEnabled: false }, 'Login disabled and sessions ended')}>Disable login</button>}
        {!isSelf && !access.active && <button className="btn btn-ghost" disabled={save.isPending} onClick={() => run({ loginEnabled: true }, 'Login enabled')}>Enable login</button>}
      </div>
      {issued && <div style={{ marginTop: 14 }}><TemporaryPassword email={access.email} password={issued} workspace={user?.tenant?.slug} /></div>}
    </section>
  )
}
