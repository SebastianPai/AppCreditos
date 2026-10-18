import { AppShell } from '@/components/app-shell';
import { ActionForm } from '@/components/action-form';
import { PushToggle } from '@/components/pwa';
import { Card, Notice, PageHeader } from '@/components/ui';
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
      <PageHeader title="Notificaciones" subtitle="Reciba avisos en este dispositivo aunque la app esté cerrada." />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="¿Para qué sirven?">
          <p className="text-sm text-slate-700">
            Le avisamos de vencimientos, pagos confirmados y tareas pendientes para que no se le pase nada. Los avisos{' '}
            <strong>nunca muestran importes, documentos ni nombres</strong> en la pantalla bloqueada: solo indican que hay una novedad.
          </p>
          <div className="mt-4">
            <PushToggle vapidPublicKey={publicEnv.vapidPublicKey} initiallyEnabled={Boolean(prefs?.push_enabled)} />
          </div>
          <div className="mt-4">
            <Notice tone="info">
              <strong>Android:</strong> pulse «Activar» y luego «Permitir». <strong>iPhone:</strong> primero instale la app (Compartir → Añadir a pantalla de
              inicio), ábrala desde el icono y pulse «Activar». Requiere iOS 16.4 o superior.
            </Notice>
          </div>
        </Card>
        <Card title="¿Qué avisos quiere recibir?">
          <ActionForm action={savePreferences} submitLabel="Guardar preferencias">
            {options.map((o) => (
              <label key={o.key} className="flex items-center gap-3 text-sm">
                <input type="checkbox" name={o.key} defaultChecked={Boolean(prefs?.[o.key as keyof typeof prefs])} className="size-5" />
                {o.label}
              </label>
            ))}
          </ActionForm>
        </Card>
      </div>
    </AppShell>
  );
}
