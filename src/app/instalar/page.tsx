import Link from 'next/link';
import { InstallPrompt, ShareInstallLink } from '@/components/pwa';
import { Card, PageHeader } from '@/components/ui';

export const metadata = { title: 'Instalar la aplicación' };

// Página pública: se puede enviar el enlace por WhatsApp para que cualquiera instale la app
// antes de iniciar sesión.
export default function InstallPage() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-6">
      <Link href="/" className="mb-4 inline-block text-sm text-brand-700">← Inicio</Link>
      <PageHeader title="Instalar Capital Control" subtitle="Descárguela en su celular con un toque. Es gratis, no necesita Play Store y se actualiza sola." />
      <div className="space-y-4">
        <Card>
          <InstallPrompt />
        </Card>
        <Card title="¿Instalarla en otro celular?">
          <p className="mb-3 text-sm text-slate-600">Envíe este enlace por WhatsApp o SMS. La persona solo tiene que abrirlo en Chrome y tocar <strong>Descargar</strong>.</p>
          <ShareInstallLink />
        </Card>
        <Card title="Android (Chrome)">
          <ol className="list-decimal space-y-1 pl-5 text-sm text-slate-700">
            <li>Abra este enlace en Google Chrome.</li>
            <li>Toque el botón <strong>Instalar Capital Control</strong> de arriba, o el menú <strong>⋮</strong> → <strong>Instalar aplicación</strong>.</li>
            <li>Confirme. El icono aparecerá en su pantalla de inicio.</li>
            <li>Para notificaciones: abra la app → <strong>Avisos</strong> → <strong>Activar notificaciones</strong> → <strong>Permitir</strong>.</li>
          </ol>
        </Card>
        <Card title="iPhone (Safari)">
          <ol className="list-decimal space-y-1 pl-5 text-sm text-slate-700">
            <li>Abra este enlace en <strong>Safari</strong> (no funciona desde otros navegadores en iOS).</li>
            <li>Toque <strong>Compartir</strong> (cuadro con flecha hacia arriba).</li>
            <li>Elija <strong>Añadir a pantalla de inicio</strong> y luego <strong>Añadir</strong>.</li>
            <li>Abra la app <strong>desde el icono</strong> de la pantalla de inicio.</li>
            <li>Para notificaciones (iOS 16.4 o superior): dentro de la app → <strong>Avisos</strong> → <strong>Activar notificaciones</strong> → <strong>Permitir</strong>.</li>
          </ol>
        </Card>
        <Card title="Actualizaciones">
          <p className="text-sm text-slate-700">
            La aplicación se actualiza sola. Cuando haya una versión nueva verá el aviso <em>«Hay una nueva versión disponible»</em>; toque{' '}
            <strong>Actualizar ahora</strong>.
          </p>
        </Card>
      </div>
    </main>
  );
}
