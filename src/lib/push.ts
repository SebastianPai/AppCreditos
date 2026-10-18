import 'server-only';
import webpush from 'web-push';
import { systemDb } from '@/lib/db';
import { optionalServerEnv, publicEnv } from '@/lib/env';

/** Tipos de notificación ↔ columna de preferencia. */
export const NOTIFICATION_KINDS = {
  upcoming: 'upcoming_installments',
  due_today: 'due_today',
  payment_confirmed: 'payment_confirmed',
  balance: 'balance_updates',
  new_application: 'new_applications',
  new_assignment: 'new_assignments',
  daily_summary: 'daily_summary',
  settlement: 'settlements',
} as const;
export type NotificationKind = keyof typeof NOTIFICATION_KINDS;

/** Textos genéricos: nunca incluyen importes, documentos ni nombres (pantalla bloqueada). */
const MESSAGES: Record<NotificationKind, { title: string; body: string }> = {
  upcoming: { title: 'Cuota próxima', body: 'Tiene una cuota que vence mañana. Abra la app para ver el detalle.' },
  due_today: { title: 'Cuota para hoy', body: 'Tiene una cuota que vence hoy. Abra la app para ver el detalle.' },
  payment_confirmed: { title: 'Pago confirmado', body: 'Se confirmó un pago en su cuenta.' },
  balance: { title: 'Saldo actualizado', body: 'Su saldo cambió. Abra la app para consultarlo.' },
  new_application: { title: 'Nueva solicitud', body: 'Hay una solicitud o un pago pendiente de revisión.' },
  new_assignment: { title: 'Nueva asignación', body: 'Tiene nuevos cobros asignados.' },
  daily_summary: { title: 'Resumen del día', body: 'Su agenda de hoy está lista.' },
  settlement: { title: 'Liquidación pendiente', body: 'Hay una liquidación pendiente de aprobación.' },
};

export function pushConfigured(): boolean {
  const env = optionalServerEnv();
  return Boolean(publicEnv.vapidPublicKey && env.vapidPrivateKey && env.vapidSubject);
}

let configured = false;
function configure() {
  if (configured) return true;
  if (!pushConfigured()) return false;
  const env = optionalServerEnv();
  webpush.setVapidDetails(env.vapidSubject, publicEnv.vapidPublicKey, env.vapidPrivateKey);
  configured = true;
  return true;
}

/** Envía la notificación a quienes la tengan habilitada. Nunca lanza: los avisos no bloquean operaciones. */
export async function notifyUsers(userIds: string[], kind: NotificationKind, url = '/'): Promise<number> {
  if (!userIds.length || !configure()) return 0;
  try {
    const db = systemDb();
    const column = NOTIFICATION_KINDS[kind];
    const subs = await db.query<{ id: string; endpoint: string; p256dh: string; auth: string }>(
      `select s.id, s.endpoint, s.p256dh, s.auth from public.notification_subscriptions s
         join public.notification_preferences p on p.user_id = s.user_id
        where s.user_id = any($1::uuid[]) and p.push_enabled and p.${column}`,
      [[...new Set(userIds)]],
    );
    const payload = JSON.stringify({ ...MESSAGES[kind], url, tag: kind });
    let sent = 0;
    await Promise.all(
      subs.map(async (s) => {
        try {
          await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 3600 });
          sent++;
          await db.query('update public.notification_subscriptions set last_used_at = now() where id = $1', [s.id]);
        } catch (e) {
          const status = (e as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) await db.query('delete from public.notification_subscriptions where id = $1', [s.id]);
        }
      }),
    );
    return sent;
  } catch {
    return 0;
  }
}

export async function notifyAdmins(kind: NotificationKind, url: string) {
  try {
    const rows = await systemDb().query<{ id: string }>(`select id from public.profiles where role = 'admin' and active`);
    return notifyUsers(rows.map((r) => r.id), kind, url);
  } catch {
    return 0;
  }
}

/** Cuenta del cliente de un préstamo, si tiene cuenta. */
export async function customerUserOfLoan(loanId: string): Promise<string | null> {
  try {
    const row = await systemDb().one<{ profile_id: string | null }>(
      'select c.profile_id from public.loans l join public.customers c on c.id = l.customer_id where l.id = $1',
      [loanId],
    );
    return row?.profile_id ?? null;
  } catch {
    return null;
  }
}
