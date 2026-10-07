import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useEmployees } from '../../lib/hooks/useEmployees'
import { useAuth } from '../../contexts/AuthContext'
import Badge from '../../components/ui/Badge'
import CreateEmployeeModal from './CreateEmployeeModal'

export default function EmployeeListPage() {
  const { isHR } = useAuth()
  const navigate = useNavigate()
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [showCreate, setShowCreate] = useState(false)
  const [searchInput, setSearchInput] = useState('')

  const { data, isLoading } = useEmployees({ page, limit: 25, search })

  const employees = data?.data || []
  const meta = data?.meta

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault()
    setSearch(searchInput)
    setPage(1)
  }

  return (
    <div style={s.page}>
      {/* Header */}
      <div style={s.header}>
        <div>
          <h2 style={s.title}>Employees</h2>
          <p style={s.sub}>{meta?.total ?? 0} total</p>
        </div>
        {isHR && (
          <button style={s.addBtn} onClick={() => setShowCreate(true)}>
            + Add Employee
          </button>
        )}
      </div>

      {/* Search bar */}
      <form onSubmit={handleSearch} style={s.searchRow}>
        <input
          style={s.searchInput}
          placeholder="Search by name, email or code..."
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
        />
        <button type="submit" style={s.searchBtn}>Search</button>
        {search && (
          <button type="button" style={s.clearBtn} onClick={() => { setSearch(''); setSearchInput(''); setPage(1) }}>
            Clear
          </button>
        )}
      </form>

      {/* Table */}
      <div style={s.tableWrap}>
        {isLoading ? (
          <div style={s.loading}>Loading employees...</div>
        ) : employees.length === 0 ? (
          <div style={s.empty}>No employees found.</div>
        ) : (
          <table style={s.table}>
            <thead>
              <tr>
                {['Code', 'Name', 'Email', 'Department', 'Position', 'Type', 'Status', ''].map((h) => (
                  <th key={h} style={s.th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {employees.map((emp: any) => (
                <tr
                  key={emp.id}
                  style={s.tr}
                  onClick={() => navigate(`/employees/${emp.id}`)}
                >
                  <td style={s.td}><span style={s.code}>{emp.employeeCode}</span></td>
                  <td style={s.td}>
                    <div style={s.nameCell}>
                      <div style={s.avatar}>{emp.firstName?.charAt(0)}</div>
                      <div>
                        <div style={s.name}>{emp.firstName} {emp.lastName}</div>
                        {emp.manager && <div style={s.manager}>Reports to {emp.manager.user.fullName}</div>}
                      </div>
                    </div>
                  </td>
                  <td style={s.td}><span style={s.email}>{emp.workEmail || emp.user?.email}</span></td>
                  <td style={s.td}>{emp.orgUnit?.name || '—'}</td>
                  <td style={s.td}>{emp.jobPosition?.title || '—'}</td>
                  <td style={s.td}><Badge label={emp.employmentType} /></td>
                  <td style={s.td}><Badge label={emp.employmentStatus} /></td>
                  <td style={s.td}><span style={s.viewLink}>View →</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      {meta && meta.totalPages > 1 && (
        <div style={s.pagination}>
          <button style={s.pageBtn} disabled={!meta.hasPrev} onClick={() => setPage(p => p - 1)}>← Prev</button>
          <span style={s.pageInfo}>Page {meta.page} of {meta.totalPages}</span>
          <button style={s.pageBtn} disabled={!meta.hasNext} onClick={() => setPage(p => p + 1)}>Next →</button>
        </div>
      )}

      <CreateEmployeeModal open={showCreate} onClose={() => setShowCreate(false)} />
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  page: { maxWidth: '1200px' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '20px' },
  title: { fontSize: '20px', fontWeight: '500', color: '#1a1a18', margin: 0 },
  sub: { fontSize: '13px', color: '#8c8c88', marginTop: '2px' },
  addBtn: { padding: '9px 18px', backgroundColor: '#534AB7', color: '#fff', border: 'none', borderRadius: '6px', fontSize: '13px', fontWeight: '500', cursor: 'pointer' },
  searchRow: { display: 'flex', gap: '8px', marginBottom: '16px' },
  searchInput: { flex: 1, padding: '9px 12px', borderRadius: '6px', border: '0.5px solid #ccc9c1', fontSize: '13px', outline: 'none' },
  searchBtn: { padding: '9px 16px', backgroundColor: '#1a1a18', color: '#fff', border: 'none', borderRadius: '6px', fontSize: '13px', cursor: 'pointer' },
  clearBtn: { padding: '9px 16px', backgroundColor: '#f5f4f0', border: '0.5px solid #e2e0da', borderRadius: '6px', fontSize: '13px', cursor: 'pointer', color: '#5c5c58' },
  tableWrap: { backgroundColor: '#fff', border: '0.5px solid #e2e0da', borderRadius: '10px', overflow: 'hidden' },
  loading: { padding: '40px', textAlign: 'center', color: '#8c8c88', fontSize: '13px' },
  empty: { padding: '40px', textAlign: 'center', color: '#8c8c88', fontSize: '13px' },
  table: { width: '100%', borderCollapse: 'collapse' },
  th: { padding: '10px 16px', textAlign: 'left', fontSize: '11px', fontWeight: '500', color: '#8c8c88', textTransform: 'uppercase', letterSpacing: '.04em', borderBottom: '0.5px solid #e2e0da', backgroundColor: '#f9f8f6' },
  tr: { cursor: 'pointer', borderBottom: '0.5px solid #f5f4f0', transition: 'background 0.1s' },
  td: { padding: '12px 16px', fontSize: '13px', color: '#1a1a18' },
  code: { fontFamily: 'monospace', fontSize: '12px', color: '#5c5c58' },
  nameCell: { display: 'flex', alignItems: 'center', gap: '10px' },
  avatar: { width: '28px', height: '28px', borderRadius: '50%', backgroundColor: '#eeedfe', color: '#534AB7', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px', fontWeight: '600', flexShrink: 0 },
  name: { fontWeight: '500', fontSize: '13px' },
  manager: { fontSize: '11px', color: '#8c8c88', marginTop: '1px' },
  email: { color: '#5c5c58', fontSize: '12px' },
  viewLink: { color: '#534AB7', fontSize: '12px' },
  pagination: { display: 'flex', alignItems: 'center', gap: '12px', marginTop: '16px', justifyContent: 'center' },
  pageBtn: { padding: '7px 14px', border: '0.5px solid #e2e0da', borderRadius: '6px', backgroundColor: '#fff', fontSize: '13px', cursor: 'pointer', color: '#1a1a18' },
  pageInfo: { fontSize: '13px', color: '#5c5c58' },
}
