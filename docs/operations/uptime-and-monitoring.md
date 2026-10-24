# Uptime and monitoring checklist

Target: **99.9% a month** (about 43 minutes of downtime a month at most).

## Health checks (built into the API)

- `GET /health`: the process is up (liveness). Cheap; use it for the platform's restart check.
- `GET /health/ready`: the database and Redis answer (readiness). Returns 503 when either is down. Use it for
  the load balancer and the uptime monitor.

## Hosting (GCP) for 99.9%

- [ ] API on Cloud Run with at least 1 minimum instance (no cold starts) and 2+ maximum; readiness probe on `/health/ready`
- [ ] Cloud SQL with high availability (regional), automated backups and point-in-time recovery (see backup-and-restore.md)
- [ ] API, database and Redis in the same region (round trips under 2 ms; payroll and dashboards depend on it)
- [ ] Workers: set `JOBS_ENABLED=false` on the web API and run `npm run worker` as a separate service, so a long
      job never slows requests
- [ ] Frontend on a CDN (Cloud Run / Firebase Hosting / Vercel)
- [ ] Custom domain with managed TLS certificates

## Monitoring and alerts

- [ ] Uptime check on `https://<api-domain>/health/ready` every minute from 3 regions; alert after 2 failures
- [ ] Uptime check on the web app's sign-in page
- [ ] Alert when the API error rate (5xx) is above 2% for 5 minutes
- [ ] Alert when p95 latency is above 2 seconds for 10 minutes
- [ ] Alert when database CPU is above 80% for 15 minutes, or storage is above 80%
- [ ] Alert when Redis memory is above 80%
- [ ] Alert when a scheduled job fails (Settings › Scheduled jobs shows the last runs; BullMQ failed-job count)
- [ ] Alerts go to email + WhatsApp/SMS of the on-call person
- [ ] Error tracking (e.g. Sentry) on the API and the web app, with personal data scrubbed

## Logs

- [ ] API logs to Cloud Logging, kept 30 days (requests carry no passwords, bank or ID numbers; the redact middleware strips them)
- [ ] The audit log stays in the database (append-only) and is exported monthly to the backup bucket

## Releases

- [ ] Every release runs both production builds (`npm run build -w web`, `npm run build -w @marichihr/api`) and the HTTP tests
- [ ] Database migrations are additive (new nullable columns, new tables) so a rollback of the code never needs a
      database rollback
- [ ] Deploy with gradual traffic (Cloud Run revisions: 10% → 100%) and keep the previous revision for instant rollback

## Each month

- [ ] Read the uptime report (target 99.9%)
- [ ] Check the failed jobs and webhooks (Settings › Automation › Webhooks)
- [ ] Rotate any credential older than 90 days
- [ ] Every quarter: run the restore test in backup-and-restore.md
