interface Props { title: string }

export default function PlaceholderPage({ title }: Props) {
  return (
    <div style={{ padding: '40px', textAlign: 'center', color: '#5c5c58', fontFamily: '-apple-system, sans-serif' }}>
      <div style={{ fontSize: '32px', marginBottom: '12px' }}>🚧</div>
      <div style={{ fontSize: '18px', fontWeight: '500', color: '#1a1a18', marginBottom: '8px' }}>{title}</div>
      <div style={{ fontSize: '14px' }}>This module is coming in the next prompt.</div>
    </div>
  )
}
