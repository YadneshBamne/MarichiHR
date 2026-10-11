import { useMasters } from '../../lib/hooks/useMasters'

// A dropdown fed by one of the company's master lists. A stored value that has since been retired (or typed before
// masters existed) still shows, so editing a record never silently changes it.
interface Props {
  list: string
  value: string
  onChange: (code: string) => void
  id?: string
  placeholder?: string // shown as an empty first option; omit to require a choice
  required?: boolean
  className?: string
  style?: React.CSSProperties
}

export default function MasterSelect({ list, value, onChange, id, placeholder, required, className = 'input select', style }: Props) {
  const { values, isLoading } = useMasters()
  const options = values(list)
  const orphan = value && !options.some((o) => o.code === value)
  return (
    <select id={id} className={className} style={style} value={value} required={required} disabled={isLoading} onChange={(e) => onChange(e.target.value)}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {orphan && <option value={value}>{value} (not in list)</option>}
      {options.map((o) => <option key={o.code} value={o.code}>{o.label}</option>)}
    </select>
  )
}
