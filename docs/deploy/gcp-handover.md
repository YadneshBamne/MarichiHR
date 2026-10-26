# MarichiHR on Google Cloud: hand-over guide

This guide is for whoever hosts MarichiHR on Google Cloud. The pipeline is in `.github/workflows/deploy-gcp.yml`:

- **Every push:** builds and checks the code, and builds the Docker images.
- **Pushes to `main`:** once the GitHub variables below are set, it also deploys:
  1. builds and pushes the images;
  2. runs the database migrations;
  3. deploys the API, the background worker and the web app to Cloud Run.

No secret value is stored in GitHub or in the repository. The app reads its secrets from Secret Manager. Render and Vercel deploys keep working; nothing here changes them.

## What runs where

| Piece | Google Cloud service | Notes |
|---|---|---|
| API (`marichihr-api`) | Cloud Run service, image `apps/api/Dockerfile` | Port 8080, public, min 1 instance, session affinity (live notifications use WebSockets). `JOBS_ENABLED=false`. |
| Worker (`marichihr-worker`) | Cloud Run service, same image, `node dist/worker.js` | Runs the event queue and every scheduled job (absent marking, leave accrual, contracts, SLA escalation, webhook retry…). Exactly 1 instance, CPU always allocated, not public. |
| Migrations (`marichihr-migrate`) | Cloud Run job, same image | `prisma migrate deploy`; runs before each deploy and stops the deploy if it fails. |
| Web (`marichihr-web`) | Cloud Run service, image `apps/web/Dockerfile` (nginx) | Static site; the API address is built in from `MARICHI_API_URL`. |
| Database | Cloud SQL for PostgreSQL 16 | Private IP or Cloud SQL connector (the pipeline mounts the instance). |
| Queue / cache | Memorystore for Redis 7 | Reached over the VPC (Direct VPC egress). **Set `maxmemory-policy` to `noeviction`**: the queue library (BullMQ) requires it. |
| Files (documents, logos, payslip PDFs) | Cloud Storage bucket | Through the S3-compatible API with an HMAC key, so no code change. |
| Images | Artifact Registry (Docker) repository `marichihr` | |
| Secrets | Secret Manager | One secret per variable, listed in `deploy/gcp/secrets.txt`. |

## Region

Recommended: **africa-south1 (Johannesburg)**.

- The users and the tenant timezone are in Zambia, and every page makes several database round trips. Keeping the API and database close to Lusaka matters more than anything else.
- Cloud Run, Cloud SQL and Memorystore for Redis are all offered there. Memorystore lists africa-south1 zones a/b/c ([Memorystore regions](https://docs.cloud.google.com/memorystore/docs/redis/regions)).

**asia-south1 (Mumbai)** is better only if most users are in India.

Put every piece in the **same region**. The API, worker, database and Redis talk to each other on every request.

## One-time setup

Replace `PROJECT`, `REGION` (e.g. `africa-south1`) and `GITHUB_OWNER/REPO` (the repository the pipeline runs in).

### 1. APIs and the image repository

```bash
gcloud config set project PROJECT
gcloud services enable run.googleapis.com sqladmin.googleapis.com redis.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com iamcredentials.googleapis.com compute.googleapis.com storage.googleapis.com
gcloud artifacts repositories create marichihr --repository-format=docker --location=REGION
```

### 2. Network

Use the default VPC, or a dedicated one. The pipeline needs a network name and a subnet in `REGION` for Direct VPC egress, which is how Cloud Run reaches Redis.

```bash
gcloud compute networks subnets list --filter="region:REGION"
```

### 3. Cloud SQL (PostgreSQL 16)

```bash
gcloud sql instances create marichihr-db --database-version=POSTGRES_16 --region=REGION --tier=db-custom-2-7680 --availability-type=REGIONAL --backup --enable-point-in-time-recovery
gcloud sql databases create marichihr --instance=marichihr-db
gcloud sql users create marichihr --instance=marichihr-db --password='<generate a long random password>'
```

The connection name is `PROJECT:REGION:marichihr-db`. With the connector socket the pipeline mounts, the URLs are:

- `DATABASE_URL`: `postgresql://marichihr:<password>@localhost/marichihr?host=/cloudsql/PROJECT:REGION:marichihr-db&connection_limit=10`
- `DIRECT_URL`: the same value.

Moving the data from Neon:

1. `pg_dump --no-owner --no-acl` from Neon.
2. `psql` into Cloud SQL (through the Cloud SQL Auth Proxy).
3. Run the pipeline. The migrate step then finds nothing new to apply.

Backups and restore targets: `docs/operations/backup-and-restore.md`.

### 4. Memorystore for Redis

```bash
gcloud redis instances create marichihr-redis --region=REGION --tier=standard --size=1 --redis-version=redis_7_0 --network=projects/PROJECT/global/networks/default --redis-config=maxmemory-policy=noeviction
gcloud redis instances describe marichihr-redis --region=REGION --format='value(host,port)'
```

`REDIS_URL` is `redis://<host>:6379`.

- If you turn on AUTH, use `redis://:<auth string>@<host>:6379`.
- If you turn on in-transit encryption, use `rediss://` and add the server CA.

### 5. Cloud Storage for files

```bash
gcloud storage buckets create gs://marichihr-documents --location=REGION --uniform-bucket-level-access --public-access-prevention
gcloud iam service-accounts create marichihr-run --display-name="MarichiHR runtime"
gcloud storage buckets add-iam-policy-binding gs://marichihr-documents --member=serviceAccount:marichihr-run@PROJECT.iam.gserviceaccount.com --role=roles/storage.objectAdmin
gcloud storage hmac create marichihr-run@PROJECT.iam.gserviceaccount.com
```

The HMAC command prints an access ID and a secret. They become `S3_ACCESS_KEY` and `S3_SECRET_KEY`. The bucket name goes in `deploy/gcp/env.yaml` (`S3_BUCKET`). Files stay private: the app hands out short-lived signed links.

### 6. Runtime service account permissions

```bash
for r in roles/cloudsql.client roles/secretmanager.secretAccessor; do
  gcloud projects add-iam-policy-binding PROJECT --member=serviceAccount:marichihr-run@PROJECT.iam.gserviceaccount.com --role=$r
done
```

### 7. Secrets

The pipeline maps each variable in `deploy/gcp/secrets.txt` to a secret named `marichihr-<lower-case-with-dashes>`. Create each one and paste its value at the prompt. Values never go in files or chat.

```bash
for v in DATABASE_URL DIRECT_URL REDIS_URL JWT_ACCESS_SECRET JWT_REFRESH_SECRET BANK_ENCRYPTION_KEY SMTP_USER SMTP_PASS S3_ACCESS_KEY S3_SECRET_KEY; do
  name="marichihr-$(echo $v | tr 'A-Z_' 'a-z-')"
  read -rsp "$v: " val; echo
  printf '%s' "$val" | gcloud secrets create "$name" --data-file=- --replication-policy=automatic
done
```

| Variable | Secret | What it is |
|---|---|---|
| `DATABASE_URL`, `DIRECT_URL` | marichihr-database-url, marichihr-direct-url | Cloud SQL URL (step 3) |
| `REDIS_URL` | marichihr-redis-url | Memorystore URL (step 4) |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | marichihr-jwt-access-secret, marichihr-jwt-refresh-secret | Long random strings (`openssl rand -hex 48`). Changing them signs everyone out. |
| `BANK_ENCRYPTION_KEY` | marichihr-bank-encryption-key | **Must be the same key the current database was encrypted with** (bank numbers and MFA secrets). Copy it from the current host; never generate a new one for existing data. Keep an offline backup. |
| `SMTP_USER`, `SMTP_PASS` | marichihr-smtp-user, marichihr-smtp-pass | Mandrill SMTP login and API key |
| `S3_ACCESS_KEY`, `S3_SECRET_KEY` | marichihr-s3-access-key, marichihr-s3-secret-key | HMAC key from step 5 |
| `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` | (uncomment in secrets.txt when ready) | After Meta approves the templates |
| `DIGITAX_API_KEY` | (uncomment when ready) | DigiTax Smart Invoice key. A live key stays unused until `DIGITAX_LIVE=true`. |

Plain settings (sender address, bucket name, feature switches, `CLIENT_URL`) are in `deploy/gcp/env.yaml`. Set `CLIENT_URL` to the web address before the first deploy.

### 8. GitHub → Google Cloud without keys (Workload Identity Federation)

```bash
gcloud iam service-accounts create marichihr-deploy --display-name="MarichiHR deploy (GitHub Actions)"
for r in roles/run.admin roles/artifactregistry.writer roles/iam.serviceAccountUser; do
  gcloud projects add-iam-policy-binding PROJECT --member=serviceAccount:marichihr-deploy@PROJECT.iam.gserviceaccount.com --role=$r
done
gcloud iam workload-identity-pools create github --location=global
gcloud iam workload-identity-pools providers create-oidc github --location=global --workload-identity-pool=github \
  --issuer-uri=https://token.actions.githubusercontent.com \
  --attribute-mapping=google.subject=assertion.sub,attribute.repository=assertion.repository \
  --attribute-condition="assertion.repository=='GITHUB_OWNER/REPO'"
gcloud iam service-accounts add-iam-policy-binding marichihr-deploy@PROJECT.iam.gserviceaccount.com --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/$(gcloud projects describe PROJECT --format='value(projectNumber)')/locations/global/workloadIdentityPools/github/attribute.repository/GITHUB_OWNER/REPO"
```

### 9. GitHub repository variables

In GitHub, open Settings › Secrets and variables › Actions › **Variables**. These are not secrets.

| Variable | Example |
|---|---|
| `GCP_PROJECT_ID` | `marichihr-prod` |
| `GCP_REGION` | `africa-south1` |
| `GCP_WIF_PROVIDER` | `projects/123456789/locations/global/workloadIdentityPools/github/providers/github` |
| `GCP_DEPLOY_SA` | `marichihr-deploy@PROJECT.iam.gserviceaccount.com` |
| `GCP_RUNTIME_SA` | `marichihr-run@PROJECT.iam.gserviceaccount.com` |
| `GCP_SQL_INSTANCE` | `PROJECT:africa-south1:marichihr-db` |
| `GCP_VPC_NETWORK` / `GCP_VPC_SUBNET` | `default` / `default` |
| `MARICHI_API_URL` | `https://api.<your-domain>/api/v1` |

Until `GCP_PROJECT_ID` is set, the pipeline only builds and checks. After it is set, every push to `main` deploys. Use Actions › "CI and deploy (Cloud Run)" › **Run workflow** to deploy by hand.

## Domains and DNS

### Map the domains to Cloud Run

Domain mapping is available in some regions only. In the others, put a global external Application Load Balancer with serverless NEGs in front.

```bash
gcloud beta run domain-mappings create --service=marichihr-web --domain=app.<your-domain> --region=REGION
gcloud beta run domain-mappings create --service=marichihr-api --domain=api.<your-domain> --region=REGION
```

Create the DNS records the command prints (usually CNAME `ghs.googlehosted.com.`). Google issues the TLS certificates.

### Then

- set `CLIENT_URL=https://app.<your-domain>` in `deploy/gcp/env.yaml`;
- set `MARICHI_API_URL=https://api.<your-domain>/api/v1` in the GitHub variables;
- run the workflow again.

### Email (Mandrill) DNS for the sending domain (marichisolutions.com)

Mandrill shows the exact values under Settings › Domains. Add:

- **SPF:** add `include:spf.mandrillapp.com` to the domain's existing SPF TXT record. Keep a single SPF record, e.g. `v=spf1 include:spf.mandrillapp.com include:_spf.google.com ~all`.
- **DKIM:**
  - Mandrill's current setup uses two CNAME records: `mte1._domainkey` → `dkim1.mandrillapp.com` and `mte2._domainkey` → `dkim2.mandrillapp.com`.
  - Older accounts use one TXT record at `mandrill._domainkey`. Use whichever Mandrill shows for the domain.
- **Verification:** the TXT record Mandrill gives (`mandrill_verify.…`).
- **DMARC (required by Mandrill since 2024, at least `p=none`):**
  - If the domain has no DMARC record, add TXT `_dmarc` = `v=DMARC1; p=none; rua=mailto:dmarc@marichisolutions.com`.
  - If one already exists, leave it as it is.

Then press "Test DNS settings" in Mandrill. Mail only leaves when `EMAIL_TRANSPORT=smtp` (already in `env.yaml`).

## After the first deploy

- Open `https://api.<domain>/health/ready`. It should report the database and Redis as ok.
- Sign in, then download a payslip PDF. This checks Chromium in the image.
- Upload a document. This checks the bucket.
- In Cloud Run › marichihr-worker › Logs you should see the jobs being scheduled.

## Monitoring and running costs

- Uptime check on `/health/ready`; see `docs/operations` for the 99.9% checklist.
- Running all the time:
  - API min 1 instance;
  - worker 1 instance with CPU always on;
  - Cloud SQL;
  - Memorystore.

  Web scales to zero.

## Other hosts

The same images run anywhere Docker runs:

- API: `node dist/server.js`.
- Worker: `node dist/worker.js` with `WORKER_HEALTH=true` if the host needs a port.
- Migrations: `npx prisma migrate deploy --schema ../../packages/database/prisma/schema.prisma`.

Render (API, Node) and Vercel (web, `apps/web/vercel.json`) keep deploying from the repository as before.
