import type { CSSProperties, ReactNode } from 'react';
import { badgeDefinition, useBadgeCatalog } from '../lib/badges';
import { cx } from '../lib/util';

/**
 * Hand-drawn badge art. Every glyph is a single 24x24 path set so it stays crisp
 * at any size and inherits the badge colour from CSS.
 */
const ART: Record<string, ReactNode> = {
  crown: (
    <>
      <path d="M3 17.4h18M3 17.4 2.2 7.4l5.2 3.8L12 4.2l4.6 7 5.2-3.8-1 10" />
      <path d="M7.6 20.2h8.8" />
    </>
  ),
  sparkle: (
    <>
      <path d="M10.6 2.6 12.2 7l4.4 1.6-4.4 1.6-1.6 4.4-1.6-4.4L4.6 8.6 9 7z" />
      <path d="m18 14.4.9 2.5 2.5.9-2.5.9-.9 2.5-.9-2.5-2.5-.9 2.5-.9z" />
    </>
  ),
  shield: (
    <>
      <path d="M12 2.8 20 6v6.1c0 4.6-3.4 7.9-8 9.1-4.6-1.2-8-4.5-8-9.1V6z" />
      <path d="m8.4 11.9 2.5 2.5 4.8-5.1" />
    </>
  ),
  terminal: (
    <>
      <rect x="2.6" y="4.2" width="18.8" height="15.6" rx="2.4" />
      <path d="m6.8 9.6 2.6 2.6-2.6 2.6M12.4 15h5" />
    </>
  ),
  flask: (
    <>
      <path d="M9.4 2.8h5.2M10.2 2.8v5.4L4.9 18a2.2 2.2 0 0 0 1.9 3.3h10.4a2.2 2.2 0 0 0 1.9-3.3L13.8 8.2V2.8" />
      <path d="M7.6 14.6h8.8" />
      <path d="M10.8 17.4h.01M14.2 18.8h.01" />
    </>
  ),
  heart: (
    <>
      <path d="M12 20.4S3.6 15.4 3.6 9.6a4.6 4.6 0 0 1 8.4-2.6 4.6 4.6 0 0 1 8.4 2.6c0 5.8-8.4 10.8-8.4 10.8z" />
      <path d="M6.6 12h2.8l1.4-2.2 1.9 4.2 1.3-2h3.4" />
    </>
  ),
  bolt: <path d="M13.4 2.4 4.8 13.5h5.9l-1.1 8.1 8.6-11.1h-5.9z" />,
  star: <path d="m12 2.8 2.8 5.7 6.3.9-4.6 4.4 1.1 6.3-5.6-3-5.6 3 1.1-6.3L3 9.4l6.2-.9z" />,
};

export function BadgeGlyph({ icon, size = 14 }: { icon: string; size?: number }) {
  return (
    <svg
      className="badge-glyph"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {ART[icon] ?? ART.star}
    </svg>
  );
}

export function BadgeChip({
  badgeKey,
  showLabel = false,
  size = 13,
  className,
}: {
  badgeKey: string;
  showLabel?: boolean;
  size?: number;
  className?: string;
}) {
  const { catalog } = useBadgeCatalog();
  const definition = catalog?.find((badge) => badge.key === badgeKey) ?? badgeDefinition(badgeKey);
  const color = definition?.color ?? '#b9b9c0';
  const name = definition?.name ?? badgeKey.replace(/_/g, ' ');
  const title = definition ? `${name} — ${definition.description}` : name;
  return (
    <span
      className={cx('badge-chip', showLabel && 'badge-chip-labeled', className)}
      style={{ '--badge-color': color } as CSSProperties}
      title={title}
    >
      <BadgeGlyph icon={definition?.icon ?? 'star'} size={size} />
      {showLabel && <span className="badge-chip-label">{name}</span>}
    </span>
  );
}

export function BadgeStack({ keys, max = 3 }: { keys?: string[]; max?: number }) {
  if (!keys || keys.length === 0) return null;
  const shown = keys.slice(0, max);
  const extra = keys.length - shown.length;
  return (
    <span className="badge-stack" aria-label={`Badges: ${keys.join(', ')}`}>
      {shown.map((key) => (
        <BadgeChip key={key} badgeKey={key} size={11} />
      ))}
      {extra > 0 && <span className="badge-more">+{extra}</span>}
    </span>
  );
}
