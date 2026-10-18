'use server';
import { revalidatePath } from 'next/cache';
import { requireRole, userDb } from '@/lib/auth';
import { friendlyError, type ActionResult } from '@/lib/errors';
import { customerUserOfLoan, notifyUsers } from '@/lib/push';
import { firstIssue, formOptional, formPesos, formString, paymentSchema } from '@/lib/validation';

export type PaymentResult = ActionResult<{ payment_id: string; receipt_number: number; duplicate: boolean; is_partial: boolean }>;

/**
 * Registra un pago recibido (cobrador: efectivo, fecha de hoy; administrador: cualquier medio/fecha).
 * Toda la lógica (permisos, idempotencia, asignación, comisión, contabilidad) se ejecuta en una
 * única transacción de base de datos (register_payment).
 */
export async function registerPayment(_: PaymentResult, fd: FormData): Promise<PaymentResult> {
  const profile = await requireRole('collector', 'admin');
  const parsed = paymentSchema.safeParse({
    loan_id: formString(fd, 'loan_id'),
    amount: formPesos(fd, 'amount'),
    idempotency_key: formString(fd, 'idempotency_key'),
    notes: formString(fd, 'notes'),
  });
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  const db = await userDb();
  const { data, error } = await db.call('register_payment', {
    p_loan_id: parsed.data.loan_id,
    p_amount: parsed.data.amount,
    p_idempotency_key: parsed.data.idempotency_key,
    p_method: profile.role === 'admin' ? formString(fd, 'method') || 'cash' : 'cash',
    p_received_on: profile.role === 'admin' ? formOptional(fd, 'received_on') : null,
    p_notes: parsed.data.notes || null,
    p_evidence_path: null,
  });
  if (error) return { ok: false, error: friendlyError(error) };
  const result = data as { payment_id: string; receipt_number: number; duplicate: boolean; is_partial: boolean };
  if (!result.duplicate) {
    const userId = await customerUserOfLoan(parsed.data.loan_id);
    if (userId) await notifyUsers([userId], 'payment_confirmed', '/cliente');
  }
  revalidatePath('/cobrador', 'layout');
  revalidatePath('/admin', 'layout');
  return {
    ok: true,
    message: result.duplicate ? 'Este pago ya estaba registrado (no se duplicó).' : `Pago registrado. Comprobante N.º ${result.receipt_number}.`,
    data: result,
  };
}

export async function requestReversal(_: ActionResult, fd: FormData): Promise<ActionResult> {
  await requireRole('collector', 'admin');
  const db = await userDb();
  const { error } = await db.call('request_reversal', { p_payment_id: formString(fd, 'payment_id'), p_reason: formString(fd, 'reason') });
  if (error) return { ok: false, error: friendlyError(error) };
  revalidatePath('/cobrador', 'layout');
  return { ok: true, message: 'Corrección solicitada. La administración la revisará.' };
}

export async function declareHandover(_: ActionResult, fd: FormData): Promise<ActionResult> {
  await requireRole('collector');
  const db = await userDb();
  const { error } = await db.call('declare_cash_handover', { p_amount: formPesos(fd, 'amount'), p_notes: formOptional(fd, 'notes') });
  if (error) return { ok: false, error: friendlyError(error) };
  revalidatePath('/cobrador/comisiones');
  return { ok: true, message: 'Entrega registrada. Queda pendiente hasta que la administración confirme que recibió el dinero.' };
}
