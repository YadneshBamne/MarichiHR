# DigiTax (ZRA Smart Invoice)

DigiTax, by Namiri Technologies, is a certified ZRA Smart Invoice middleware. Everything here follows its published docs at [zm.docs.digitax.tech](https://zm.docs.digitax.tech) (full index: `llms.txt`).

## What the API covers, and what it does not

- **Covers** ZRA Smart Invoice only:
  - business info;
  - items;
  - customers and suppliers;
  - imports;
  - purchases;
  - sales, credit notes and debit notes;
  - stock;
  - ZRA notices.
- **No payroll or PAYE endpoint.** PAYE, NAPSA and NHIMA returns stay on ZRA's own portal. MarichiHR records the filing reference by hand (Tax › Filings).

## Connection

| Setting | |
|---|---|
| Server | `https://api.digitax.tech/zm/v1` (one server for both modes) |
| Auth | `X-API-Key` header |
| Test or live | Decided by the key: a TEST business key reaches ZRA's sandbox |
| `DIGITAX_API_KEY` | The key. A key that does not start `ZMB_TEST_` stays unused until `DIGITAX_LIVE=true`. |
| `DIGITAX_TENANT` | Slug of the one company the key belongs to (one key = one DigiTax business = one TPIN). Other companies never see or use it. |

## What MarichiHR does with it

1. **Connection check.** `GET /info` shows "test business connected" on Tax › Filings.
2. **ZRA notices.** `GET /notices` is listed on Tax › Filings.
3. **Expense claims as Smart Invoice purchases.** `POST /purchases` (Add manual purchase), then `GET /purchases/{id}` for the status.
   - **Where:** Expenses › Finance › "ZRA Smart Invoice purchases".
   - **Category mapping:** each expense category maps to a DigiTax item (`GET /items`). Only items ZRA has accepted (`status: COMPLETED`) can be mapped. DigiTax refuses purchases against unsynced items (HTTP 412).
   - **What can be sent:** finance-approved or paid claims in ZMW. Per-diem allowances are never sent (they are not purchases).
   - **Supplier details:** Finance adds the supplier's TPIN (10 digits), name and Smart Invoice number from the receipt. All three are optional in DigiTax's schema.
   - **What is sent:** `purchase_date`, the optional supplier fields, and one item line: `item_id`, `quantity` 1, `package_unit_quantity` 1, `unit_price` = `total_amount` = the claim amount, `discount_rate` 0, `discount_amount` 0.
   - **Undocumented requirement:** `package_unit_quantity` is not marked required in the schema, but the API answers `items.package_unit_quantity: value is required` without it.
   - **Status:** `PENDING` (queued for ZRA), `COMPLETED` or `FAILED`. "Check status" refreshes it. Failed or errored claims can be sent again; others cannot be sent twice.
   - **Audit:** every send is audited (`SMART_INVOICE_PURCHASE_SENT` / `_FAILED`).

## Tested (2026-10-26, TEST business only)

- `GET /info`: is_test true.
- `GET /notices`: 15 sandbox notices.
- Test items created in the TEST business:
  - "MarichiHR test - office supplies" (class 44120000): ZRA sync FAILED, no reason given.
  - "MarichiHR test - desk supplies" (class 44121600, package CT, unit U, VAT A): COMPLETED within a minute.
- A finance-approved test claim sent through the API was recorded with a `purchase_…` id; its ZRA status came back COMPLETED.
- `tests/http/smart-invoice.test.js` covers this (14 checks). It sends one purchase to the TEST business per run.

## Not built, and why

- **Sales, credit and debit notes:** an HR system does not sell.
- **Stock, imports, suppliers, customers:** not HR data.
- **Automatic sending on approval:** left manual, because Finance has to read the supplier's TPIN and Smart Invoice number off the receipt.
- **Per-company keys:** today one key serves the company named in `DIGITAX_TENANT`. Supporting several companies needs each company's key stored encrypted, plus a settings screen.
