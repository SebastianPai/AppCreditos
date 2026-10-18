import { AppShell } from '@/components/app-shell';
import { ActionForm } from '@/components/action-form';
import { PushToggle } from '@/components/pwa';
import { Card, MoreSection, PageHeader } from '@/components/ui';
import { requireRole, userDb } from '@/lib/auth';
import { notificationOptionsFor } from '@/lib/notification-options';
import { publicEnv } from '@/lib/env';
import { savePreferences } from './actions';

export const metadata = { title: 'Notificaciones' };

export default async function NotificationsPage() {
  const profile = await requireRole('admin', 'collector', 'partner', 'customer');
  const db = await userDb();
  const prefs = await db.one('select * from public.notification_preferences where user_id = $1', [profile.id]);
  const options = notificationOptionsFor(profile.role);

  return (
    <AppShell profile={profile}>
      <PageHeader title="Avisos" subtitle="Vencimientos, pagos y tareas, aunque la app esté cerrada." />
      <Card>
        <PushToggle vapidPublicKey={publicEnv.vapidPublicKey} initiallyEnabled={Boolean(prefs?.push_enabled)} />
        <p className="mt-3 text-xs text-slate-500">Nunca mostramos importes ni datos personales en la pantalla bloqueada.</p>
      </Card>

      <MoreSection label="¿Cómo activarlas?" className="mt-4">
        <Card>
          <ul className="space-y-2 text-sm text-slate-700">
            <li><strong>Android:</strong> toque «Activar notificaciones» y luego «Permitir».</li>
            <li>
              <strong>iPhone (iOS 16.4+):</strong> en Safari, Compartir → «Añadir a pantalla de inicio». Abra la app desde el icono y toque «Activar».
            </li>
          </ul>
        </Card>
      </MoreSection>

      <MoreSection label="Elegir qué avisos recibir" className="mt-3">
        <Card>
          <ActionForm action={savePreferences} submitLabel="Guardar">
            {options.map((o) => (
              <label key={o.key} className="flex items-center gap-3 text-sm">
                <input type="checkbox" name={o.key} defaultChecked={Boolean(prefs?.[o.key as keyof typeof prefs])} className="size-5" />
                {o.label}
              </label>
            ))}
          </ActionForm>
        </Card>
      </MoreSection>
    </AppShell>
  );
}
