/** Numeric components of a semver-ish tag, ignoring a leading `v`. */
export function versionParts(version: string): number[] {
  return (version.replace(/^v/i, '').match(/\d+/g) ?? []).slice(0, 3).map((part) => Number(part));
}

/** True when `latest` is a newer release than `current`. */
export function isNewerVersion(latest: string, current: string): boolean {
  const a = versionParts(latest);
  const b = versionParts(current);
  if (a.length === 0) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left > right) return true;
    if (left < right) return false;
  }
  return false;
}
