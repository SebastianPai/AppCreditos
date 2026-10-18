import Link from 'next/link';
import { CustomerForm } from '@/components/customer-form';
import { Card, Notice, PageHeader } from '@/components/ui';
import { userDb } from '@/lib/auth';
import { collectorCreateCustomer } from '../../actions';

export const metadata = { title: 'Nuevo cliente' };

export default async function CollectorNewCustomerPage() {
  const db = await userDb();
  const ops = await db.one<{ value: { collectors_can_create_customers?: boolean } }>(`select value from public.app_settings where key = 'operations'`);
  const enabled = ops?.value.collectors_can_create_customers ?? false;
  return (
    <>
      <Link href="/cobrador/clientes" className="mb-3 inline-block text-sm text-brand-700">← Mis clientes</Link>
      <PageHeader title="Nuevo cliente" subtitle="La cédula es obligatoria. El cliente queda asignado a usted." />
      {enabled ? (
        <Card className="max-w-xl">
          <CustomerForm action={collectorCreateCustomer} collectors={[]} allowAccount />
        </Card>
      ) : (
        <Notice tone="warning">La administración desactivó el registro de clientes por cobradores.</Notice>
      )}
    </>
  );
}
