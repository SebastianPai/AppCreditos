import Link from 'next/link';
import type { ReactNode } from 'react';
import { ROLE_LABEL, type SessionProfile } from '@/lib/auth';
import { NavLinks, type NavItem } from './nav-links';
import { OnlineStatus } from './pwa';
import { SignOutButton } from './loading-screen';

const NAV: Record<SessionProfile['role'], NavItem[]> = {
  admin: [
    { href: '/admin', label: 'Inicio', icon: 'home' },
    { href: '/admin/solicitudes', label: 'Solicitudes', icon: 'inbox' },
    { href: '/admin/prestamos', label: 'Préstamos', icon: 'cash' },
    { href: '/admin/pagos', label: 'Verificar pagos', icon: 'check' },
    { href: '/admin/clientes', label: 'Clientes', icon: 'users' },
    { href: '/admin/capital', label: 'Capital', icon: 'bank' },
    { href: '/admin/comisiones', label: 'Cobradores', icon: 'bike' },
    { href: '/admin/liquidaciones', label: 'Liquidaciones', icon: 'scale' },
    { href: '/admin/reportes', label: 'Reportes', icon: 'chart' },
    { href: '/admin/usuarios', label: 'Usuarios', icon: 'key' },
    { href: '/admin/eliminaciones', label: 'Eliminaciones', icon: 'trash' },
    { href: '/admin/configuracion', label: 'Configuración', icon: 'gear' },
    { href: '/admin/auditoria', label: 'Auditoría', icon: 'eye' },
  ],
  collector: [
    { href: '/cobrador', label: 'Inicio', icon: 'home' },
    { href: '/cobrador/clientes/nuevo', label: 'Nuevo cliente', icon: 'plus' },
    { href: '/cobrador/prestamos/nuevo', label: 'Préstamo', icon: 'cash' },
    { href: '/cobrador/clientes', label: 'Clientes', icon: 'users' },
  ],
  partner: [
    { href: '/socio', label: 'Resumen', icon: 'home' },
    { href: '/notificaciones', label: 'Avisos', icon: 'bell' },
  ],
  customer: [
    { href: '/cliente', label: 'Inicio', icon: 'home' },
    { href: '/cliente/puntaje', label: 'Mi puntaje', icon: 'star' },
    { href: '/cliente/simular', label: 'Simular', icon: 'calc' },
    { href: '/cliente/pagar', label: 'Pagar', icon: 'qr' },
  ],
};

export function AppShell({ profile, children }: { profile: SessionProfile; children: ReactNode }) {
  const items = NAV[profile.role];
  return (
    <div className="min-h-dvh lg:flex">
      <aside className="no-print hidden w-64 shrink-0 border-r border-slate-200 bg-white lg:block">
        <div className="sticky top-0 flex h-dvh flex-col p-4">
          <Link href="/" className="mb-6 flex items-center gap-2 px-2 text-lg font-bold text-brand-700">
            <img src="/icons/icon-192.png" alt="" className="size-8 rounded-lg" /> Capital Control
          </Link>
          <NavLinks items={items} variant="sidebar" />
          <div className="mt-auto border-t border-slate-200 pt-4 text-sm">
            <p className="font-medium">{profile.full_name}</p>
            <p className="text-slate-500">{ROLE_LABEL[profile.role]}</p>
            <form action="/auth/signout" method="post" className="mt-3">
              <SignOutButton className="btn-secondary btn-sm w-full" />
            </form>
          </div>
        </div>
      </aside>

      <div className="min-w-0 flex-1">
        <header className="no-print sticky top-0 z-20 flex items-center justify-between border-b border-slate-200 bg-white/95 px-4 py-3 backdrop-blur lg:hidden">
          <Link href="/" className="flex items-center gap-2 font-bold text-brand-700">
            <img src="/icons/icon-192.png" alt="" className="size-7 rounded-lg" /> Capital
          </Link>
          <details className="relative">
            <summary className="btn-secondary btn-sm list-none">{profile.full_name.split(' ')[0]} ▾</summary>
            <div className="absolute right-0 z-30 mt-2 w-60 rounded-xl border border-slate-200 bg-white p-2 shadow-lg">
              <p className="px-2 pt-1 text-xs text-slate-500">{ROLE_LABEL[profile.role]}</p>
              {items.length > 5 && <NavLinks items={items.slice(4)} variant="menu" />}
              <Link href="/instalar" className="block rounded-lg px-2 py-2 text-sm hover:bg-slate-50">📲 Descargar la app</Link>
              <form action="/auth/signout" method="post">
                <SignOutButton className="w-full rounded-lg px-2 py-2 text-left text-sm text-red-700 hover:bg-red-50" />
              </form>
            </div>
          </details>
        </header>
        <OnlineStatus />
        <main className="mx-auto w-full max-w-6xl px-4 pt-5 pb-28 lg:px-8 lg:pb-10">{children}</main>
        <nav className="no-print fixed inset-x-0 bottom-0 z-20 border-t border-slate-200 bg-white pb-[env(safe-area-inset-bottom)] lg:hidden">
          <NavLinks items={items.slice(0, items.length > 5 ? 4 : 5)} variant="bottom" />
        </nav>
      </div>
    </div>
  );
}
