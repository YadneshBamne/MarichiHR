import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import api from '../../lib/api'
import PageHeader from '../../components/ui/PageHeader'
import { useToast } from '../../components/ui/Toast'
import { useReveal } from '../../lib/motion'

const errMsg = (e: any) => e?.response?.data?.message || 'Something went wrong'

// Single sign-on with the company's own identity provider (OpenID Connect). The admin registers MarichiHR in the provider,
// pastes its address, client id and secret here, tests the connection, then switches it on. Nobody is created by signing in.
export default function SsoPage() {
  const toast = useToast()
  const qc = useQueryClient()
  const root = useReveal<HTMLDivElement>('sso')
  const cfg = useQuery({ queryKey: ['sso-config'], queryFn: async () => (await api.get('/sso/config')).data.data as any })
  const [f, setF] = useState({ enabled: false, issuer: '', clientId: '', clientSecret: '', allowedDomains: '', label: 'Company single sign-on', enforce: false })
  useEffect(() => { if (cfg.data) setF({ enabled: cfg.data.enabled, issuer: cfg.data.issuer, clientId: cfg.data.clientId, clientSecret: '', allowedDomains: (cfg.data.allowedDomains ?? []).join(', '), label: cfg.data.label, enforce: cfg.data.enforce }) }, [cfg.data])
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value })
  const save = useMutation({
    mutationFn: async () => (await api.put('/sso/config', { enabled: f.enabled, issuer: f.issuer.trim(), clientId: f.clientId.trim(), ...(f.clientSecret && { clientSecret: f.clientSecret }), allowedDomains: f.allowedDomains.split(/[\s,]+/).filter(Boolean), label: f.label.trim() || 'Company single sign-on', enforce: f.enforce })).data.data,
    onSuccess: () => { toast('Saved'); qc.invalidateQueries({ queryKey: ['sso-config'] }) }, onError: (e) => toast(errMsg(e), 'error'),
  })
  const test = useMutation({ mutationFn: async () => (await api.post('/sso/config/test', { issuer: f.issuer.trim() })).data.data, onSuccess: () => toast('The provider answered and has what sign-in needs'), onError: (e) => toast(errMsg(e), 'error') })
  const copy = (t: string) => navigator.clipboard?.writeText(t).then(() => toast('Copied'))
  return (
    <div ref={root}>
      <PageHeader title="Single sign-on" sub="Let people sign in with the account they already use at work (Microsoft Entra ID, Okta, Google Workspace and other OpenID Connect providers)." />
      {cfg.isError && <div className="card" style={{ padding: 20 }}>Single sign-on is not part of this plan. Open Plan to add it.</div>}
      {cfg.data && (
        <div style={{ display: 'grid', gap: 16 }}>
          <div className="card" style={{ padding: 20, display: 'grid', gap: 8 }}>
            <h2 style={{ fontSize: 17 }}>1. Register MarichiHR in your provider</h2>
            <span className="dim">Create an application of type “web” and give it this redirect address:</span>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}><code style={{ wordBreak: 'break-all' }}>{cfg.data.redirectUri}</code><button className="btn btn-ghost btn-sm" onClick={() => copy(cfg.data.redirectUri)}>Copy</button></div>
            <span className="dim" style={{ fontSize: 13 }}>Scopes: openid, email, profile. The provider gives you a client id and a client secret.</span>
          </div>
          <div className="card" style={{ padding: 20, display: 'grid', gap: 14 }}>
            <h2 style={{ fontSize: 17 }}>2. Connect</h2>
            <div className="field"><label htmlFor="sso-issuer">Provider address (issuer)</label><input id="sso-issuer" className="input" placeholder="https://login.microsoftonline.com/…/v2.0" value={f.issuer} onChange={set('issuer')} /></div>
            <div className="field"><label htmlFor="sso-cid">Client id</label><input id="sso-cid" className="input" value={f.clientId} onChange={set('clientId')} /></div>
            <div className="field"><label htmlFor="sso-sec">Client secret {cfg.data.hasSecret && <span className="dim">(saved: leave empty to keep it)</span>}</label><input id="sso-sec" className="input" type="password" autoComplete="off" value={f.clientSecret} onChange={set('clientSecret')} /></div>
            <div className="field"><label htmlFor="sso-dom">Allowed email domains (optional, separated by commas)</label><input id="sso-dom" className="input" placeholder="acme.com" value={f.allowedDomains} onChange={set('allowedDomains')} /></div>
            <div className="field"><label htmlFor="sso-label">Button text on the login page</label><input id="sso-label" className="input" maxLength={40} value={f.label} onChange={set('label')} /></div>
            <label style={{ display: 'flex', gap: 10, alignItems: 'center' }}><input type="checkbox" checked={f.enabled} onChange={set('enabled')} /> Switch single sign-on on</label>
            <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}><input type="checkbox" checked={f.enforce} disabled={!f.enabled} onChange={set('enforce')} style={{ marginTop: 4 }} />
              <span>Require it for everyone except administrators<span className="dim" style={{ display: 'block', fontSize: 13 }}>Passwords stop working for staff. Administrators keep theirs, so a provider outage never locks the company out.</span></span></label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button className="btn btn-ghost" disabled={test.isPending || !f.issuer.trim()} onClick={() => test.mutate()}>{test.isPending ? 'Testing…' : 'Test connection'}</button>
              <button className="btn btn-primary" disabled={save.isPending || !f.issuer.trim() || !f.clientId.trim()} onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : 'Save'}</button>
            </div>
          </div>
          <div className="card" style={{ padding: 20 }}>
            <h2 style={{ fontSize: 17, marginBottom: 6 }}>How it behaves</h2>
            <ul className="dim" style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 4 }}>
              <li>People are matched to their MarichiHR account by work email. Nobody is created by signing in: add the person first.</li>
              <li>Staff open the login page, enter your organisation and use the button. Their roles and access stay exactly as set in MarichiHR.</li>
              <li>If you switch it off, passwords work for everyone again.</li>
            </ul>
          </div>
        </div>
      )}
    </div>
  )
}
