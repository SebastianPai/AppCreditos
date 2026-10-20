'use client';
import { useLinkStatus } from 'next/link';
import { useFormStatus } from 'react-dom';

/** Pantalla de carga mientras llega la página (loading.tsx). */
export function LoadingScreen() {
  return (
    <div className="flex min-h-[50dvh] flex-col items-center justify-center gap-3 text-slate-500" role="status">
      <Spinner className="size-8" />
      <p className="text-sm">Cargando…</p>
    </div>
  );
}

export function Spinner({ className = 'size-4' }: { className?: string }) {
  return <span aria-hidden className={`inline-block animate-spin rounded-full border-2 border-current border-t-transparent ${className}`} />;
}

/** Va dentro de un <Link>: muestra un indicador apenas se toca, aunque la red sea lenta. */
export function LinkPending({ children }: { children?: React.ReactNode }) {
  const { pending } = useLinkStatus();
  return pending ? <Spinner /> : <>{children}</>;
}

/** Botón de cerrar sesión que muestra «Saliendo…» de inmediato. */
export function SignOutButton({ className }: { className: string }) {
  const { pending } = useFormStatus();
  return <button className={className} disabled={pending}>{pending ? 'Saliendo…' : 'Cerrar sesión'}</button>;
}
