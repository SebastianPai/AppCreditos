import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSessionProfile } from '@/lib/auth';
import { systemDb } from '@/lib/db';

const subscription = z.object({
  endpoint: z.string().url().startsWith('https://'),
  keys: z.object({ p256dh: z.string().min(10).max(200), auth: z.string().min(8).max(100) }),
});

export async function POST(req: Request) {
  const profile = await getSessionProfile();
  if (!profile?.active) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  const parsed = subscription.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Suscripción no válida' }, { status: 400 });
  const db = systemDb();
  try {
    // Un dispositivo compartido pasa a pertenecer al usuario que activa los avisos.
    await db.query('delete from public.notification_subscriptions where endpoint = $1', [parsed.data.endpoint]);
    await db.query(
      'insert into public.notification_subscriptions (user_id, endpoint, p256dh, auth, user_agent) values ($1, $2, $3, $4, $5)',
      [profile.id, parsed.data.endpoint, parsed.data.keys.p256dh, parsed.data.keys.auth, req.headers.get('user-agent')?.slice(0, 200) ?? null],
    );
    await db.query('update public.notification_preferences set push_enabled = true, updated_at = now() where user_id = $1', [profile.id]);
  } catch {
    return NextResponse.json({ error: 'No fue posible guardar la suscripción' }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  const profile = await getSessionProfile();
  if (!profile) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { endpoint?: string };
  const db = systemDb();
  if (body.endpoint) await db.query('delete from public.notification_subscriptions where user_id = $1 and endpoint = $2', [profile.id, body.endpoint]);
  const left = await db.one<{ n: number }>('select count(*)::int as n from public.notification_subscriptions where user_id = $1', [profile.id]);
  if (!left?.n) await db.query('update public.notification_preferences set push_enabled = false where user_id = $1', [profile.id]);
  return NextResponse.json({ ok: true });
}
