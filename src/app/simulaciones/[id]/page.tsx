import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getSessionProfile, userDb } from '@/lib/auth';
import { PrintButton } from '@/components/pwa';
import { Card, KeyValue, Notice } from '@/components/ui';
import { formatCOP, formatDate, formatDateTime, FREQUENCY_LABEL, type Frequency } from '@/lib/finance';

export const metadata = { title: 'Informe de simulación' };

interface SimulationReport {
  id: string;
  created_at: string;
  customer: { code: string; full_name: string } | null;
  principal: number;
  installments_count: number;
  frequency: Frequency;
  start_date: string;
  interest_bps: number;
  interest_total: number;
  total_amount: number;
  effective_annual_rate: number;
  schedule: { number: number; due_date: string; principal: number; interest: number; total: number; balance_after: number }[];
}

export default async function SimulationReportPage({ params }: { params: Promise<{ id: string }> }) {
  if (!(await getSessionProfile())) redirect('/login');
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const db = await userDb();
  const { data, error } = await db.call('get_simulation', { p_id: id });
  if (error || !data) notFound();
  const s = data as SimulationReport;
  const amounts = [...new Set(s.schedule.map((r) => r.total))];

  return (
    <main className="mx-auto max-w-3xl px-4 py-6">
      <div className="no-print mb-4 flex items-center justify-between">
        <Link href={s.customer ? '/cliente' : '/simulador'} className="text-sm text-brand-700">← Volver</Link>
        <PrintButton />
      </div>
      <header className="mb-5">
        <p className="text-sm text-slate-500">Capital Control</p>
        <h1 className="text-2xl font-bold">Informe de simulación de préstamo</h1>
        <p className="text-sm text-slate-500">N.º {s.id.slice(0, 8).toUpperCase()} · {formatDateTime(s.created_at)}</p>
      </header>
      <div className="space-y-4">
        <Card>
          <KeyValue
            items={[
              ['Fecha de simulación', formatDateTime(s.created_at)],
              ['Cliente', s.customer ? `${s.customer.full_name} (${s.customer.code})` : 'Simulación anónima'],
              ['Capital solicitado', formatCOP(s.principal)],
              ['Tasa aplicada', `${s.interest_bps / 100} % total sobre el capital (única vez)`],
              ['Número de cuotas', String(s.installments_count)],
              ['Modalidad', FREQUENCY_LABEL[s.frequency]],
              ['Fecha de inicio propuesta', formatDate(s.start_date)],
              ['Total de intereses', formatCOP(s.interest_total)],
              ['Total a pagar', formatCOP(s.total_amount)],
              ['Valor de cada cuota', amounts.map((a) => formatCOP(a)).join(' / ')],
            ]}
          />
        </Card>
        <Card title="Calendario estimado">
          <table className="table">
            <thead>
              <tr>
                <th>#</th>
                <th>Vencimiento</th>
                <th className="num">Capital</th>
                <th className="num">Interés</th>
                <th className="num">Cuota</th>
                <th className="num">Saldo</th>
              </tr>
            </thead>
            <tbody>
              {s.schedule.map((r) => (
                <tr key={r.number}>
                  <td>{r.number}</td>
                  <td>{formatDate(r.due_date)}</td>
                  <td className="num">{formatCOP(r.principal)}</td>
                  <td className="num">{formatCOP(r.interest)}</td>
                  <td className="num font-semibold">{formatCOP(r.total)}</td>
                  <td className="num">{formatCOP(r.balance_after)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <Notice tone="warning">
          Documento informativo. No constituye aprobación, contrato, deuda ni desembolso. Las fechas son estimadas y se fijan al desembolsar.
        </Notice>
      </div>
    </main>
  );
}
