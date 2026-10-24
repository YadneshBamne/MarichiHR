import { LANGS, setLang, useLang, type Lang } from '../lib/i18n'
import api from '../lib/api'
import Icon from './ui/Icon'

// Interface language: applies at once; when signed in it is also saved for the person (follows them to other devices)
export default function LanguagePicker({ signedIn = false }: { signedIn?: boolean; compact?: boolean }) {
  const lang = useLang()
  return (
    <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 13 }} data-no-i18n>
      <Icon name="globe" size={14} />
      <select className="input" aria-label="Language" value={lang} style={{ height: 30, width: 'auto', fontSize: 13, padding: '0 8px' }}
        onChange={(e) => { const l = e.target.value as Lang; setLang(l); if (signedIn) api.put('/auth/me/locale', { locale: l }).catch(() => null) }}>
        {Object.entries(LANGS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
      </select>
    </label>
  )
}
