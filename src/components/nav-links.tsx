'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

export interface NavItem {
  href: string;
  label: string;
  icon: keyof typeof ICONS;
}

const ICONS = {
  home: 'M3 11l9-8 9 8v9a1 1 0 01-1 1h-5v-6H9v6H4a1 1 0 01-1-1z',
  inbox: 'M4 4h16v10h-5l-1 3h-4l-1-3H4z',
  cash: 'M3 7h18v10H3zM12 9a3 3 0 100 6 3 3 0 000-6z',
  check: 'M5 13l4 4L19 7',
  users: 'M16 11a4 4 0 10-8 0 4 4 0 008 0zM4 21a8 8 0 0116 0',
  bank: 'M3 10l9-6 9 6M5 10v8m4-8v8m6-8v8m4-8v8M3 20h18',
  bike: 'M5 17a3 3 0 100-6 3 3 0 000 6zm14 0a3 3 0 100-6 3 3 0 000 6zM8 14l4-6h4l3 6M12 8l-2-3H8',
  scale: 'M12 3v18M5 7h14M5 7l-3 7a3 3 0 006 0zm14 0l-3 7a3 3 0 006 0z',
  chart: 'M4 20V10m6 10V4m6 16v-7m4 7H2',
  key: 'M15 7a4 4 0 11-3.9 5H3v3h3v3h3v-3h2.1A4 4 0 0115 7z',
  gear: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19 12l2-1-1-3-2 .5-1.5-1.5.5-2-3-1-1 2h-2l-1-2-3 1 .5 2L7 7.5 5 7 4 10l2 1v2l-2 1 1 3 2-.5L8.5 16 8 18l3 1 1-2h2l1 2 3-1-.5-2 1.5-1.5 2 .5 1-3-2-1z',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zm10 3a3 3 0 100-6 3 3 0 000 6z',
  bell: 'M6 8a6 6 0 1112 0c0 7 3 9 3 9H3s3-2 3-9zM10 21h4',
  calc: 'M6 3h12v18H6zM9 7h6M9 12h1m4 0h1m-6 4h1m4 0h1',
  qr: 'M4 4h6v6H4zm10 0h6v6h-6zM4 14h6v6H4zm10 0h2v2h-2zm4 0h2v6h-6v-2',
};

function Icon({ name }: { name: NavItem['icon'] }) {
  return (
    <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={ICONS[name]} />
    </svg>
  );
}

export function NavLinks({ items, variant }: { items: NavItem[]; variant: 'sidebar' | 'bottom' | 'menu' }) {
  const path = usePathname();
  // La raíz de cada rol (/admin, /cobrador…) solo se marca en coincidencia exacta.
  const isRoot = (href: string) => href.split('/').length === 2;
  const active = (href: string) => path === href || (!isRoot(href) && path.startsWith(`${href}/`));

  if (variant === 'bottom') {
    return (
      <ul className="grid" style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}>
        {items.map((i) => (
          <li key={i.href}>
            <Link
              href={i.href}
              className={`flex flex-col items-center gap-0.5 py-2 text-[11px] font-medium ${active(i.href) ? 'text-brand-700' : 'text-slate-500'}`}
              aria-current={active(i.href) ? 'page' : undefined}
            >
              <Icon name={i.icon} />
              {i.label}
            </Link>
          </li>
        ))}
      </ul>
    );
  }
  return (
    <ul className="space-y-0.5">
      {items.map((i) => (
        <li key={i.href}>
          <Link
            href={i.href}
            className={`flex items-center gap-3 rounded-lg px-2 py-2 text-sm ${active(i.href) ? 'bg-brand-50 font-semibold text-brand-700' : 'text-slate-700 hover:bg-slate-50'}`}
            aria-current={active(i.href) ? 'page' : undefined}
          >
            <Icon name={i.icon} />
            {i.label}
          </Link>
        </li>
      ))}
    </ul>
  );
}
