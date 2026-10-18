import { ActionForm } from '@/components/action-form';
import { Card, EmptyState, LinkButton, Notice, PageHeader, StatusBadge } from '@/components/ui';
import { buildSchedule, formatCOP, formatDate, formatDateTime, FREQUENCY_LABEL, policyFromRow, type Frequency, type LoanPolicy } from '@/lib/finance';
import { APPLICATION_STATUS } from '@/lib/labels';
import { userDb } from '@/lib/auth';
import { respondApplication } from '../actions';

export const metadata = { title: 'Mis solicitudes' };

export default async function CustomerApplicationsPage({ searchParams }: { searchParams: Promise<{ enviada?: string }> }) {
  const { enviada } = await searchParams;
  const db = await userDb();
  const [apps, policyRow] = await Promise.all([
    db.query('select * from public.loan_applications order by created_at desc'),
    db.rpc('get_active_policy'),
  ]);
  const policy = policyRow ? policyFromRow(policyRow as Record<string, unknown>) : undefined;

  return (
    <>
      <PageHeader title="Mis solicitudes" actions={<LinkButton href="/cliente/simular">Nueva simulación</LinkButton>} />
      {enviada && (
        <div className="mb-4">
          <Notice tone="success" title="Solicitud enviada">La administración la revisará. Enviar una solicitud no crea una deuda ni garantiza la aprobación.</Notice>
        </div>
      )}
      {!apps?.length && <EmptyState>No tiene solicitudes.</EmptyState>}
      <div className="space-y-4">
        {apps?.map((a) => (
          <Card key={a.id} title={`Solicitud ${a.code}`} action={<StatusBadge map={APPLICATION_STATUS} value={a.status} />}>
            <p className="text-sm text-slate-700">
              Solicitado: {formatCOP(a.requested_principal)} en {a.requested_installments} cuotas{' '}
              {FREQUENCY_LABEL[a.requested_frequency as Frequency].toLowerCase()}es desde {formatDate(a.requested_start_date)} · {formatDateTime(a.created_at)}
            </p>
            {a.admin_notes && <p className="mt-2 text-sm"><strong>Administración:</strong> {a.admin_notes}</p>}

            {a.status === 'counter_offered' && (
              <div className="mt-3 rounded-xl border border-sky-200 bg-sky-50 p-3">
                <p className="font-semibold text-sky-900">Contraoferta</p>
                <CounterOffer p={a.proposed_principal} n={a.proposed_installments} f={a.proposed_frequency} start={a.proposed_start_date} policy={policy} />
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  <ActionForm action={respondApplication} submitLabel="Aceptar condiciones">
                    <input type="hidden" name="application_id" value={a.id} />
                    <input type="hidden" name="decision" value="accept" />
                  </ActionForm>
                  <ActionForm action={respondApplication} submitLabel="Rechazar" variant="secondary">
                    <input type="hidden" name="application_id" value={a.id} />
                    <input type="hidden" name="decision" value="reject" />
                  </ActionForm>
                </div>
              </div>
            )}

            {a.status === 'info_requested' && (
              <div className="mt-3">
                <ActionForm action={respondApplication} submitLabel="Enviar información">
                  <input type="hidden" name="application_id" value={a.id} />
                  <input type="hidden" name="decision" value="accept" />
                  <textarea name="message" required maxLength={500} rows={3} className="input" placeholder="Escriba la información solicitada" />
                </ActionForm>
              </div>
            )}

            {a.status === 'pending' && (
              <div className="mt-3">
                <ActionForm action={respondApplication} submitLabel="Retirar solicitud" variant="secondary">
                  <input type="hidden" name="application_id" value={a.id} />
                  <input type="hidden" name="decision" value="reject" />
                </ActionForm>
              </div>
            )}
          </Card>
        ))}
      </div>
    </>
  );
}

function CounterOffer({ p, n, f, start, policy }: { p: number; n: number; f: Frequency; start: string; policy?: LoanPolicy }) {
  const schedule = buildSchedule(p, n, f, start, policy);
  const total = schedule.reduce((s, r) => s + r.total, 0);
  return (
    <div className="mt-1 text-sm text-sky-900">
      <p>
        {formatCOP(p)} en {n} cuotas {FREQUENCY_LABEL[f].toLowerCase()}es de {formatCOP(schedule[0].total)} · total {formatCOP(total)}
      </p>
      <p className="text-xs">Primera cuota: {formatDate(schedule[0].dueDate)} · última: {formatDate(schedule[schedule.length - 1].dueDate)} (estimadas)</p>
    </div>
  );
}
