import {
  forgetServerToken,
  rememberServerToken,
  rewriteServerUrls,
  serverBase,
  serverToken,
} from './serverConfig';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'ApiError';
  }
}

let unauthorized: (() => void) | null = null;
export function onUnauthorized(handler: () => void) {
  unauthorized = handler;
}

type Options = {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  form?: FormData;
  signal?: AbortSignal;
};

export async function api<T>(path: string, options: Options = {}): Promise<T> {
  const base = serverBase();
  const token = base ? serverToken() : null;
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${base}${path}`, {
    method: options.method ?? 'GET',
    // Server mode is cross-origin from the APK, so it authenticates with the
    // bearer token instead of cookies.
    credentials: base ? 'omit' : 'include',
    headers,
    body: options.form ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
    signal: options.signal,
  });

  const text = await response.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!response.ok) {
    if (response.status === 401) {
      if (base) forgetServerToken();
      unauthorized?.();
    }
    const message =
      data && typeof data === 'object' && 'error' in data
        ? String((data as { error: string }).error)
        : `Request failed (${response.status})`;
    throw new ApiError(response.status, message);
  }

  if (base) {
    // Sign-in responses carry the session token; keep it for later requests.
    if (data && typeof data === 'object' && typeof (data as { token?: unknown }).token === 'string' && path.startsWith('/api/auth/')) {
      rememberServerToken((data as { token: string }).token);
    }
    if (path === '/api/auth/logout') forgetServerToken();
    data = rewriteServerUrls(data);
  }
  return data as T;
}

export type UploadedFile = {
  id: string;
  url: string;
  name: string;
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
  isImage: boolean;
};

/** Downscales large photos in the browser so uploads stay small and fast. */
export async function prepareImage(file: File): Promise<{ blob: Blob; width: number; height: number; name: string } | null> {
  if (!file.type.startsWith('image/') || file.type === 'image/gif' || file.type === 'image/svg+xml') return null;
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return null;
  const maxSide = 1600;
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.size < 1.5 * 1024 * 1024) {
    bitmap.close?.();
    return null;
  }
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();
  const type = file.type === 'image/png' ? 'image/png' : 'image/webp';
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.86));
  if (!blob) return null;
  const name = file.name.replace(/\.[a-z0-9]+$/i, '') + (type === 'image/png' ? '.png' : '.webp');
  return { blob, width, height, name };
}

export async function uploadFile(
  file: File,
  onProgress?: (fraction: number) => void,
): Promise<UploadedFile> {
  const prepared = await prepareImage(file);
  const body = prepared?.blob ?? file;
  const filename = prepared?.name ?? file.name;

  // XHR keeps upload progress available (fetch still lacks it in most browsers).
  return new Promise<UploadedFile>((resolve, reject) => {
    const form = new FormData();
    form.append('file', body, filename);
    if (prepared) {
      form.append('width', String(prepared.width));
      form.append('height', String(prepared.height));
    }
    const base = serverBase();
    const token = base ? serverToken() : null;
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${base}/api/uploads`);
    xhr.withCredentials = !base;
    if (token) xhr.setRequestHeader('authorization', `Bearer ${token}`);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) onProgress(event.loaded / event.total);
    };
    xhr.onload = () => {
      try {
        const parsed = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300) resolve(rewriteServerUrls(parsed.upload) as UploadedFile);
        else reject(new ApiError(xhr.status, parsed.error || 'Upload failed'));
      } catch {
        reject(new ApiError(xhr.status, 'Upload failed'));
      }
    };
    xhr.onerror = () => reject(new ApiError(0, 'Upload failed — check your connection'));
    xhr.send(form);
  });
}
