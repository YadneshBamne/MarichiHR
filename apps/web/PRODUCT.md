# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Owners, HR heads and payroll administrators of growing companies, first in Zambia and India (the two countries with full payroll tax tables), with Kenya and Nigeria as secondary markets. They run people operations and monthly payroll, often from spreadsheets, and answer to statutory bodies (ZRA, NAPSA, NHIMA in Zambia; EPF, TDS in India). Their managers and employees use the same workspace through their own portal (leave, attendance, expenses, payslips). The page's visitor is the owner or HR head deciding whether to create a workspace.

## Product Purpose

MarichiHR is a multi-company HR and payroll system sold as self-serve SaaS by Marichi Labs. A company signs up, installs only the apps it needs (leave, attendance, payroll, expenses, exits), adds its people and runs payroll with two-person approval. Success is a company that runs a correct, auditable monthly payroll without spreadsheets.

## Positioning

Payroll that follows the statutory rules of the country it is paid in (formula tables with a cited source per rate), with maker-checker approval built in: a second, different Payroll admin must approve, and large runs need a System admin's sign-off. HR admins never see pay. Neighbouring generic HR tools do not ship country payroll rules with sources and role separation by default.

## Operating Context

Monthly cycle: new cycle, lock attendance, run payroll, first approval, second approval by a different Payroll admin, disburse, then bank file, accounting journal and payslips. Each company installs apps per need and maps its own ledger accounts and bank layout. Currency and tax follow the company's country (ZMW, INR, KES, NGN starters).

## Capabilities and Constraints

Built: people and org structure, contracts, leave, attendance, payroll with country starters (Zambia: NAPSA, NHIMA, PAYE; India: EPF, professional tax, TDS; Kenya and Nigeria marked to confirm), payslip PDFs, bank file formats (generic CSV, semicolon, fixed width, ISO 20022, Union Bank of India, FNB Zambia and NIBSS marked to confirm), ERP-agnostic accounting export, expenses with ZRA Smart Invoice through DigiTax (test mode), exits and final settlement, tax declarations, incentives, policies, grievances, community, reports, automation with webhooks and API keys, role-based access, two-factor sign-in, encrypted bank details, audit log. Not claimed: filing of PAYE returns through an API (filed on the authority's portal, reference recorded), any customer count, pricing, uptime or benchmark. Statutory rates carry a verified flag; some are still marked to confirm.

## Brand Commitments

Name MarichiHR (Marichi means a ray of light); the sun mark with a half-lit honey disc; Marichi Labs as the maker. The existing design system in apps/web/src/styles/theme.css (warm paper ground, honey accent, charcoal, Outfit for display and Inter for body) is binding, and the login and signup pages already use it.

## Evidence on Hand

No customer logos, testimonials, case studies, prices or metrics exist and none may be invented. The product itself is the proof: the real module list, the real payroll flow, and the real statutory tables with their sources. A first client (Bimbe Trading Company Limited, Lusaka) is onboarding; do not name or imply customers on the page.

## Product Principles

1. Be exact about money: show how a payslip is built, never vague promises.
2. Separation of duties is a feature: say who sees what and who must approve.
3. Country rules are cited, not assumed.
4. Install only what you need; the product does not push every module.
5. Claim only what the product does today.
