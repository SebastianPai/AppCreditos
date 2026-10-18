'use server';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireRole, userDb } from '@/lib/auth';
import { publicEnv } from '@/lib/env';
import { friendlyError, type ActionResult } from '@/lib/errors';
import { notifyAdmins } from '@/lib/push';
import { saveFile } from '@/lib/storage';
import { formOptional, formPesos, formString } from '@/lib/validation';
import { checkoutUrl, wompiConfig } from '@/lib/wompi';

/** Pago por QR/transferencia: el comprobante queda pendiente de verificación; el saldo no cambia hasta confirmarse. */
export async function submitPaymentRequest(_: ActionResult, fd: FormData): Promise<ActionResult> {
  const profile = await requireRole('customer');
  const db = await userDb();
  const customerId = await db.rpc<string | null>('my_customer_id');
  if (!customerId) return { ok: false, error: 'Su cuenta no está vinculada a un cliente.' };
  const amount = formPesos(fd, 'amount');
  if (!Number.isSafeInteger(amount) || amount <= 0) return { ok: false, error: 'Ingrese el valor pagado.' };
  const file = fd.get('evidence');
  let upload: Awaited<ReturnType<typeof saveFile>>;
  try {
    upload = await saveFile(db, profile.id, 'payment-evidence', file instanceof File ? file : null, customerId);
  } catch (e) {
    return { ok: false, error: friendlyError(e) };
  }
  if (upload.error) return { ok: false, error: upload.error };
  if (!upload.id) return { ok: false, error: 'Adjunte el comprobante del pago.' };
  const { error } = await db.call('create_payment_request', {
    p_loan_id: formString(fd, 'loan_id'),
    p_amount: amount,
    p_payment_method_id: formOptional(fd, 'payment_method_id'),
    p_reference: formOptional(fd, 'reference'),
    p_evidence_path: upload.id,
  });
  if (error) return { ok: false, error: friendlyError(error) };
  await notifyAdmins('new_application', '/admin/pagos');
  revalidatePath('/cliente/pagar');
  return { ok: true, message: 'Comprobante enviado. El pago quedará confirmado cuando la administración lo verifique.' };
}

/** Pago en línea por pasarela (si está configurada): crea la solicitud y redirige al checkout. */
export async function startGatewayPayment(_: ActionResult, fd: FormData): Promise<ActionResult> {
  await requireRole('customer');
  if (!wompiConfig().enabled) return { ok: false, error: 'El pago en línea no está habilitado.' };
  const db = await userDb();
  const amount = formPesos(fd, 'amount');
  const { data: id, error } = await db.call<string>('create_payment_request', {
    p_loan_id: formString(fd, 'loan_id'),
    p_amount: amount,
    p_payment_method_id: null,
    p_reference: null,
    p_evidence_path: null,
  });
  if (error) return { ok: false, error: friendlyError(error) };
  const req = await db.one<{ code: string }>('select code from public.payment_requests where id = $1', [id]);
  const url = req ? checkoutUrl(req.code, amount, `${publicEnv.siteUrl}/cliente/pagar?pasarela=1`) : null;
  if (!url) return { ok: false, error: 'No fue posible iniciar el pago en línea.' };
  redirect(url);
}

export async function respondApplication(_: ActionResult, fd: FormData): Promise<ActionResult> {
  await requireRole('customer');
  const db = await userDb();
  const { error } = await db.call('respond_application', {
    p_application_id: formString(fd, 'application_id'),
    p_accept: formString(fd, 'decision') === 'accept',
    p_message: formOptional(fd, 'message'),
  });
  if (error) return { ok: false, error: friendlyError(error) };
  await notifyAdmins('new_application', '/admin/solicitudes');
  revalidatePath('/cliente/solicitudes');
  return { ok: true, message: 'Respuesta enviada.' };
}
