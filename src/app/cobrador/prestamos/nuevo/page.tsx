import Link from 'next/link';
import { LoanCalculator } from '@/components/loan-calculator';
import { LinkButton, Notice } from '@/components/ui';
import { requireRole, userDb } from '@/lib/auth';
import { todayBogota } from '@/lib/finance';
import { uuidOrNull } from '@/lib/validation';
import { createLoan } from '../../actions';

export const metadata = { title: 'Crear préstamo' };

export default async function CollectorNewLoanPage({ searchParams }: { searchParams: Promise<{ cliente?: string; nuevo?: string; acceso?: string }> }) {
  const sp = await searchParams;
  const profile = await requireRole('collector');
  const db = await userDb();
  const customers = await db.query<{ id: string; full_name: string; document_number: string }>(
    `select id, full_name, document_number from public.customers where collector_id = $1 and status = 'active' order by full_name`, [profile.id]);
  const selected = uuidOrNull(sp.cliente);
  const fresh = sp.nuevo === '1' ? customers?.find((c) => c.id === selected) : undefined;

  return (
    <>
      <Link href="/cobrador" className="mb-3 inline-block text-sm text-slate-600">← Inicio</Link>
      <h1 className="mb-4 text-2xl font-bold">Crear préstamo</h1>
      {fresh && (
        <div className="mb-4">
          <Notice tone="neutral" title={`${fresh.full_name} quedó registrado`}>
            {sp.acceso === '1' && <>Entra a la app con usuario <strong>{fresh.document_number}</strong> y contraseña <strong>{fresh.document_number}</strong> (la cambiará al entrar).</>}
            {sp.acceso === 'error' && <>No se pudo crear su acceso a la app; puede intentarlo desde su ficha.</>}
            {' '}Ahora cree su préstamo.
          </Notice>
        </div>
      )}
      {!customers?.length ? (
        <div className="space-y-3 text-center">
          <p className="text-sm text-slate-500">Primero registre un cliente.</p>
          <LinkButton href="/cobrador/clientes/nuevo">Nuevo cliente</LinkButton>
        </div>
      ) : (
        <LoanCalculator today={todayBogota()} customers={customers} defaultCustomer={selected ?? undefined} action={createLoan} submitLabel="Crear préstamo" />
      )}
    </>
  );
}
