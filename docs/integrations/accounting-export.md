# Accounting export (any ERP)

MarichiHR turns each paid payroll run into **one balanced journal** posted to the company's own ledger accounts. Any accounting system can take it, either as a file or pushed automatically. Nothing in it is tied to one vendor.

Where to find it: Payroll › open a run › **Accounting export**. Only Payroll admins and Compliance officers can use it.

## 1. Account mapping

Each posting goes to one account. Set your own code and name for each under **Accounts & ERP**. Postings you don't set use the defaults below.

| Posting key | Side | Default code | What it holds |
|---|---|---|---|
| `SALARY_EXPENSE` | Debit | 5000 | Gross earnings |
| `EMPLOYER_CONTRIB_EXPENSE` | Debit | 5010 | Employer statutory contributions (NAPSA, NHIMA, PF…) |
| `REIMBURSEMENT_EXPENSE` | Debit | 5020 | Expense reimbursements paid through payroll |
| `NET_PAYABLE` | Credit | 2100 | Net pay owed to employees (cleared by the bank payment) |
| `TAX_PAYABLE` | Credit | 2110 | PAYE / TDS withheld |
| `DEDUCTIONS_PAYABLE` | Credit | 2120 | Other employee deductions (pension, loans, union…) |
| `EMPLOYER_CONTRIB_PAYABLE` | Credit | 2130 | Employer contributions owed to the authorities |

Individual deduction codes can get their own account through the API (`deductionAccounts`, for example `{ "NAPSA_EE": { "code": "2125", "name": "NAPSA payable" } }`). Any deduction code without its own account goes to `DEDUCTIONS_PAYABLE`.

**Split by** repeats every line per department or per legal entity, and the line's `dimension` carries that name. Use it for cost centres or tracking categories.

Debits always equal credits. If they don't (by more than 0.01), no file is produced.

## 2. Standard journal (JSON)

```json
{
  "journalRef": "PAYROLL-2026-10-1a2b3c4d",
  "date": "2026-10-31",
  "periodStart": "2026-10-01",
  "periodEnd": "2026-10-31",
  "currency": "ZMW",
  "company": "Marichi Labs",
  "splitBy": "department",
  "lines": [
    { "accountKey": "SALARY_EXPENSE", "accountCode": "6100", "accountName": "Staff salaries", "description": "Gross salaries 2026-10 · Sales", "debit": 25000.00, "credit": 0, "dimension": "Sales" },
    { "accountKey": "NET_PAYABLE", "accountCode": "2100", "accountName": "Net salaries payable", "description": "Net salaries payable 2026-10 · Sales", "debit": 0, "credit": 19800.00, "dimension": "Sales" }
  ],
  "totals": { "debit": 32000.00, "credit": 32000.00 },
  "source": { "system": "MarichiHR", "payrollCycleId": "<uuid>", "payslips": 12 }
}
```

- Amounts are decimals with 2 places, in the run's currency.
- Dates are `YYYY-MM-DD`.
- `journalRef` is stable for a run, so use it to avoid importing the same journal twice.
- `accountKey` is `DEDUCTION:<code>` for deduction-specific lines.

## 3. Ways out

`GET /api/v1/payroll/cycles/:id/journal?format=<format>` returns the file as a download.

| Format | Shape | Status |
|---|---|---|
| `json` | The journal above | Our standard |
| `csv` | `Date, Journal Ref, Account Code, Account Name, Description, Debit, Credit, Dimension` (UTF-8, comma, CRLF) | Our standard |
| `xml` | `<Journal ref date currency …><Line account accountName debit credit dimension>description</Line>…<Totals/></Journal>` | Our standard |
| `quickbooks` | `Journal No., Journal Date, Account Name, Description, Debits, Credits` | Columns follow Intuit's "Import journal entries" help article. **Account Name must match the QuickBooks chart exactly**: enter the QuickBooks names in the mapping, write subaccounts as `Parent:Sub`, and turn off account numbers in QuickBooks before you import. |
| `xero` | `*Narration, *Date, Description, *AccountCode, *TaxRate, *Amount, TrackingName1, TrackingOption1`. Debits are positive and credits negative. TaxRate is "Tax Exempt". | **Check once against the template that Xero › Manual journals › Import offers.** Xero does not publish the headers outside the app. |
| `tally` | One Journal voucher in Tally import XML (`ENVELOPE/…/VOUCHER/ALLLEDGERENTRIES.LIST`). Debits have `ISDEEMEDPOSITIVE` Yes and a negative amount. | **Test on a copy of the company first.** The ledgers (account names) must already exist in Tally. |

Other ERPs (SAP, Dynamics, Odoo, Sage, Zoho Books…) take the generic CSV, JSON or XML through their journal import, or the push below.

## 4. Push to the ERP (webhook)

Set the **ERP address** (HTTPS on a public host only; private and local addresses are refused).

1. Saving an address the first time shows a **signing secret** once (`whsec_…`). **New signing secret** replaces it.
2. **Send to ERP** on a run sends the journal. With **Send automatically when a run is paid** turned on, the journal also goes out when the run is disbursed.

The request:

```
POST <your address>
Content-Type: application/json
X-MarichiHR-Event: payroll.journal
X-MarichiHR-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>" with the secret>
Idempotency-Key: <journalRef>

{ "event": "payroll.journal", "journal": { …the journal above… } }
```

The receiver should:

1. Recompute the HMAC over `t + "." + rawBody` and compare it to `v1` in constant time.
2. Reject `t` older than 5 minutes.
3. Ignore a repeated `Idempotency-Key`.
4. Answer with any 2xx.

A non-2xx answer, or no answer within 15 seconds, counts as a failure:

- A manual send shows the error.
- An automatic send is retried with the event (same Idempotency-Key).

Every attempt is in the audit log (`PAYROLL_JOURNAL_PUSHED` / `PAYROLL_JOURNAL_PUSH_FAILED`).

Node receiver sketch:

```js
const crypto = require('crypto')
function verify(secret, header, rawBody) {
  const { t, v1 } = Object.fromEntries(header.split(',').map((p) => p.split('=')))
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false
  const want = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex')
  return crypto.timingSafeEqual(Buffer.from(want), Buffer.from(v1))
}
```

## 5. API

| Call | What it does |
|---|---|
| `GET /api/v1/payroll/accounting/settings` | Mapping (with defaults filled in), `splitBy`, `webhookUrl`, `hasSecret`, `autoPush`, `formats` |
| `PUT /api/v1/payroll/accounting/settings` | Body (all optional): `accounts`, `deductionAccounts`, `splitBy` (`none`, `department` or `entity`), `webhookUrl`, `autoPush`, `rotateSecret`. Account maps are merged with what is saved. |
| `GET /api/v1/payroll/cycles/:id/journal?format=` | Download (the run needs both approvals, or is paid or locked) |
| `POST /api/v1/payroll/cycles/:id/journal/push` | Send now |

The older `GET /payroll/cycles/:id/gl-export` CSV stays as it was.
