import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { optionalServerEnv } from '@/lib/env';
import { todayBogota } from '@/lib/finance';
import { notifyAdmins, notifyUsers, type NotificationKind } from '@/lib/push';
import { systemDb } from '@/lib/db';

function authorized(req: Request): boolean {
  const secret = optionalServerEnv().cronSecret;
  const header = req.headers.get('authorization') ?? '';
  const expected = `Bearer ${secret}`;
  return Boolean(secret) && header.length === expected.length && timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}

/**
 * Tarea diaria (Vercel Cron u otro programador, 6:00 a. m. Bogotá = 11:00 UTC):
 * marca cuotas vencidas y envía recordatorios y resúmenes.
 */
export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  const db = systemDb();
  const today = todayBogota();
  const overdue = await db.rpc<number>('mark_overdue_installments');
  const targets = await db.query<{ user_id: string; kind: string }>('select * from public.reminder_targets($1)', [today]);

  const byKind = new Map<string, string[]>();
  for (const t of targets) {
    byKind.set(t.kind, [...(byKind.get(t.kind) ?? []), t.user_id]);
  }
  const map: Record<string, [NotificationKind, string]> = {
    due_today: ['due_today', '/cliente'],
    upcoming: ['upcoming', '/cliente'],
    collector_daily: ['daily_summary', '/cobrador'],
  };
  let sent = 0;
  for (const [kind, users] of byKind) {
    const target = map[kind];
    if (target) sent += await notifyUsers(users, target[0], target[1]);
  }
  sent += await notifyAdmins('daily_summary', '/admin');

  const pending = await db.one<{ n: number }>(`select count(*)::int as n from public.quarterly_settlements where status = 'pending_approval'`);
  if (pending?.n) sent += await notifyAdmins('settlement', '/admin/liquidaciones');

  return NextResponse.json({ date: today, overdueMarked: overdue, notificationsSent: sent });
}
