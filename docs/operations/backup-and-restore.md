# Backup and restore

What is backed up, how often, how to restore, and the targets we commit to (RPO = how much data we can lose,
RTO = how long until the service is back).

## Targets

| What | RPO | RTO |
| --- | --- | --- |
| Database (PostgreSQL: everything except files) | 5 minutes | 1 hour |
| Documents and attachments (object storage) | 24 hours | 4 hours |
| Configuration and secrets | at every change | 1 hour |

## What holds data

- **PostgreSQL**: all records (people, leave, attendance, payroll, tax, audit log). This is the one that matters most.
- **Object storage** (S3-compatible: Filebase / Cloudflare R2 / GCS): uploaded documents, proofs, forum attachments.
- **Redis**: queues and short-lived counters only. It holds nothing that cannot be rebuilt: lost jobs are re-sent
  by the `events-sweep` job from the `domain_events` table. No backup needed.
- **Secrets** (API `.env` / secret manager): database URL, `JWT_*`, `BANK_ENCRYPTION_KEY`, storage keys, Resend,
  WhatsApp, VAPID, Google OAuth.

> **`BANK_ENCRYPTION_KEY` must be backed up separately and kept safe.** Without it, bank account numbers, identity
> numbers and MFA secrets cannot be decrypted, even from a perfect database backup.

## Database

**Today (Neon):** point-in-time restore (PITR) is built in. The history window depends on the plan (free: 1 day;
paid: up to 30 days).

**On GCP (Cloud SQL for PostgreSQL), set up as:**
1. Automated daily backups, kept 30 days.
2. Point-in-time recovery on (write-ahead logs kept 7 days), which gives the 5-minute RPO.
3. High availability (regional) instance for production, so a zone failure fails over automatically.
4. A weekly logical export to a separate bucket, kept 90 days:
   `gcloud sql export sql <instance> gs://<backup-bucket>/marichihr-$(date +%F).sql.gz --database=<db> --offload`

### Restore to a point in time (bad data, wrong bulk change)

1. Pick the time just before the problem (the audit log shows when it happened).
2. **Neon:** Console → Branches → Create branch from a point in time → test it → set it as primary, or copy the
   needed rows back.
   **Cloud SQL:** `gcloud sql instances clone <instance> <instance>-restore --point-in-time "2026-10-24T09:55:00Z"`
3. Point a staging API at the restored copy (`DATABASE_URL`) and check the affected screens.
4. Either switch production to the restored instance (short outage), or copy just the affected rows back.
5. Record what happened and what was restored in the incident log.

### Restore a full export (disaster)

1. Create an empty PostgreSQL database in the same region as the API.
2. `gcloud sql import sql <new-instance> gs://<backup-bucket>/<file>.sql.gz --database=<db>`
   (or `psql "$DATABASE_URL" < backup.sql` outside GCP).
3. Run `npx prisma migrate deploy` in `packages/database`, which applies any migrations newer than the backup.
4. Set `DATABASE_URL` on the API and restart it. Check `GET /health/ready`.

## Documents (object storage)

- Turn on object versioning on the bucket (30 days of old versions), so deleted or overwritten files can be restored.
- Copy the bucket once a day to a second bucket in another region:
  `gsutil -m rsync -r gs://<docs-bucket> gs://<docs-backup-bucket>` (scheduled with Cloud Scheduler).
- Restore: copy the files back with the same keys (the database stores each file's key).

## Secrets

- Keep every secret in GCP Secret Manager (versioned). Never in the repository or chat.
- Keep a sealed offline copy of `BANK_ENCRYPTION_KEY` and `JWT_ACCESS_SECRET` with the company owner.
- When rotating `BANK_ENCRYPTION_KEY`, re-encrypt the stored values first; a new key alone breaks decryption.

## Test the restore

Every quarter: restore last night's backup into a scratch database, run the API against it, and sign in, open a
payslip, and open a document. Write down how long it took (that is the real RTO).
