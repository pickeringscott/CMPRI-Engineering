import Image from 'next/image';
import { roomGroupBadge, type RoomGroupBadge } from '@/lib/room-group-badges';

const badges = {
  'railway-cn': { src: '/railway-cn-logo.png', alt: 'CN', width: 128, height: 83 },
  'big-ten': { src: '/big10.png', alt: 'Big Ten', width: 500, height: 300 },
  'flyover-studios': { src: '/FFS_Logo6.avif', alt: 'Flyover Film Studios', width: 906, height: 644 },
} as const;

export default function GuestGroupBadge({ group, badge, className = 'inline-block h-[27px] w-auto rounded-[4px] object-contain align-middle' }: {
  group?: string | null;
  badge?: RoomGroupBadge | null;
  className?: string;
}) {
  const key = badge ?? roomGroupBadge(group);
  if (!key || !Object.hasOwn(badges, key)) return null;
  const image = badges[key];
  return <Image src={image.src} alt={image.alt} width={image.width} height={image.height} className={className} />;
}
