import { useState } from 'react'
import { useTodayAttendance, useClockIn, useClockOut } from '../../lib/hooks/useAttendance'

export default function ClockWidget() {
  const { data: today, isLoading } = useTodayAttendance()
  const clockIn = useClockIn()
  const clockOut = useClockOut()
  const [locating, setLocating] = useState(false)

  const handleClockIn = async () => {
    setLocating(true)
    let lat: number | undefined
    let lng: number | undefined

    try {
      const pos = await new Promise<GeolocationPosition>((resolve, reject) =>
        navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 5000 })
      )
      lat = pos.coords.latitude
      lng = pos.coords.longitude
    } catch {}

    setLocating(false)
    await clockIn.mutateAsync({ method: 'web', latitude: lat, longitude: lng })
  }

  const handleClockOut = async () => {
    let lat: number | undefined
    let lng: number | undefined
    try {
      const pos = await new Promise<GeolocationPosition>((resolve, reject) =>
        navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 5000 })
      )
      lat = pos.coords.latitude
      lng = pos.coords.longitude
    } catch {}
    await clockOut.mutateAsync({ method: 'web', latitude: lat, longitude: lng })
  }

  const formatTime = (iso: string) =>
    new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

  const now = new Date()
  const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const dateStr = now.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })

  if (isLoading) return <div style={s.card}><div style={s.loading}>Loading...</div></div>

  const clockedIn = today?.clockedIn
  const clockedOut = today?.clockedOut
  const workedHours = today?.workedHours || 0
  const status = today?.status || 'not_started'

  const statusColors: Record<string, { bg: string; color: string }> = {
    present:     { bg: '#e1f5ee', color: '#0F6E56' },
    half_day:    { bg: '#faeeda', color: '#BA7517' },
    absent:      { bg: '#faece7', color: '#993C1D' },
    not_started: { bg: '#f5f4f0', color: '#5c5c58' },
  }
  const sc = statusColors[status] || statusColors.not_started

  return (
    <div style={s.card}>
      <div style={s.dateTime}>
        <div style={s.time}>{timeStr}</div>
        <div style={s.date}>{dateStr}</div>
      </div>

      <div style={{ ...s.statusPill, backgroundColor: sc.bg, color: sc.color }}>
        {status.replace(/_/g, ' ')}
      </div>

      {clockedIn && (
        <div style={s.checkTimes}>
          <div style={s.checkItem}>
            <span style={s.checkLabel}>In</span>
            <span style={s.checkValue}>{formatTime(today.checkInTime)}</span>
          </div>
          {clockedOut && (
            <div style={s.checkItem}>
              <span style={s.checkLabel}>Out</span>
              <span style={s.checkValue}>{formatTime(today.checkOutTime)}</span>
            </div>
          )}
          {workedHours > 0 && (
            <div style={s.checkItem}>
              <span style={s.checkLabel}>Hours</span>
              <span style={s.checkValue}>{workedHours.toFixed(1)}h</span>
            </div>
          )}
        </div>
      )}

      <div style={s.btnRow}>
        {!clockedIn && (
          <button
            style={s.clockInBtn}
            onClick={handleClockIn}
            disabled={clockIn.isPending || locating}
          >
            {locating ? 'Getting location...' : clockIn.isPending ? 'Clocking in...' : '▶ Clock In'}
          </button>
        )}
        {clockedIn && !clockedOut && (
          <button
            style={s.clockOutBtn}
            onClick={handleClockOut}
            disabled={clockOut.isPending}
          >
            {clockOut.isPending ? 'Clocking out...' : '■ Clock Out'}
          </button>
        )}
        {clockedIn && clockedOut && (
          <div style={s.doneMsg}>✓ Done for the day — {workedHours.toFixed(1)}h worked</div>
        )}
      </div>

      {(clockIn.isError || clockOut.isError) && (
        <div style={s.error}>
          {(clockIn.error as any)?.response?.data?.message || (clockOut.error as any)?.response?.data?.message || 'Action failed'}
        </div>
      )}
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  card: { backgroundColor: '#fff', border: '0.5px solid #e2e0da', borderRadius: '10px', padding: '24px', marginBottom: '20px' },
  loading: { color: '#8c8c88', fontSize: '13px' },
  dateTime: { marginBottom: '12px' },
  time: { fontSize: '32px', fontWeight: '300', color: '#1a1a18', lineHeight: 1 },
  date: { fontSize: '13px', color: '#5c5c58', marginTop: '4px' },
  statusPill: { display: 'inline-flex', padding: '4px 12px', borderRadius: '12px', fontSize: '12px', fontWeight: '500', textTransform: 'capitalize', marginBottom: '14px' },
  checkTimes: { display: 'flex', gap: '20px', marginBottom: '16px' },
  checkItem: { display: 'flex', flexDirection: 'column', gap: '2px' },
  checkLabel: { fontSize: '11px', color: '#8c8c88', textTransform: 'uppercase', letterSpacing: '.04em' },
  checkValue: { fontSize: '15px', fontWeight: '500', color: '#1a1a18' },
  btnRow: { display: 'flex' },
  clockInBtn: { padding: '12px 28px', backgroundColor: '#534AB7', color: '#fff', border: 'none', borderRadius: '8px', fontSize: '14px', fontWeight: '500', cursor: 'pointer', letterSpacing: '.01em' },
  clockOutBtn: { padding: '12px 28px', backgroundColor: '#1a1a18', color: '#fff', border: 'none', borderRadius: '8px', fontSize: '14px', fontWeight: '500', cursor: 'pointer' },
  doneMsg: { fontSize: '14px', color: '#0F6E56', fontWeight: '500', padding: '10px 0' },
  error: { marginTop: '10px', backgroundColor: '#faece7', color: '#993C1D', borderRadius: '6px', padding: '8px 12px', fontSize: '13px', border: '0.5px solid #f5c6b8' },
}
