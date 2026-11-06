import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { config } from '../config.ts';
import { get, run } from '../db.ts';
import { requireAuth, type Env } from '../auth.ts';
import { bad, limiter } from '../util.ts';
import { now, uid } from '../ids.ts';

const router = new Hono<Env>();

const ALLOWED = new Map<string, string>([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif'],
  ['image/avif', 'avif'],
  ['application/pdf', 'pdf'],
  ['text/plain', 'txt'],
  ['text/markdown', 'md'],
  ['application/zip', 'zip'],
  ['audio/mpeg', 'mp3'],
  ['audio/ogg', 'ogg'],
  ['audio/webm', 'weba'],
  ['audio/wav', 'wav'],
  ['video/mp4', 'mp4'],
  ['video/webm', 'webm'],
]);

function startsWithBytes(buf: Buffer, bytes: number[]): boolean {
  if (buf.length < bytes.length) return false;
  return bytes.every((b, i) => buf[i] === b);
}

function sniff(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  if (startsWithBytes(buf, [0x89, 0x50, 0x4e, 0x47])) return 'image/png';
  if (startsWithBytes(buf, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (buf.subarray(0, 3).toString('ascii') === 'GIF') return 'image/gif';
  if (buf.subarray(0, 4).toString('ascii') === '%PDF') return 'application/pdf';
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  if (buf.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = buf.subarray(8, 12).toString('ascii');
    if (brand.startsWith('avi')) return 'image/avif';
    return 'video/mp4';
  }
  if (buf.subarray(0, 4).toString('ascii') === 'OggS') return 'audio/ogg';
  if (buf.subarray(0, 4).toString('ascii') === 'PK\u0003\u0004') return 'application/zip';
  if (startsWithBytes(buf, [0x1a, 0x45, 0xdf, 0xa3])) return 'video/webm';
  return null;
}

function classify(file: File, head: Buffer): string | null {
  if (file.type.startsWith('text/')) {
    const allowed = ALLOWED.get(file.type);
    if (allowed) return file.type;
  }
  const sniffed = sniff(head);
  if (sniffed && ALLOWED.has(sniffed)) {
    if (file.type === sniffed) return sniffed;
    // The WebM container carries both audio and video recordings
    if (sniffed === 'video/webm' && (file.type === 'audio/webm' || file.type === 'video/webm')) {
      return file.type;
    }
    return sniffed;
  }
  if (ALLOWED.has(file.type)) return file.type;
  return null;
}

/** POST /api/uploads — multipart form with a single `file` field. */
router.post('/', requireAuth, async (c) => {
  const auth = c.get('auth');
  if (!limiter(c, 'upload', 40, 60_000, auth.user.id)) return bad(c, 'Slow down a little', 429);

  const body = (await c.req.parseBody().catch(() => null)) as Record<string, string | File> | null;
  const file = body?.file;
  if (!(file instanceof File)) return bad(c, 'No file was uploaded');
  if (file.size === 0) return bad(c, 'File is empty');
  if (file.size > config.maxUploadBytes) {
    return bad(c, `File is too large (max ${Math.round(config.maxUploadBytes / 1024 / 1024)} MB)`, 413);
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const mime = classify(file, buffer.subarray(0, 32));
  if (!mime) return bad(c, 'That file type is not supported', 415);

  const ext = ALLOWED.get(mime) ?? 'bin';
  const id = uid('up_');
  const filename = `${id}.${ext}`;
  fs.writeFileSync(path.join(config.dataDir, 'uploads', filename), buffer);

  const width = Number(body?.width) || null;
  const height = Number(body?.height) || null;
  run(
    `INSERT INTO uploads (id, owner_id, name, mime, size, width, height, ext, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    auth.user.id,
    (file.name || 'file').slice(0, 180),
    mime,
    buffer.length,
    width,
    height,
    ext,
    now(),
  );
  return c.json(
    {
      upload: {
        id,
        url: `/api/uploads/${id}`,
        name: (file.name || 'file').slice(0, 180),
        mime,
        size: buffer.length,
        width,
        height,
        isImage: mime.startsWith('image/'),
      },
    },
    201,
  );
});

/**
 * GET /api/uploads/:id — attachments are bearer-accessible via an unguessable
 * 96-bit id, so <img>/<video> tags work on every platform without header auth.
 */
router.get('/:id', (c) => {
  const id = c.req.param('id');
  const row = get<{ mime: string; ext: string; name: string; size: number }>(
    'SELECT mime, ext, name, size FROM uploads WHERE id = ?',
    id,
  );
  if (!row) return c.notFound();
  const file = path.join(config.dataDir, 'uploads', `${id}.${row.ext}`);
  if (!fs.existsSync(file)) return c.notFound();
  const inline = row.mime.startsWith('image/') || row.mime.startsWith('video/') || row.mime.startsWith('audio/') || row.mime === 'application/pdf';
  const safeName = row.name.replace(/["\\\r\n]/g, '_');
  return new Response(fs.readFileSync(file), {
    headers: {
      'content-type': row.mime,
      'content-length': String(row.size),
      'cache-control': 'public, max-age=31536000, immutable',
      'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${safeName}"`,
      'x-content-type-options': 'nosniff',
    },
  });
});

export default router;
