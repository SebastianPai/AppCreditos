import Link from 'next/link';
import { CustomerForm } from '@/components/customer-form';
import { Card, PageHeader } from '@/components/ui';
import { userDb } from '@/lib/auth';
import { createCustomer } from '../../actions';

export const metadata = { title: 'Nuevo cliente' };

export default async function NewCustomerPage() {
  const db = await userDb();
  const collectors = await db.query<{ id: string; full_name: string }>(`select id, full_name from public.profiles where role = 'collector' and active order by full_name`);
  return (
    <>
      <Link href="/admin/clientes" className="mb-3 inline-block text-sm text-brand-700">← Clientes</Link>
      <PageHeader title="Nuevo cliente" subtitle="El documento no puede repetirse. Solo se muestra completo a la administración." />
      <Card className="max-w-xl">
        <CustomerForm action={createCustomer} collectors={collectors ?? []} />
      </Card>
    </>
  );
}
