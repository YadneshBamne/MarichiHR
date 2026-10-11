import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { v2 as cloudinary } from 'cloudinary'

// Private file storage for employee documents (CVs, ID scans, licences, letters). One interface, two providers:
//  STORAGE_PROVIDER=s3          any S3-compatible bucket: Filebase (default endpoint), Cloudflare R2, Backblaze B2, AWS
//                               S3_ENDPOINT, S3_REGION, S3_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY
//  STORAGE_PROVIDER=cloudinary  CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET
// Files are never public: downloads go through short-lived signed URLs handed out after an access check.

export interface Storage {
  provider: string
  put(key: string, body: Buffer, contentType: string): Promise<void>
  signedUrl(key: string, seconds: number, downloadName?: string): Promise<string>
  remove(key: string): Promise<void>
  exists(key: string): Promise<boolean>
}

function s3(): Storage {
  const { S3_ENDPOINT, S3_REGION, S3_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY } = process.env
  if (!S3_BUCKET || !S3_ACCESS_KEY || !S3_SECRET_KEY) throw new Error('S3 storage needs S3_BUCKET, S3_ACCESS_KEY and S3_SECRET_KEY')
  const client = new S3Client({
    endpoint: S3_ENDPOINT || 'https://s3.filebase.io',
    region: S3_REGION || 'us-east-1',
    credentials: { accessKeyId: S3_ACCESS_KEY, secretAccessKey: S3_SECRET_KEY },
    forcePathStyle: true,
  })
  const Bucket = S3_BUCKET
  return {
    provider: 's3',
    async put(Key, Body, ContentType) { await client.send(new PutObjectCommand({ Bucket, Key, Body, ContentType })) },
    signedUrl: (Key, expiresIn, name) => getSignedUrl(client, new GetObjectCommand({ Bucket, Key, ...(name && { ResponseContentDisposition: `attachment; filename="${name.replace(/["\\\r\n]/g, '')}"` }) }), { expiresIn }),
    async remove(Key) { await client.send(new DeleteObjectCommand({ Bucket, Key })) },
    async exists(Key) {
      try { await client.send(new HeadObjectCommand({ Bucket, Key })); return true } catch (e: any) { if (e?.$metadata?.httpStatusCode === 404 || e?.name === 'NotFound') return false; throw e }
    },
  }
}

function cloud(): Storage {
  const { CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET } = process.env
  if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) throw new Error('Cloudinary storage needs CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET')
  cloudinary.config({ cloud_name: CLOUDINARY_CLOUD_NAME, api_key: CLOUDINARY_API_KEY, api_secret: CLOUDINARY_API_SECRET, secure: true })
  const opts = { resource_type: 'raw' as const, type: 'private' as const }
  return {
    provider: 'cloudinary',
    put: (key, body) => new Promise((resolve, reject) => {
      cloudinary.uploader.upload_stream({ ...opts, public_id: key, overwrite: true }, (err) => (err ? reject(err) : resolve())).end(body)
    }),
    signedUrl: async (key, seconds, name) => cloudinary.utils.private_download_url(key, '', { ...opts, expires_at: Math.floor(Date.now() / 1000) + seconds, attachment: !!name }),
    async remove(key) { await cloudinary.uploader.destroy(key, opts) },
    async exists(key) { try { await cloudinary.api.resource(key, opts); return true } catch { return false } },
  }
}

let instance: Storage | null = null
export function storage(): Storage {
  if (!instance) instance = (process.env.STORAGE_PROVIDER || 's3') === 'cloudinary' ? cloud() : s3()
  return instance
}
export const storageConfigured = () => {
  const p = process.env.STORAGE_PROVIDER || 's3'
  return p === 'cloudinary' ? !!process.env.CLOUDINARY_API_SECRET : !!(process.env.S3_BUCKET && process.env.S3_ACCESS_KEY && process.env.S3_SECRET_KEY)
}
