'use server';
import { redirect } from 'next/navigation';
import { requireRole, userDb } from '@/lib/auth';
import { friendlyError, type ActionResult } from '@/lib/errors';
import { notifyAdmins } from '@/lib/push';
import { firstIssue, formString, simulationSchema } from '@/lib/validation';

function parse(fd: FormData) {
  return simulationSchema.safeParse({
    principal: formString(fd, 'principal').replace(/[^0-9]/g, ''),
    installments: formString(fd, 'installments'),
    frequency: formString(fd, 'frequency'),
    startDate: formString(fd, 'startDate'),
  });
}

/** Guarda la simulación (informe consultable) sin crear deuda y abre el informe. */
export async function saveSimulation(_: ActionResult, fd: FormData): Promise<ActionResult> {
  const parsed = parse(fd);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  const db = await userDb();
  const { data, error } = await db.call('simulate_loan', {
    p_principal: parsed.data.principal,
    p_installments: parsed.data.installments,
    p_frequency: parsed.data.frequency,
    p_start_date: parsed.data.startDate,
  });
  if (error) return { ok: false, error: friendlyError(error) };
  redirect(`/simulaciones/${(data as { id: string }).id}`);
}

/** Solicitud formal: queda pendiente de revisión; no crea deuda ni reserva capital. */
export async function requestLoan(_: ActionResult, fd: FormData): Promise<ActionResult> {
  await requireRole('customer');
  const parsed = parse(fd);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  const message = formString(fd, 'message').slice(0, 500) || null;
  const db = await userDb();
  const { data: sim, error: simError } = await db.call('simulate_loan', {
    p_principal: parsed.data.principal,
    p_installments: parsed.data.installments,
    p_frequency: parsed.data.frequency,
    p_start_date: parsed.data.startDate,
  });
  if (simError) return { ok: false, error: friendlyError(simError) };
  const { error } = await db.call('create_application', {
    p_principal: parsed.data.principal,
    p_installments: parsed.data.installments,
    p_frequency: parsed.data.frequency,
    p_start_date: parsed.data.startDate,
    p_simulation_id: (sim as { id: string }).id,
    p_customer_id: null,
    p_message: message,
  });
  if (error) return { ok: false, error: friendlyError(error) };
  await notifyAdmins('new_application', '/admin/solicitudes');
  redirect('/cliente/solicitudes?enviada=1');
}
