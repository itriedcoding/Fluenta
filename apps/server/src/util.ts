import type { Context } from 'hono';
import type { ZodError } from 'zod';

export function bad(c: Context, message: string | ZodError, status = 400) {
  const text =
    typeof message === 'string'
      ? message
      : message.issues
          .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
          .join('; ');
  return c.json({ error: text || 'Invalid request' }, status as 400);
}

export function clientIp(c: Context): string {
  const forwarded = c.req.header('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  return c.req.header('x-real-ip') || 'local';
}

type Bucket = { count: number; reset: number };
const buckets = new Map<string, Bucket>();

setInterval(() => {
  const ts = Date.now();
  for (const [key, bucket] of buckets) if (bucket.reset < ts) buckets.delete(key);
}, 60_000).unref();

/** Fixed-window limiter. Returns false when the caller is over budget. */
export function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const ts = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.reset < ts) {
    buckets.set(key, { count: 1, reset: ts + windowMs });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= limit;
}

export function limiter(c: Context, name: string, limit: number, windowMs: number, userId?: string) {
  return rateLimit(`${name}:${userId ?? clientIp(c)}`, limit, windowMs);
}

/** Removes control characters and normalises newlines; length is enforced by the schema. */
export function cleanText(value: string): string {
  return value
    .replace(/\r\n/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim();
}

export function intParam(value: string | undefined, fallback: number, min: number, max: number) {
  const parsed = Number.parseInt(value ?? '', 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function uniqueName(base: string, exists: (candidate: string) => boolean, max = 24): string {
  const clean = base.toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, max).replace(/^[-_.]+/, '');
  const seed = clean || 'user';
  if (!exists(seed)) return seed;
  for (let i = 1; i < 10_000; i++) {
    const candidate = `${seed.slice(0, max - String(i).length - 1)}-${i}`;
    if (!exists(candidate)) return candidate;
  }
  return `${seed}-${Date.now().toString(36)}`;
}
