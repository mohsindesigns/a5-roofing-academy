import {
  CopyObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Readable } from 'node:stream';
import type { ObjectHead, ObjectStorage, SignedUrlOptions, UploadTarget } from './types.js';

export interface S3StorageOptions {
  bucket: string;
  region: string;
  endpoint?: string;
  /** Endpoint used in URLs handed to browsers (e.g. CDN or public MinIO address). */
  publicEndpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle?: boolean;
}

export class S3Storage implements ObjectStorage {
  readonly driver = 's3' as const;
  private readonly client: S3Client;
  private readonly publicClient: S3Client;

  constructor(private readonly options: S3StorageOptions) {
    const credentials =
      options.accessKeyId && options.secretAccessKey
        ? { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey }
        : undefined;
    const base = { region: options.region, forcePathStyle: options.forcePathStyle ?? Boolean(options.endpoint), credentials };
    this.client = new S3Client({ ...base, endpoint: options.endpoint });
    this.publicClient = new S3Client({ ...base, endpoint: options.publicEndpoint ?? options.endpoint });
  }

  async putObject(key: string, body: Buffer | Readable, options: { contentType: string; contentLength?: number }) {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.options.bucket,
        Key: key,
        Body: body,
        ContentType: options.contentType,
        ContentLength: options.contentLength ?? (Buffer.isBuffer(body) ? body.length : undefined),
      }),
    );
  }

  async getObject(key: string) {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.options.bucket, Key: key }));
    return { body: res.Body as Readable, contentType: res.ContentType ?? null, size: res.ContentLength ?? 0 };
  }

  async getBytes(key: string, range?: { start: number; end: number }) {
    const res = await this.client.send(
      new GetObjectCommand({
        Bucket: this.options.bucket,
        Key: key,
        Range: range ? `bytes=${range.start}-${range.end}` : undefined,
      }),
    );
    const chunks: Buffer[] = [];
    for await (const chunk of res.Body as Readable) chunks.push(Buffer.from(chunk as Uint8Array));
    return Buffer.concat(chunks);
  }

  async headObject(key: string): Promise<ObjectHead | null> {
    try {
      const res = await this.client.send(new HeadObjectCommand({ Bucket: this.options.bucket, Key: key }));
      return { size: res.ContentLength ?? 0, contentType: res.ContentType ?? null, etag: res.ETag ?? null };
    } catch (err) {
      const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404) return null;
      throw err;
    }
  }

  async deleteObject(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.options.bucket, Key: key }));
  }

  async deletePrefix(prefix: string) {
    let deleted = 0;
    let token: string | undefined;
    do {
      const list = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.options.bucket, Prefix: prefix, ContinuationToken: token }),
      );
      const keys = (list.Contents ?? []).map((o) => ({ Key: o.Key! }));
      if (keys.length) {
        await this.client.send(new DeleteObjectsCommand({ Bucket: this.options.bucket, Delete: { Objects: keys } }));
        deleted += keys.length;
      }
      token = list.IsTruncated ? list.NextContinuationToken : undefined;
    } while (token);
    return deleted;
  }

  async copyObject(sourceKey: string, targetKey: string) {
    await this.client.send(
      new CopyObjectCommand({
        Bucket: this.options.bucket,
        Key: targetKey,
        CopySource: `${this.options.bucket}/${encodeURIComponent(sourceKey).replace(/%2F/g, '/')}`,
      }),
    );
  }

  async createUploadTarget(
    key: string,
    options: { contentType: string; maxBytes: number; expiresInSeconds: number },
  ): Promise<UploadTarget> {
    const post = await createPresignedPost(this.publicClient, {
      Bucket: this.options.bucket,
      Key: key,
      Conditions: [
        ['content-length-range', 1, options.maxBytes],
        ['eq', '$Content-Type', options.contentType],
      ],
      Fields: { 'Content-Type': options.contentType },
      Expires: options.expiresInSeconds,
    });
    return {
      method: 'POST',
      url: post.url,
      fields: post.fields,
      headers: {},
      expiresAt: new Date(Date.now() + options.expiresInSeconds * 1000).toISOString(),
    };
  }

  async signedGetUrl(key: string, options: SignedUrlOptions) {
    return getSignedUrl(
      this.publicClient,
      new GetObjectCommand({
        Bucket: this.options.bucket,
        Key: key,
        ResponseContentDisposition: options.downloadName
          ? `attachment; filename="${options.downloadName.replace(/["\\\r\n]/g, '')}"`
          : undefined,
        ResponseContentType: options.contentType,
      }),
      { expiresIn: options.expiresInSeconds },
    );
  }

  async ping() {
    await this.client.send(new HeadBucketCommand({ Bucket: this.options.bucket }));
  }
}

export function toReadable(buffer: Buffer): Readable {
  return Readable.from(buffer);
}
