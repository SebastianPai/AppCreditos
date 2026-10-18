'use server';
import { revalidatePath } from 'next/cache';
import { requireRole, userDb } from '@/lib/auth';
import { friendlyError, type ActionResult } from '@/lib/errors';
import { notificationOptionsFor } from '@/lib/notification-options';


export async function savePreferences(_: ActionResult, fd: FormData): Promise<ActionResult> {
  const profile = await requireRole('admin', 'collector', 'partner', 'customer');
  const db = await userDb();
  // Solo se actualizan las opciones que corresponden al rol del usuario.
  const values = Object.fromEntries(notificationOptionsFor(profile.role).map((o) => [o.key, fd.get(o.key) === 'on']));
  const keys = Object.keys(values);
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
  let error: unknown = null;
  try {
    await db.query(`update public.notification_preferences set ${sets}, updated_at = now() where user_id = $1`, [profile.id, ...keys.map((k) => values[k])]);
  } catch (e) {
    error = e;
  }
  if (error) return { ok: false, error: friendlyError(error) };
  revalidatePath('/notificaciones');
  return { ok: true, message: 'Preferencias guardadas.' };
}
