import { NextResponse } from 'next/server';
import { customerUserOfLoan, notifyUsers } from '@/lib/push';
import { systemDb } from '@/lib/db';
import { verifyEvent, wompiConfig, type WompiEvent } from '@/lib/wompi';

/**
 * Webhook de Wompi. Un pago solo se confirma si: la firma es válida, el estado es
 * APPROVED, la moneda es COP, la referencia corresponde a una solicitud de pago y
 * el importe coincide exactamente. La confirmación es idempotente.
 */
export async function POST(req: Request) {
  const cfg = wompiConfig();
  if (!cfg.enabled) return NextResponse.json({ error: 'Pasarela no configurada' }, { status: 503 });
  const body = (await req.json().catch(() => null)) as WompiEvent | null;
  if (!body || !verifyEvent(body, cfg.eventsSecret)) return NextResponse.json({ error: 'Firma no válida' }, { status: 401 });
  if (body.event !== 'transaction.updated') return NextResponse.json({ ignored: true });

  const tx = (body.data?.transaction ?? {}) as { id?: string; status?: string; reference?: string; amount_in_cents?: number; currency?: string };
  if (tx.status !== 'APPROVED') return NextResponse.json({ ignored: true, status: tx.status });
  if (tx.currency !== 'COP' || !tx.reference || !tx.id || typeof tx.amount_in_cents !== 'number' || tx.amount_in_cents % 100 !== 0) {
    return NextResponse.json({ error: 'Datos de transacción no válidos' }, { status: 400 });
  }

  const db = systemDb();
  const { data, error } = await db.call('confirm_gateway_payment', {
    p_request_code: tx.reference,
    p_amount: tx.amount_in_cents / 100,
    p_gateway_reference: tx.id,
  });
  if (error) {
    // 200 para referencias desconocidas o importes que no coinciden: quedan para revisión manual, sin reintentos infinitos.
    return NextResponse.json({ confirmed: false, reason: error.message }, { status: 200 });
  }
  const result = data as { payment_id: string; duplicate: boolean };
  if (!result.duplicate) {
    const req = await db.one<{ loan_id: string }>('select loan_id from public.payment_requests where code = $1', [tx.reference]);
    const userId = req ? await customerUserOfLoan(req.loan_id) : null;
    if (userId) await notifyUsers([userId], 'payment_confirmed', '/cliente');
  }
  return NextResponse.json({ confirmed: true, duplicate: result.duplicate });
}
