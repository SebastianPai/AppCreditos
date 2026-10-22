'use server';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { requireRole, userDb } from '@/lib/auth';
import { hashPassword, temporaryPassword } from '@/lib/password';
import { saveFile } from '@/lib/storage';
import { friendlyError, type ActionResult } from '@/lib/errors';
import { customerUserOfLoan, notifyUsers } from '@/lib/push';
import { customerSchema, firstIssue, formOptional, formPesos, formString } from '@/lib/validation';

type Result = Promise<ActionResult>;

/** Ejecuta una RPC como el administrador autenticado y revalida el área. */
async function rpc(fn: string, args: Record<string, unknown>, message: string, paths: string[] = ['/admin']): Result {
  await requireRole('admin');
  const db = await userDb();
  const { error } = await db.call(fn, args);
  if (error) return { ok: false, error: friendlyError(error) };
  paths.forEach((p) => revalidatePath(p, 'layout'));
  return { ok: true, message };
}

// ---------------------------------------------------------------- Clientes
/**
 * Elimina un cliente de prueba con todo lo suyo (préstamos, pagos, asientos, acceso a la app).
 * La auditoría se conserva y registra la eliminación. Pide escribir ELIMINAR.
 */
export async function purgeTestCustomer(_: ActionResult, fd: FormData): Result {
  await requireRole('admin');
  const db = await userDb();
  const { error } = await db.call('admin_purge_test_customer', {
    p_customer_id: formString(fd, 'customer_id'),
    p_confirm: formString(fd, 'confirm'),
  });
  if (error) return { ok: false, error: friendlyError(error) };
  revalidatePath('/admin', 'layout');
  revalidatePath('/cobrador', 'layout');
  redirect('/admin/clientes?eliminado=1');
}

export async function createCustomer(_: ActionResult, fd: FormData): Result {
  await requireRole('admin');
  const parsed = customerSchema.safeParse({
    full_name: formString(fd, 'full_name'),
    document_type: formString(fd, 'document_type'),
    document_number: formString(fd, 'document_number'),
    phone: formString(fd, 'phone'),
    address: formString(fd, 'address'),
    collector_id: formString(fd, 'collector_id'),
    notes: formString(fd, 'notes'),
    data_consent: fd.get('data_consent') === 'on' || fd.get('data_consent') === 'true',
  });
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  const db = await userDb();
  const { data, error } = await db.call('create_customer', {
    p_full_name: parsed.data.full_name,
    p_document_type: parsed.data.document_type,
    p_document_number: parsed.data.document_number,
    p_phone: parsed.data.phone,
    p_address: parsed.data.address || null,
    p_collector_id: parsed.data.collector_id || null,
    p_notes: parsed.data.notes || null,
    p_data_consent: true,
  });
  if (error) return { ok: false, error: friendlyError(error) };
  if (parsed.data.collector_id) await notifyUsers([parsed.data.collector_id], 'new_assignment', '/cobrador/clientes');
  redirect(`/admin/clientes/${data}`);
}

export async function updateCustomer(_: ActionResult, fd: FormData): Result {
  return rpc('update_customer', {
    p_customer_id: formString(fd, 'customer_id'),
    p_full_name: formString(fd, 'full_name'),
    p_phone: formString(fd, 'phone'),
    p_address: formOptional(fd, 'address'),
    p_status: formString(fd, 'status'),
    p_notes: formOptional(fd, 'notes'),
  }, 'Cliente actualizado.');
}

export async function assignCollector(_: ActionResult, fd: FormData): Result {
  const collector = formString(fd, 'collector_id');
  const res = await rpc('assign_collector', { p_customer_id: formString(fd, 'customer_id'), p_collector_id: collector, p_include_loans: true }, 'Cobrador asignado.');
  if (res.ok) await notifyUsers([collector], 'new_assignment', '/cobrador/clientes');
  return res;
}

// ---------------------------------------------------------------- Usuarios
const createUserSchema = z.object({
  email: z.string().regex(/^([^@\s]+@[^@\s]+|[a-z0-9._-]{3,60})$/, 'Usuario o correo no válido (sin espacios)').optional().or(z.literal('')),
  full_name: z.string().trim().min(2, 'Nombre requerido').max(160),
  role: z.enum(['admin', 'collector', 'partner', 'customer']),
  phone: z.string().trim().regex(/^[0-9+ ]{7,20}$/, 'Teléfono no válido').optional().or(z.literal('')),
  customer_id: z.string().uuid().optional().or(z.literal('')),
});

/**
 * Crea una cuenta con contraseña temporal (se muestra una sola vez). El usuario
 * debe cambiarla al primer ingreso. La base de datos verifica que quien crea es administrador.
 */
export async function createUser(_: ActionResult, fd: FormData): Result {
  await requireRole('admin');
  const parsed = createUserSchema.safeParse({
    email: formString(fd, 'email').toLowerCase(),
    full_name: formString(fd, 'full_name'),
    role: formString(fd, 'role'),
    phone: formString(fd, 'phone'),
    customer_id: formString(fd, 'customer_id'),
  });
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  const { email, full_name, role, phone, customer_id } = parsed.data;
  if (!email && role !== 'customer') return { ok: false, error: 'El usuario o correo es obligatorio para el personal.' };
  const password = temporaryPassword();
  const db = await userDb();
  const { error } = await db.call('admin_create_user', {
    p_email: email || null,
    p_password_hash: await hashPassword(password),
    p_full_name: full_name,
    p_phone: phone || null,
    p_role: role,
    p_customer_id: customer_id || null,
  });
  if (error) return { ok: false, error: friendlyError(error) };
  revalidatePath('/admin', 'layout');
  const login = email || 'la cédula del cliente';
  return { ok: true, message: `Cuenta creada. Usuario: ${login} · Contraseña temporal: ${password} (cópiela ahora; se pedirá cambiarla al ingresar).` };
}

export async function resetUserPassword(_: ActionResult, fd: FormData): Result {
  await requireRole('admin');
  const password = temporaryPassword();
  const db = await userDb();
  const { error } = await db.call('admin_reset_password', { p_user_id: formString(fd, 'user_id'), p_password_hash: await hashPassword(password) });
  if (error) return { ok: false, error: friendlyError(error) };
  return { ok: true, message: `Nueva contraseña temporal: ${password} (cópiela ahora).` };
}

export async function updateProfile(_: ActionResult, fd: FormData): Result {
  return rpc('admin_update_profile', {
    p_user_id: formString(fd, 'user_id'),
    p_role: formString(fd, 'role'),
    p_active: fd.get('active') === 'on',
    p_full_name: formString(fd, 'full_name'),
    p_phone: formOptional(fd, 'phone'),
  }, 'Usuario actualizado.');
}

export async function setPermission(_: ActionResult, fd: FormData): Result {
  return rpc('set_user_permission', {
    p_user_id: formString(fd, 'user_id'),
    p_permission: formString(fd, 'permission'),
    p_granted: formString(fd, 'granted') === 'true',
  }, 'Permiso actualizado.');
}

// ---------------------------------------------------------------- Solicitudes y préstamos
export async function reviewApplication(_: ActionResult, fd: FormData): Result {
  const action = formString(fd, 'action');
  const res = await rpc('review_application', {
    p_application_id: formString(fd, 'application_id'),
    p_action: action,
    p_notes: formOptional(fd, 'notes'),
    p_principal: action === 'counter_offer' ? formPesos(fd, 'principal') : null,
    p_installments: action === 'counter_offer' ? Number(formString(fd, 'installments')) : null,
    p_frequency: action === 'counter_offer' ? formString(fd, 'frequency') : null,
    p_start_date: action === 'counter_offer' ? formString(fd, 'start_date') : null,
  }, action === 'reject' ? 'Solicitud rechazada.' : action === 'counter_offer' ? 'Contraoferta enviada al cliente.' : 'Se solicitó información al cliente.');
  return res;
}

export async function approveApplication(_: ActionResult, fd: FormData): Result {
  await requireRole('admin');
  const db = await userDb();
  const collector = formString(fd, 'collector_id');
  const { data, error } = await db.call('approve_application', {
    p_application_id: formString(fd, 'application_id'),
    p_collector_id: collector,
    p_principal: formPesos(fd, 'principal'),
    p_installments: Number(formString(fd, 'installments')),
    p_frequency: formString(fd, 'frequency'),
    p_start_date: formString(fd, 'start_date'),
  });
  if (error) return { ok: false, error: friendlyError(error) };
  await notifyUsers([collector], 'new_assignment', '/cobrador');
  redirect(`/admin/prestamos/${data}`);
}

/** Préstamo presencial: crea la solicitud a nombre del cliente y la aprueba con las mismas condiciones. */
export async function createLoanForCustomer(_: ActionResult, fd: FormData): Result {
  await requireRole('admin');
  const db = await userDb();
  const terms = {
    p_principal: formPesos(fd, 'principal'),
    p_installments: Number(formString(fd, 'installments')),
    p_frequency: formString(fd, 'frequency'),
    p_start_date: formString(fd, 'start_date'),
  };
  const { data: appId, error } = await db.call('create_application', {
    ...terms,
    p_simulation_id: null,
    p_customer_id: formString(fd, 'customer_id'),
    p_message: 'Solicitud registrada por administración',
  });
  if (error) return { ok: false, error: friendlyError(error) };
  const collector = formString(fd, 'collector_id');
  const { data: loanId, error: approveError } = await db.call('approve_application', { p_application_id: appId, p_collector_id: collector, ...terms });
  if (approveError) {
    return { ok: false, error: `La solicitud quedó registrada pero no se aprobó: ${friendlyError(approveError)}` };
  }
  await notifyUsers([collector], 'new_assignment', '/cobrador');
  redirect(`/admin/prestamos/${loanId}`);
}

export async function disburseLoan(_: ActionResult, fd: FormData): Result {
  const loanId = formString(fd, 'loan_id');
  const res = await rpc('disburse_loan', { p_loan_id: loanId, p_disbursed_on: formOptional(fd, 'disbursed_on') }, 'Desembolso registrado. El préstamo está activo.');
  if (res.ok) {
    const userId = await customerUserOfLoan(loanId);
    if (userId) await notifyUsers([userId], 'balance', `/cliente/prestamos/${loanId}`);
  }
  return res;
}

/** Corrige la fecha de inicio de un préstamo activo sin pagos y recalcula las cuotas. */
export async function changeLoanStart(_: ActionResult, fd: FormData): Result {
  return rpc('admin_change_loan_start', { p_loan_id: formString(fd, 'loan_id'), p_start_date: formOptional(fd, 'start_date') }, 'Fecha de inicio corregida. Las cuotas se recalcularon.');
}

export async function cancelLoan(_: ActionResult, fd: FormData): Result {
  return rpc('cancel_loan', { p_loan_id: formString(fd, 'loan_id'), p_reason: formString(fd, 'reason') }, 'Préstamo cancelado.');
}

// ---------------------------------------------------------------- Pagos
export async function reversePayment(_: ActionResult, fd: FormData): Result {
  return rpc('reverse_payment', { p_payment_id: formString(fd, 'payment_id'), p_reason: formString(fd, 'reason') }, 'Pago reversado con asientos de corrección.');
}

export async function decideReversal(_: ActionResult, fd: FormData): Result {
  return rpc('decide_reversal_request', {
    p_request_id: formString(fd, 'request_id'),
    p_approve: formString(fd, 'decision') === 'approve',
    p_notes: formOptional(fd, 'notes'),
  }, 'Solicitud de corrección resuelta.');
}

export async function reviewPaymentRequest(_: ActionResult, fd: FormData): Result {
  await requireRole('admin');
  const db = await userDb();
  const approve = formString(fd, 'decision') === 'approve';
  const requestId = formString(fd, 'request_id');
  const { error } = await db.call('review_payment_request', {
    p_request_id: requestId,
    p_approve: approve,
    p_notes: formOptional(fd, 'notes'),
    p_received_on: formOptional(fd, 'received_on'),
  });
  if (error) return { ok: false, error: friendlyError(error) };
  const req = await db.one<{ loan_id: string }>('select loan_id from public.payment_requests where id = $1', [requestId]);
  const userId = req ? await customerUserOfLoan(req.loan_id) : null;
  if (userId) await notifyUsers([userId], approve ? 'payment_confirmed' : 'balance', '/cliente/pagar');
  revalidatePath('/admin', 'layout');
  return { ok: true, message: approve ? 'Pago confirmado y aplicado al saldo.' : 'Pago rechazado.' };
}

export async function confirmHandover(_: ActionResult, fd: FormData): Result {
  return rpc('confirm_cash_handover', {
    p_handover_id: formString(fd, 'handover_id'),
    p_approve: formString(fd, 'decision') === 'approve',
    p_notes: formOptional(fd, 'notes'),
  }, 'Entrega de efectivo resuelta.');
}

// ---------------------------------------------------------------- Capital
export async function recordCapitalMovement(_: ActionResult, fd: FormData): Result {
  return rpc('record_capital_movement', {
    p_partner_id: formString(fd, 'partner_id'),
    p_kind: formString(fd, 'kind'),
    p_amount: formPesos(fd, 'amount'),
    p_occurred_on: formOptional(fd, 'occurred_on'),
    p_notes: formOptional(fd, 'notes'),
  }, 'Movimiento registrado.');
}

export async function recordExpense(_: ActionResult, fd: FormData): Result {
  return rpc('record_expense', {
    p_amount: formPesos(fd, 'amount'),
    p_category: formString(fd, 'category'),
    p_description: formString(fd, 'description'),
    p_occurred_on: formOptional(fd, 'occurred_on'),
  }, 'Gasto registrado.');
}

export async function recordAdjustment(_: ActionResult, fd: FormData): Result {
  const sign = formString(fd, 'direction') === 'shortage' ? -1 : 1;
  return rpc('record_adjustment', { p_amount: sign * formPesos(fd, 'amount'), p_description: formString(fd, 'description') }, 'Ajuste registrado.');
}

export async function upsertPartner(_: ActionResult, fd: FormData): Result {
  return rpc('upsert_partner', {
    p_id: formOptional(fd, 'id'),
    p_seq: Number(formString(fd, 'seq')),
    p_display_name: formString(fd, 'display_name'),
    p_share_bps: Math.round(Number(formString(fd, 'share_pct').replace(',', '.')) * 100),
    p_profile_id: formOptional(fd, 'profile_id'),
    p_active: fd.get('active') === 'on',
  }, 'Socio guardado.');
}

// ---------------------------------------------------------------- Comisiones
export async function createPayout(_: ActionResult, fd: FormData): Result {
  return rpc('create_collector_payout', { p_collector_id: formString(fd, 'collector_id'), p_period_end: formString(fd, 'period_end'), p_notes: formOptional(fd, 'notes') }, 'Liquidación de comisiones creada.');
}

export async function payoutAction(_: ActionResult, fd: FormData): Result {
  const op = formString(fd, 'op');
  const id = formString(fd, 'payout_id');
  if (op === 'approve') return rpc('approve_collector_payout', { p_payout_id: id }, 'Liquidación aprobada.');
  if (op === 'pay') return rpc('pay_collector_payout', { p_payout_id: id, p_paid_on: null }, 'Pago de comisión registrado.');
  return rpc('cancel_collector_payout', { p_payout_id: id }, 'Liquidación cancelada.');
}

// ---------------------------------------------------------------- Liquidaciones
export async function createSettlement(_: ActionResult, fd: FormData): Result {
  await requireRole('admin');
  const db = await userDb();
  const { data, error } = await db.call('create_settlement', { p_period_start: formString(fd, 'period_start'), p_period_end: formString(fd, 'period_end') });
  if (error) return { ok: false, error: friendlyError(error) };
  redirect(`/admin/liquidaciones/${data}`);
}

export async function settlementAction(_: ActionResult, fd: FormData): Result {
  const op = formString(fd, 'op');
  const id = formString(fd, 'settlement_id');
  const map: Record<string, [string, string]> = {
    refresh: ['refresh_settlement', 'Liquidación recalculada.'],
    submit: ['submit_settlement', 'Enviada a aprobación.'],
    approve: ['approve_settlement', 'Liquidación aprobada. El informe quedó sellado.'],
    cancel: ['cancel_settlement', 'Liquidación cancelada.'],
  };
  const entry = map[op];
  if (!entry) return { ok: false, error: 'Operación desconocida.' };
  return rpc(entry[0], { p_settlement_id: id }, entry[1]);
}

export async function payDistribution(_: ActionResult, fd: FormData): Result {
  return rpc('pay_distribution', { p_distribution_id: formString(fd, 'distribution_id'), p_paid_on: null }, 'Distribución pagada.');
}

// ---------------------------------------------------------------- Configuración
export async function saveCompliance(_: ActionResult, fd: FormData): Result {
  const reviewed = fd.get('legal_review_completed') === 'on';
  const rate = formString(fd, 'usury_rate_ea_percent').replace(',', '.');
  return rpc('update_setting', {
    p_key: 'compliance',
    p_value: {
      mode: formString(fd, 'mode') === 'demo' ? 'demo' : 'enforce',
      legal_review_completed: reviewed,
      legal_review_reference: formOptional(fd, 'legal_review_reference'),
      usury_rate_ea_percent: rate ? Number(rate) : null,
      usury_rate_valid_from: formOptional(fd, 'usury_rate_valid_from'),
      usury_rate_valid_until: formOptional(fd, 'usury_rate_valid_until'),
    },
  }, 'Configuración de cumplimiento guardada (auditada).');
}

export async function saveOperations(_: ActionResult, fd: FormData): Result {
  return rpc('update_setting', {
    p_key: 'operations',
    p_value: {
      collectors_can_create_customers: fd.get('collectors_can_create_customers') === 'on',
      collectors_can_approve_loans: fd.get('collectors_can_approve_loans') === 'on',
    },
  }, 'Ajuste guardado (auditado).');
}

export async function saveCompany(_: ActionResult, fd: FormData): Result {
  return rpc('update_setting', {
    p_key: 'company',
    p_value: { name: formString(fd, 'name') || 'Capital Control', legal_name: formOptional(fd, 'legal_name'), nit: formOptional(fd, 'nit'), support_phone: formOptional(fd, 'support_phone') },
  }, 'Datos de la empresa guardados.');
}

export async function savePaymentInstructions(_: ActionResult, fd: FormData): Result {
  return rpc('update_setting', { p_key: 'payment_instructions', p_value: { text: formOptional(fd, 'text') } }, 'Instrucciones guardadas.');
}

export async function createPaymentMethod(_: ActionResult, fd: FormData): Result {
  const admin = await requireRole('admin');
  const db = await userDb();
  try {
    const file = fd.get('qr');
    const qr = await saveFile(db, admin.id, 'payment-methods', file instanceof File ? file : null, null, 2 * 1024 * 1024);
    if (qr.error) return { ok: false, error: qr.error };
    await db.query(
      `insert into public.payment_methods (name, kind, instructions, account_holder, account_reference, qr_image_path, created_by)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [formString(fd, 'name'), formString(fd, 'kind'), formString(fd, 'instructions'), formOptional(fd, 'account_holder'),
       formOptional(fd, 'account_reference'), qr.id, admin.id],
    );
  } catch (e) {
    return { ok: false, error: friendlyError(e) };
  }
  revalidatePath('/admin/configuracion');
  return { ok: true, message: 'Medio de pago creado.' };
}

export async function togglePaymentMethod(_: ActionResult, fd: FormData): Result {
  await requireRole('admin');
  const db = await userDb();
  try {
    await db.query('update public.payment_methods set active = $2 where id = $1', [formString(fd, 'id'), formString(fd, 'active') === 'true']);
  } catch (e) {
    return { ok: false, error: friendlyError(e) };
  }
  revalidatePath('/admin/configuracion');
  return { ok: true, message: 'Medio de pago actualizado.' };
}

export async function createPolicy(_: ActionResult, fd: FormData): Result {
  const pct = (k: string) => Math.round(Number(formString(fd, k).replace(',', '.')) * 100);
  const max = formPesos(fd, 'max_principal');
  return rpc('create_loan_policy', {
    p_interest_bps: pct('interest_pct'),
    p_collector_bps: pct('collector_pct'),
    p_partners_bps: pct('partners_pct'),
    p_max_installments: Number(formString(fd, 'max_installments')),
    p_biweekly_min: formPesos(fd, 'biweekly_min'),
    p_min_principal: formPesos(fd, 'min_principal') || 1,
    p_max_principal: max > 0 ? max : null,
    p_notes: formOptional(fd, 'notes'),
  }, 'Nueva versión de política creada en borrador.');
}

export async function activatePolicy(_: ActionResult, fd: FormData): Result {
  return rpc('activate_loan_policy', { p_policy_id: formString(fd, 'policy_id') }, 'Política activada. Aplica solo a préstamos aprobados desde ahora.');
}
