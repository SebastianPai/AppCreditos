import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ActionForm } from '@/components/action-form';
import { PrintButton } from '@/components/pwa';
import { SettlementReportView } from '@/components/settlement-report';
import { Card, Notice, PageHeader, StatusBadge } from '@/components/ui';
import type { SettlementReport } from '@/lib/excel';
import { formatCOP, formatDate, formatDateTime, todayBogota } from '@/lib/finance';
import { WORKFLOW_STATUS } from '@/lib/labels';
import { userDb } from '@/lib/auth';
import { payDistribution, settlementAction } from '../../actions';

export default async function SettlementDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = await userDb();
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const s = await db.one('select * from public.quarterly_settlements where id = $1', [id]);
  if (!s) notFound();
  const dists = await db.query(
    `select d.*, p.display_name from public.settlement_distributions d join public.partners p on p.id = d.partner_id
      where d.settlement_id = $1 order by p.seq`, [id]);
  const report = (s.approved_report ?? s.report) as SettlementReport;
  const ended = s.period_end < todayBogota();
  const Op = ({ op, label, variant }: { op: string; label: string; variant?: 'primary' | 'secondary' | 'danger' }) => (
    <ActionForm action={settlementAction} submitLabel={label} variant={variant} className="inline-block">
      <input type="hidden" name="settlement_id" value={s.id} /><input type="hidden" name="op" value={op} />
    </ActionForm>
  );

  return (
    <>
      <Link href="/admin/liquidaciones" className="no-print mb-3 inline-block text-sm text-brand-700">← Liquidaciones</Link>
      <PageHeader
        title={`Liquidación ${formatDate(s.period_start)} – ${formatDate(s.period_end)}`}
        subtitle={<StatusBadge map={WORKFLOW_STATUS} value={s.status} />}
        actions={<><a href={`/api/export/settlement/${s.id}`} className="btn-secondary">Excel</a><PrintButton /></>}
      />
      {s.approved_hash && (
        <div className="mb-4">
          <Notice tone="success">
            Aprobada el {formatDateTime(s.approved_at)}. Versión sellada (SHA-256): <code className="text-xs break-all">{s.approved_hash}</code>
          </Notice>
        </div>
      )}
      <div className="no-print mb-4 flex flex-wrap gap-2">
        {s.status === 'draft' && <><Op op="refresh" label="Recalcular" variant="secondary" /><Op op="submit" label="Enviar a aprobación" /><Op op="cancel" label="Cancelar" variant="secondary" /></>}
        {s.status === 'pending_approval' && (
          ended ? (
            <ActionForm action={settlementAction} submitLabel="Aprobar liquidación" confirmText="Revisé el informe. Al aprobar se cierran contablemente los resultados del periodo y no podrán registrarse movimientos con esas fechas." className="card w-full max-w-lg space-y-2">
              <input type="hidden" name="settlement_id" value={s.id} /><input type="hidden" name="op" value="approve" />
            </ActionForm>
          ) : (
            <Notice tone="warning">El periodo aún no termina: se podrá aprobar a partir del {formatDate(s.period_end)} + 1 día.</Notice>
          )
        )}
        {s.status === 'pending_approval' && <><Op op="refresh" label="Recalcular" variant="secondary" /><Op op="cancel" label="Cancelar" variant="secondary" /></>}
      </div>

      <SettlementReportView r={report} />

      {!!dists?.length && (
        <Card title="Distribuciones" className="mt-4">
          <ul className="divide-y divide-slate-100 text-sm">
            {dists.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>{d.display_name} · neto <strong>{formatCOP(d.net_amount)}</strong> (bruto {formatCOP(d.gross_amount)}, anticipos {formatCOP(d.advances_deducted)})</span>
                {d.paid_at ? (
                  <span className="text-emerald-700">Pagada {formatDateTime(d.paid_at)}</span>
                ) : (
                  <ActionForm action={payDistribution} submitLabel="Registrar pago" className="no-print inline-block" confirmText="Entregué el dinero al socio.">
                    <input type="hidden" name="distribution_id" value={d.id} />
                  </ActionForm>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
