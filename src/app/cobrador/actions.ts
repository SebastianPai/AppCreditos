'use server';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireRole, userDb } from '@/lib/auth';
import { friendlyError, type ActionResult } from '@/lib/errors';
import { customerUserOfLoan, notifyAdmins, notifyUsers } from '@/lib/push';
import { hashPassword, temporaryPassword } from '@/lib/password';
import { customerSchema, firstIssue, formOptional, formPesos, formString, frequency, paymentSchema } from '@/lib/validation';
import { z } from 'zod';

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

/** Pide a la administración eliminar un cliente o un préstamo propio. Nada se borra hasta que el administrador acepte. */
export async function requestDeletion(_: ActionResult, fd: FormData): Promise<ActionResult> {
  await requireRole('collector', 'admin');
  const db = await userDb();
  const { error } = await db.call('request_deletion', {
    p_kind: formString(fd, 'kind'),
    p_target_id: formString(fd, 'target_id'),
    p_reason: formString(fd, 'reason'),
  });
  if (error) return { ok: false, error: friendlyError(error) };
  void notifyAdmins('new_application', '/admin/eliminaciones');
  revalidatePath('/cobrador', 'layout');
  revalidatePath('/admin', 'layout');
  return { ok: true, message: 'Solicitud enviada. La administración debe aceptarla para eliminar.' };
}

export async function declareHandover(_: ActionResult, fd: FormData): Promise<ActionResult> {
  await requireRole('collector');
  const db = await userDb();
  const { error } = await db.call('declare_cash_handover', { p_amount: formPesos(fd, 'amount'), p_notes: formOptional(fd, 'notes') });
  if (error) return { ok: false, error: friendlyError(error) };
  revalidatePath('/cobrador/comisiones');
  return { ok: true, message: 'Entrega registrada. Queda pendiente hasta que la administración confirme que recibió el dinero.' };
}

/**
 * Registro de cliente por el cobrador (si la administración lo permite). La cédula es obligatoria
 * y el cliente queda asignado a quien lo registra. Opcionalmente crea su acceso a la app.
 */
export async function collectorCreateCustomer(_: ActionResult, fd: FormData): Promise<ActionResult> {
  await requireRole('collector');
  const parsed = customerSchema.safeParse({
    full_name: formString(fd, 'full_name'),
    document_type: formString(fd, 'document_type'),
    document_number: formString(fd, 'document_number'),
    phone: formString(fd, 'phone'),
    address: formString(fd, 'address'),
    collector_id: '',
    notes: formString(fd, 'notes'),
    data_consent: fd.get('data_consent') === 'on' || fd.get('data_consent') === 'true',
  });
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  const db = await userDb();
  const { data: customerId, error } = await db.call<string>('create_customer', {
    p_full_name: parsed.data.full_name,
    p_document_type: parsed.data.document_type,
    p_document_number: parsed.data.document_number,
    p_phone: parsed.data.phone,
    p_address: parsed.data.address || null,
    p_collector_id: null,
    p_notes: parsed.data.notes || null,
    p_data_consent: true,
  });
  if (error) return { ok: false, error: friendlyError(error) };
  revalidatePath('/cobrador', 'layout');
  if (fd.get('create_account') !== 'on') {
    return { ok: true, message: `Cliente ${parsed.data.full_name} registrado.` };
  }
  const access = await createCustomerAccess(customerId!, parsed.data.full_name, parsed.data.phone);
  return access.ok
    ? { ok: true, message: `Cliente registrado. Acceso a la app → Usuario: ${parsed.data.document_number} · Contraseña temporal: ${access.password} (entréguela al cliente; la cambiará al ingresar).` }
    : { ok: false, error: `Cliente registrado, pero no se creó el acceso: ${access.error}` };
}

export async function collectorCreateAccess(_: ActionResult, fd: FormData): Promise<ActionResult> {
  await requireRole('collector');
  const doc = formString(fd, 'document');
  const access = await createCustomerAccess(formString(fd, 'customer_id'), formString(fd, 'full_name'), formString(fd, 'phone'), doc);
  if (!access.ok) return { ok: false, error: access.error };
  revalidatePath('/cobrador', 'layout');
  return { ok: true, message: `Acceso creado → Usuario: ${doc} · Contraseña inicial: ${doc} (la cambiará al entrar).` };
}

async function createCustomerAccess(customerId: string, fullName: string, phone: string, initialPassword?: string) {
  const password = initialPassword || temporaryPassword();
  const db = await userDb();
  const { error } = await db.call('admin_create_user', {
    p_email: null,
    p_password_hash: await hashPassword(password),
    p_full_name: fullName,
    p_phone: phone || null,
    p_role: 'customer',
    p_customer_id: customerId,
  });
  return error ? { ok: false as const, error: friendlyError(error) } : { ok: true as const, password };
}

/**
 * Registro rápido de cliente: nombre, cédula, teléfono y dirección. Si se pide, crea su acceso
 * a la app (usuario y contraseña inicial: su cédula; la cambia al ingresar). Luego lleva a crear el préstamo.
 */
export async function quickCreateCustomer(_: ActionResult, fd: FormData): Promise<ActionResult> {
  await requireRole('collector');
  const parsed = customerSchema.safeParse({
    full_name: formString(fd, 'full_name'),
    document_type: 'CC',
    document_number: formString(fd, 'document_number'),
    phone: formString(fd, 'phone'),
    address: formString(fd, 'address'),
    collector_id: '',
    notes: '',
    data_consent: fd.get('data_consent') === 'on',
  });
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  const db = await userDb();
  const { data: customerId, error } = await db.call<string>('create_customer', {
    p_full_name: parsed.data.full_name,
    p_document_type: 'CC',
    p_document_number: parsed.data.document_number,
    p_phone: parsed.data.phone,
    p_address: parsed.data.address || null,
    p_collector_id: null,
    p_notes: null,
    p_data_consent: true,
  });
  if (error) return { ok: false, error: friendlyError(error) };
  let access = '';
  if (fd.get('create_account') === 'on') {
    const { error: accErr } = await db.call('admin_create_user', {
      p_email: null,
      p_password_hash: await hashPassword(parsed.data.document_number),
      p_full_name: parsed.data.full_name,
      p_phone: parsed.data.phone,
      p_role: 'customer',
      p_customer_id: customerId,
    });
    access = accErr ? '&acceso=error' : '&acceso=1';
  }
  revalidatePath('/cobrador', 'layout');
  redirect(`/cobrador/prestamos/nuevo?cliente=${customerId}&nuevo=1${access}`);
}

const loanSchema = z.object({
  customer_id: z.string().uuid('Elija el cliente'),
  principal: z.number().int().positive('Escriba cuánto dinero'),
  installments: z.coerce.number().int().min(1).max(5),
  frequency,
});

/** Crea el préstamo en un solo paso: queda activo desde hoy y a cargo del cobrador. */
export async function createLoan(_: ActionResult, fd: FormData): Promise<ActionResult> {
  await requireRole('collector');
  const parsed = loanSchema.safeParse({
    customer_id: formString(fd, 'customer_id'),
    principal: formPesos(fd, 'principal'),
    installments: formString(fd, 'installments'),
    frequency: formString(fd, 'frequency'),
  });
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  const db = await userDb();
  const { error } = await db.call('create_simple_loan', {
    p_customer_id: parsed.data.customer_id,
    p_principal: parsed.data.principal,
    p_installments: parsed.data.installments,
    p_frequency: parsed.data.frequency,
    p_collector_id: null,
  });
  if (error) return { ok: false, error: friendlyError(error) };
  revalidatePath('/cobrador', 'layout');
  redirect(`/cobrador/clientes/${parsed.data.customer_id}?creado=1`);
}
