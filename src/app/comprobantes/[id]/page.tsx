import { notFound, redirect } from 'next/navigation';
import { PrintButton } from '@/components/pwa';
import { Badge, Card, KeyValue } from '@/components/ui';
import { getSessionProfile, userDb } from '@/lib/auth';
import { formatCOP, formatDate, formatDateTime } from '@/lib/finance';
import { PAYMENT_METHOD } from '@/lib/labels';

export const metadata = { title: 'Comprobante de pago' };

interface Receipt {
  receipt_number: number;
  status: 'confirmed' | 'reversed';
  amount: number;
  principal: number;
  interest: number;
  method: string;
  received_on: string;
  received_at: string;
  reversal_reason: string | null;
  company: { name?: string; legal_name?: string | null; nit?: string | null; support_phone?: string | null } | null;
  customer: { code: string; full_name: string; document: string };
  loan: { code: string; total_amount: number; outstanding: number };
  received_by: string | null;
  allocations: { number: number; principal: number; interest: number }[];
}

export default async function ReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  if (!(await getSessionProfile())) redirect('/login');
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const db = await userDb();
  const { data, error } = await db.call('get_receipt', { p_payment_id: id });
  if (error || !data) notFound();
  const r = data as Receipt;
  return (
    <main className="mx-auto max-w-xl px-4 py-6">
      <div className="no-print mb-4 flex justify-end">
        <PrintButton label="Descargar / imprimir" />
      </div>
      <Card>
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <p className="font-bold">{r.company?.legal_name || r.company?.name || 'Capital Control'}</p>
            {r.company?.nit && <p className="text-xs text-slate-500">NIT {r.company.nit}</p>}
            <h1 className="mt-2 text-xl font-bold">Comprobante de pago N.º {r.receipt_number}</h1>
          </div>
          {r.status === 'reversed' ? <Badge tone="danger">REVERSADO</Badge> : <Badge tone="success">Confirmado</Badge>}
        </div>
        <KeyValue
          items={[
            ['Fecha', `${formatDate(r.received_on)} (${formatDateTime(r.received_at)})`],
            ['Cliente', `${r.customer.full_name} · ${r.customer.code}`],
            ['Documento', r.customer.document],
            ['Préstamo', r.loan.code],
            ['Medio', PAYMENT_METHOD[r.method] ?? r.method],
            ['Recibido por', r.received_by ?? 'Pasarela de pagos'],
            ['Valor pagado', formatCOP(r.amount)],
            ['Abono a capital', formatCOP(r.principal)],
            ['Abono a interés', formatCOP(r.interest)],
            ['Saldo pendiente actual', formatCOP(r.loan.outstanding)],
          ]}
        />
        {r.allocations?.length > 0 && (
          <p className="mt-3 text-xs text-slate-500">
            Aplicado a: {r.allocations.map((a) => `cuota ${a.number} (${formatCOP(a.principal + a.interest)})`).join(', ')}.
          </p>
        )}
        {r.status === 'reversed' && <p className="mt-3 text-sm text-red-700">Pago reversado: {r.reversal_reason}</p>}
      </Card>
    </main>
  );
}
