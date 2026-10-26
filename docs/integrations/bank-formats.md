# Bank salary file formats: research and status

Researched on 2026-10-26. Each layout is marked as one of:

- **Verified from source:** the layout comes from the bank's (or standard body's) own published document.
- **Confirm with bank:** the layout is only partly published, or not published at all, so compare it with the bank's template before the first live file.

Nothing below was invented. Where no public document exists, it says so.

Where to set them up: Payroll › run › **Bank file** › "Start from …" › **Add layout**. Adding a layout asks for the company's own values (your account, corporate ID, BIC…). Change them later with **Company values**.

The audit log records which values are set, never the values themselves.

## How an employer's file actually travels

- **Zambia.** The employer uploads the file to its own bank's internet banking. The bank then clears other-bank payments through ZECHL (EFT, batch) or ZIPSS (RTGS, Bank of Zambia).
  - ZECHL's file specifications are bank-to-clearing-house only. The EFT Rules (Appendix I) say they "shall be obtained from ZECHL" and that only EFT participants receive them.
  - So an employer never builds a ZECHL file. It builds its bank's upload file.
  - The Rules do tell us how ZECHL files work: fixed-length ASCII, with header, voucher control, transaction and trailer records, one batch of credits or debits per file.
  - Source: [ZECH Electronic Funds Transfer Rules, approved 6 March 2020](https://www.zechl.co.zm/wp-content/uploads/2024/12/REVISED-ZECH-ELECTRONIC-FUNDS-TRANSFER-RULES-APPROVED-MARCH-2020.pdf), sections 5.6, 6.3 and Appendix I.
  - ZIPSS (RTGS) has moved to ISO 20022 end-to-end references: [Bank of Zambia Circular 15/2024 and ZIPSS Rules, via regalert.today](https://regalert.today/document/f5c388ab-f824-4fac-ac9b-4d6a4e782614).
- **India.** The employer uploads to its bank's corporate banking (bulk NEFT/RTGS). NPCI and RBI file formats are bank-side only.
- **Kenya.** The employer uploads to its bank. Other-bank payments go by EFT (Kenya Bankers Association ACH) or RTGS (KEPSS), addressed by the 5-digit bank and branch code from the [KBA bank branch code list (2026)](https://www.kba.co.ke/wp-content/uploads/2026/09/Branch-Code-2026.pdf).
- **Nigeria.** The employer uploads to its bank or to NIBSS Pay. Payments are addressed by NUBAN (10 digits) and the CBN bank code.

## Built-in layouts

### ISO 20022 pain.001.001.03 (XML): Verified from source

- **Shape:** one `PmtInf` per currency, category purpose and purpose code `SALA`, and an `EndToEndId` equal to the payslip reference.
  - Each employee's Branch/SWIFT goes out as the agent BIC when it is a BIC, or otherwise as a local clearing member ID (`ClrSysMmbId`).
- **Validation:** the generated file was checked against the pain.001.001.03 XSD (SWIFTStandards Workstation build, copy from [github.com/sebastienrousseau/pain001](https://github.com/sebastienrousseau/pain001)). The message definition itself is published at iso20022.org.
- **Banks:**
  - Standard Chartered Straight2Bank accepts pain.001 v2/v3 (and moves to v9): [SC ISO 20022 FAQ, Aug 2025](https://www.sc.com/en/uploads/sites/66/content/docs/SC-ISO20022-FAQ-4Aug2025.pdf).
  - Stanbic's Electronic Banking guide lists XML and CSV upload formats: [Stanbic Electronic Banking Operational Guide, 2025](https://www.stanbicbank.co.ug/static_file/Uganda/Downloadable%20files/Terms%20and%20Conditions/Electronic%20Banking%20Operational%20guide.pdf).
- **Confirm with the bank:**
  - the version (v3 or v9);
  - whether employees are addressed by BIC or by a local branch code;
  - any bank-specific header fields.

Sample (one employee):

```xml
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.03">
  <CstmrCdtTrfInitn>
    <GrpHdr><MsgId>MHR-20261030-…</MsgId><CreDtTm>2026-10-26T09:00:00</CreDtTm><NbOfTxs>1</NbOfTxs><CtrlSum>10984.50</CtrlSum><InitgPty><Nm>Marichi Labs</Nm></InitgPty></GrpHdr>
    <PmtInf>
      <PmtInfId>…-1</PmtInfId><PmtMtd>TRF</PmtMtd><NbOfTxs>1</NbOfTxs><CtrlSum>10984.50</CtrlSum>
      <PmtTpInf><CtgyPurp><Cd>SALA</Cd></CtgyPurp></PmtTpInf><ReqdExctnDt>2026-10-30</ReqdExctnDt>
      <Dbtr><Nm>Marichi Labs</Nm></Dbtr><DbtrAcct><Id><Othr><Id>62000000001</Id></Othr></Id><Ccy>ZMW</Ccy></DbtrAcct>
      <DbtrAgt><FinInstnId><BIC>FIRNZMLX</BIC></FinInstnId></DbtrAgt>
      <CdtTrfTxInf>
        <PmtId><EndToEndId>SAL-2026-10-EMP0002</EndToEndId></PmtId>
        <Amt><InstdAmt Ccy="ZMW">10984.50</InstdAmt></Amt>
        <CdtrAgt><FinInstnId><BIC>ZNCOZMLU</BIC></FinInstnId></CdtrAgt>
        <Cdtr><Nm>Mwila Banda</Nm></Cdtr><CdtrAcct><Id><Othr><Id>0123456789</Id></Othr></Id></CdtrAcct>
        <Purp><Cd>SALA</Cd></Purp><RmtInf><Ustrd>SAL-2026-10-EMP0002</Ustrd></RmtInf>
      </CdtTrfTxInf>
    </PmtInf>
  </CstmrCdtTrfInitn>
</Document>
```

### FNB Zambia, Online Banking Enterprise payments CSV: Confirm with bank (mostly verified)

- **Source:** [FNB "Payments – CSV Import Guide", April 2024](https://www.online.fnb.co.za/rhelp_0_81/OBE_ZAMBIA_Downloads/Downloads/Payments/Payment_CSV_Import_Guide_Int.pdf), in FNB Zambia's OBE downloads.
- **Verified from the guide:**
  - **A2:** action date.
  - **A3:** your account (20).
  - **B3:** hash total (12 digits).
  - **Transaction columns:**
    - A: recipient name (20)
    - B: recipient account (20)
    - C: account type (0 public, 1 current, 2 savings, 3 transmission, S eWallet)
    - D: 6-digit branch code (FNB Zambia universal branch code 260006)
    - E: amount (11, period decimal separator, at most 2 decimals)
    - F: own reference (20)
    - G: recipient reference (20)
    - H to AJ: optional notifications
  - **Date formats:** CCYY/MM/DD and others.
  - **Hash total:** the sum of the recipient account numbers plus your own account number, keeping the last 12 digits. It is only checked when your administrator turns it on.
- **Not shown in the guide:**
  - what row 1 holds;
  - whether the transactions have a heading row, and on which row they start.

  We write row 1 empty and no heading row. Compare this with the template from OBE › Help before the first import.
- **Account type:** we use 1 (current); change it to 2 for savings accounts.

Sample:

```
(empty row 1)
2026/10/30
62000000001,062123456790
Mwila Banda,0123456789,1,260006,10984.50,SAL-2026-10-EMP0002,SAL-2026-10-EMP0002
```

### Union Bank of India, NEFT/RTGS bulk upload (text): Verified from source

- **Source:** [Union Bank of India, NEFT/RTGS File Upload in TEXT Format](https://www.unionbankonline.co.in/InternetBankingProductDemos/Sample%20NEFT%20Format_txt%20File.pdf), with the [CSV variant](https://www.unionbankonline.co.in/InternetBankingProductDemos/BULK_NEFT_RTGS_DEMO/NEFTRTGS_format_CSV.pdf).
- **Layout:**
  - **Header line:** `FILEHDR,<corporate id>[,<serial>,<Y/N encryption>,<remarks>]`.
  - **Payment lines:** `NEFT|RTGS, payer IFSC, debit account, receiver IFSC, beneficiary account, INR, amount, remarks (140), beneficiary name (40), user e-mail, user mobile`.
  - **Rules:** comma- or pipe-separated, no commas inside values, at least one record, 2 MB at most.
- **To check once:** the bank's example amount is a whole number ("1"), so confirm that paise (2 decimals) are accepted.

Sample:

```
FILEHDR,MARICHI
NEFT,UBIN0556688,566802070000001,ICIC0000001,000401234567,INR,48250.00,SAL-2026-10-EMP0007,Asha Rao,payroll@example.com,9999999999
```

### Nigeria, NIBSS Pay payment schedule (CSV): Confirm with bank

- **Source:** [NIBSS Pay FAQ](https://nibss-plc.com.ng/nibss-pay/).
  - The schedule is a CSV of beneficiary account name, account number, bank, bank code, amount and narration.
  - Up to 100,000 items per file.
- **Not published:** column order, headings and amount format. We use the order NIBSS lists them in, with headings. Compare with the template on NIBSS Pay or your bank's portal.
- **Bank code:** Branch/SWIFT must hold the bank code that the template asks for.

### Generic CSV, Semicolon and Fixed width

These are our own starting points (marked "generic"). Edit them to match any bank's spec.

## Banks researched with no public layout (Confirm with bank)

Ask the bank's cash-management team for its bulk template, then enter it as a layout. Many of these banks also accept ISO 20022 pain.001: ask about that first.

| Bank | What is public | Source |
|---|---|---|
| Zanaco | Bulk CSV upload of Zanaco and other-bank accounts and mobile wallets; cut-off 14:30. PayFlexi for high volumes. No column list. | [Zanaco internet banking FAQ](https://www.zanaco.co.zm/new-internet-banking-faqs/), [Electronic banking](https://www.zanaco.co.zm/business-banking/electronic-banking/) |
| Stanbic Zambia | Business Online bulk payments; the guide lists XML and CSV (proprietary) formats, plus Zambia mobile bulk payments capped at ZMW 20,000 per wallet. No column list. | [Stanbic Electronic Banking Operational Guide 2025](https://www.stanbicbank.co.ug/static_file/Uganda/Downloadable%20files/Terms%20and%20Conditions/Electronic%20Banking%20Operational%20guide.pdf) |
| Absa Zambia | "Domestic Bulk Payment" layout exists; Sage supplies it to customers on request. Not public. The South African Absa layout (headerless CSV) is a different product. | [Sage community: Zambia Absa domestic bulk payment bank file](https://communityhub.sage.com/za/sage-300-people/f/announcements/270331/bank-file-update-zambia-absa-bank-domestic-bulk-payment-bank-file) |
| Standard Chartered Zambia | Straight2Bank: pain.001 v2/v3/v9, IPAYMENTCSV and API JSON. The specs come from your relationship manager. **Use the ISO 20022 layout.** | [SC ISO 20022 FAQ](https://www.sc.com/en/uploads/sites/66/content/docs/SC-ISO20022-FAQ-4Aug2025.pdf) |
| Indo Zambia Bank, ZNBS | Nothing public found. | — |
| SBI | CINB Vyapaar/Vistaar: bulk upload for salary, vendor and tax; single-debit, multiple-credit files for intra-bank, NEFT and RTGS. The field layout sits inside CINB. | [SBI CINB FAQ](https://sbi.bank.in/web/faq-s/-faq-corporate-internet-banking) |
| HDFC Bank | ENet bulk upload: ASCII text, 2 MB limit. Layout inside ENet / from the RM. | [HDFC ENet FAQ](https://www.hdfcbank.com/content/bbp/repositories/723fb80a-2dde-42a3-9793-7ae1be57c87f/?path=/Footer/Resource/Forms%20Centre/Content/Detail%20Page/Forms%20Center%20-%20Wholesale/ENet%20links/FAQs-on-Corporate-Internet-Banking-Enet.pdf) |
| ICICI Bank | Field order and maximum lengths are published (details below). The delimiter, amount format and padding are not: ICICI's Excel converters build the files. | [ICICI File Format for Bulk upload in CIB v3.3](https://www.icici.bank.in/managed-assets/docs/form-center/File_Format_Bulk_%20Transfers_3.3.pdf) |
| Axis Bank | Single-file upload for NEFT, RTGS, IMPS and internal transfers, with beneficiary validation and encryption. Layout from the bank. | [Axis bulk payment uploads](https://www.axisbank.com/corporate/transaction-banking/cash-management-services/bulk-payment-uploads) |
| Equity, KCB (Kenya) | Nothing official found. A third-party payroll project describes an Equity Eazzy Biz file; not used. | — |
| GTBank, Zenith, Access (Nigeria) | Nothing official found. | — |

ICICI's published field orders:

- **Salary (PAB-SAL):** beneficiary name 32, debit account 12, beneficiary account 34, IFSC 11, network type WIB/NFT. Note that the published table lists no amount field.
- **Bulk NEFT:** account 12, to-account ID 12, currency 3, amount 14, beneficiary name 30, IFSC 11, beneficiary account 24, account type 2, particulars 30, remarks 23.

## What to ask a bank for

Ask for:

- the bulk salary/payment upload specification with a sample file;
- the delimiter or fixed widths;
- header and trailer rules;
- the date and amount formats;
- the character set;
- any hash or control total;
- how other-bank accounts are addressed (branch code, sort code, IFSC, BIC);
- cut-off times;
- whether they accept ISO 20022 pain.001 (and which version).
