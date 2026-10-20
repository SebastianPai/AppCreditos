import Link from 'next/link';
import { ActionForm } from '@/components/action-form';
import { quickCreateCustomer } from '../../actions';

export const metadata = { title: 'Nuevo cliente' };

export default function CollectorNewCustomerPage() {
  return (
    <>
      <Link href="/cobrador" className="mb-3 inline-block text-sm text-slate-600">← Inicio</Link>
      <h1 className="mb-4 text-2xl font-bold">Nuevo cliente</h1>
      <ActionForm action={quickCreateCustomer} submitLabel="Crear cliente y seguir al préstamo">
        <div>
          <label className="label" htmlFor="full_name">Nombre completo</label>
          <input id="full_name" name="full_name" required minLength={3} autoComplete="off" className="input" />
        </div>
        <div>
          <label className="label" htmlFor="document_number">Cédula</label>
          <input id="document_number" name="document_number" required inputMode="numeric" autoComplete="off" className="input" />
        </div>
        <div>
          <label className="label" htmlFor="phone">Teléfono</label>
          <input id="phone" name="phone" required inputMode="tel" className="input" />
        </div>
        <div>
          <label className="label" htmlFor="address">Dirección (opcional)</label>
          <input id="address" name="address" className="input" />
        </div>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" name="create_account" defaultChecked className="mt-1 size-4" />
          <span>Darle acceso a la app (entra con su cédula; la contraseña inicial también es su cédula).</span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" name="data_consent" required className="mt-1 size-4" />
          <span>El cliente autorizó el uso de sus datos.</span>
        </label>
      </ActionForm>
    </>
  );
}
