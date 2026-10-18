import { ActionForm } from '@/components/action-form';
import { Card, Notice, PageHeader, StatusBadge } from '@/components/ui';
import { formatCOP, formatDateTime } from '@/lib/finance';
import { userDb } from '@/lib/auth';
import {
  activatePolicy, createPaymentMethod, createPolicy, saveCompany, saveCompliance, saveOperations, savePaymentInstructions, togglePaymentMethod, upsertPartner,
} from '../actions';

export const metadata = { title: 'Configuración' };

interface Compliance {
  mode?: 'enforce' | 'demo';
  legal_review_completed: boolean;
  legal_review_reference: string | null;
  usury_rate_ea_percent: number | null;
  usury_rate_valid_from: string | null;
  usury_rate_valid_until: string | null;
}

export default async function SettingsPage() {
  const db = await userDb();
  const [settings, policies, methods, partners, partnerUsers] = await Promise.all([
    db.query('select * from public.app_settings'),
    db.query('select * from public.loan_policies order by version desc'),
    db.query('select * from public.payment_methods order by created_at'),
    db.query('select * from public.partners order by seq'),
    db.query<{ id: string; full_name: string }>(`select id, full_name from public.profiles where role = 'partner'`),
  ]);
  const get = <T,>(k: string) => settings?.find((s) => s.key === k)?.value as T | undefined;
  const compliance = get<Compliance>('compliance');
  const company = get<{ name: string; legal_name: string | null; nit: string | null; support_phone: string | null }>('company');
  const instructions = get<{ text: string | null }>('payment_instructions');
  const active = policies?.find((p) => p.status === 'active');
  // Siempre se muestran al menos dos fichas de socio (el negocio tiene dos socios).
  const partnerRows = [...(partners ?? []), ...Array(Math.max(0, 2 - (partners?.length ?? 0))).fill(null)];

  return (
    <>
      <PageHeader title="Configuración" subtitle="Todos los cambios quedan registrados en la auditoría con usuario, fecha, valor anterior y nuevo." />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Cumplimiento normativo (Colombia)">
          <Notice tone="warning">
            Mientras no exista revisión legal y una tasa de usura vigente registrada, el sistema <strong>bloquea</strong> aprobaciones y desembolsos. Cada
            préstamo se compara con la tasa de usura (efectiva anual) certificada por la Superintendencia Financiera para el periodo. Ver docs/CUMPLIMIENTO.md.
          </Notice>
          <ActionForm action={saveCompliance} submitLabel="Guardar cumplimiento" className="mt-3 space-y-3">
            <div>
              <label className="label" htmlFor="mode">Modo</label>
              <select id="mode" name="mode" defaultValue={compliance?.mode ?? 'enforce'} className="input">
                <option value="enforce">Producción: bloquear préstamos que no cumplan</option>
                <option value="demo">Demostración: permitir todo (sin dinero real)</option>
              </select>
              <p className="mt-1 text-xs text-slate-500">El modo demostración sirve para portafolio y pruebas; el cambio queda en la auditoría.</p>
            </div>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="legal_review_completed" defaultChecked={compliance?.legal_review_completed} className="size-4" /> Revisión legal completada de condiciones, contratos, cobranza y datos personales</label>
            <input name="legal_review_reference" defaultValue={compliance?.legal_review_reference ?? ''} placeholder="Referencia del concepto legal (abogado, fecha)" className="input" aria-label="Referencia legal" />
            <div className="grid grid-cols-3 gap-2">
              <div><label className="label">Tasa de usura EA (%)</label><input name="usury_rate_ea_percent" inputMode="decimal" defaultValue={compliance?.usury_rate_ea_percent ?? ''} className="input" /></div>
              <div><label className="label">Vigente desde</label><input type="date" name="usury_rate_valid_from" defaultValue={compliance?.usury_rate_valid_from ?? ''} className="input" /></div>
              <div><label className="label">Vigente hasta</label><input type="date" name="usury_rate_valid_until" defaultValue={compliance?.usury_rate_valid_until ?? ''} className="input" /></div>
            </div>
          </ActionForm>
        </Card>

        <Card title="Política de préstamos (versionada)">
          {active && (
            <p className="mb-3 text-sm text-slate-700">
              Activa: <strong>v{active.version}</strong> · interés {active.interest_bps / 100} % (cobrador {active.collector_commission_bps / 100} % + socios{' '}
              {active.partners_bps / 100} %) · máx. {active.max_installments} cuotas · quincenal desde {formatCOP(active.biweekly_min_principal)} · capital{' '}
              {formatCOP(active.min_principal)}{active.max_principal ? ` a ${formatCOP(active.max_principal)}` : ' en adelante'}.
            </p>
          )}
          <ul className="mb-3 space-y-1 text-sm">
            {policies?.filter((p) => p.status === 'draft').map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-2 rounded-lg bg-slate-50 p-2">
                <span>Borrador v{p.version}: {p.interest_bps / 100} % · {p.max_installments} cuotas · {p.notes}</span>
                <ActionForm action={activatePolicy} submitLabel="Activar" confirmText="Aplica solo a préstamos aprobados desde ahora." className="space-y-1">
                  <input type="hidden" name="policy_id" value={p.id} />
                </ActionForm>
              </li>
            ))}
          </ul>
          <details>
            <summary className="cursor-pointer text-sm font-medium text-brand-700">Proponer nueva versión</summary>
            <ActionForm action={createPolicy} submitLabel="Crear borrador" className="mt-3 space-y-2">
              <div className="grid grid-cols-3 gap-2">
                <div><label className="label">Interés %</label><input name="interest_pct" defaultValue={active ? active.interest_bps / 100 : 20} className="input" /></div>
                <div><label className="label">Cobrador %</label><input name="collector_pct" defaultValue={active ? active.collector_commission_bps / 100 : 5} className="input" /></div>
                <div><label className="label">Socios %</label><input name="partners_pct" defaultValue={active ? active.partners_bps / 100 : 15} className="input" /></div>
                <div><label className="label">Máx. cuotas</label><input name="max_installments" type="number" min={1} max={5} defaultValue={active?.max_installments ?? 5} className="input" /></div>
                <div><label className="label">Quincenal desde</label><input name="biweekly_min" defaultValue={active?.biweekly_min_principal ?? 500000} className="input" /></div>
                <div><label className="label">Capital mínimo</label><input name="min_principal" defaultValue={active?.min_principal ?? 1} className="input" /></div>
                <div className="col-span-3"><label className="label">Capital máximo (vacío = sin tope)</label><input name="max_principal" defaultValue={active?.max_principal ?? ''} className="input" /></div>
              </div>
              <input name="notes" required placeholder="Motivo y autorización del cambio" className="input" aria-label="Motivo" />
            </ActionForm>
          </details>
        </Card>

        <Card title="Medios de pago y QR">
          <ul className="mb-3 space-y-2 text-sm">
            {methods?.map((m) => (
              <li key={m.id} className="flex items-center justify-between gap-2 rounded-lg bg-slate-50 p-2">
                <span>{m.name} {m.qr_image_path && '· con QR'} {!m.active && <span className="text-slate-500">(inactivo)</span>}</span>
                <ActionForm action={togglePaymentMethod} submitLabel={m.active ? 'Desactivar' : 'Activar'} variant="secondary" className="space-y-1">
                  <input type="hidden" name="id" value={m.id} /><input type="hidden" name="active" value={String(!m.active)} />
                </ActionForm>
              </li>
            ))}
          </ul>
          <details>
            <summary className="cursor-pointer text-sm font-medium text-brand-700">Agregar medio de pago</summary>
            <ActionForm action={createPaymentMethod} submitLabel="Guardar medio" className="mt-3 space-y-2" confirmText="La cuenta y el QR pertenecen a la empresa y fueron verificados.">
              <input name="name" required placeholder="Nombre (ej. Nequi empresa)" className="input" aria-label="Nombre" />
              <select name="kind" className="input" aria-label="Tipo"><option value="qr_info">QR informativo</option><option value="bank_transfer">Transferencia bancaria</option></select>
              <input name="account_holder" placeholder="Titular" className="input" aria-label="Titular" />
              <input name="account_reference" placeholder="Número de cuenta / llave" className="input" aria-label="Cuenta" />
              <textarea name="instructions" required rows={2} placeholder="Instrucciones para el cliente" className="input" aria-label="Instrucciones" />
              <div><label className="label">Imagen del QR (opcional, máx. 2 MB)</label><input type="file" name="qr" accept="image/png,image/jpeg,image/webp" className="input" /></div>
            </ActionForm>
          </details>
          <div className="mt-4 border-t border-slate-100 pt-3">
            <ActionForm action={savePaymentInstructions} submitLabel="Guardar instrucciones generales" variant="secondary">
              <textarea name="text" rows={3} defaultValue={instructions?.text ?? ''} className="input" placeholder="Instrucciones generales visibles para los clientes" aria-label="Instrucciones generales" />
            </ActionForm>
          </div>
        </Card>

        <Card title="Socios">
          <div className="space-y-4">
            {partnerRows.map((p, i) => (
              <ActionForm key={p?.id ?? `new-${i}`} action={upsertPartner} submitLabel={p ? 'Guardar socio' : 'Crear socio'} variant="secondary" className="grid grid-cols-2 gap-2 rounded-lg bg-slate-50 p-2">
                <input type="hidden" name="id" value={p?.id ?? ''} />
                <input name="display_name" defaultValue={p?.display_name ?? ''} required placeholder="Nombre" className="input" aria-label="Nombre" />
                <input name="seq" type="number" min={1} defaultValue={p?.seq ?? i + 1} className="input" aria-label="Orden" />
                <input name="share_pct" defaultValue={p ? p.share_bps / 100 : 50} className="input" aria-label="Participación %" />
                <select name="profile_id" defaultValue={p?.profile_id ?? ''} className="input" aria-label="Usuario">
                  <option value="">Sin usuario vinculado</option>
                  {partnerUsers?.map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
                </select>
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="active" defaultChecked={p?.active ?? true} className="size-4" /> Activo</label>
              </ActionForm>
            ))}
          </div>
          <p className="mt-2 text-xs text-slate-500">La bolsa de socios se reparte según la participación (inicialmente 50/50). Las participaciones activas deben sumar 100 %.</p>
        </Card>

        <Card title="Operación">
          <ActionForm action={saveOperations} submitLabel="Guardar">
            <label className="flex items-start gap-3 text-sm">
              <input type="checkbox" name="collectors_can_create_customers" defaultChecked={get<{ collectors_can_create_customers?: boolean }>('operations')?.collectors_can_create_customers ?? true} className="mt-0.5 size-5" />
              <span>Los cobradores pueden registrar clientes nuevos (con cédula obligatoria) y crearles acceso a la app.</span>
            </label>
          </ActionForm>
        </Card>

        <Card title="Empresa (comprobantes e informes)">
          <ActionForm action={saveCompany} submitLabel="Guardar">
            <input name="name" defaultValue={company?.name ?? ''} placeholder="Nombre comercial" className="input" aria-label="Nombre comercial" />
            <input name="legal_name" defaultValue={company?.legal_name ?? ''} placeholder="Razón social" className="input" aria-label="Razón social" />
            <input name="nit" defaultValue={company?.nit ?? ''} placeholder="NIT" className="input" aria-label="NIT" />
            <input name="support_phone" defaultValue={company?.support_phone ?? ''} placeholder="Teléfono de atención" className="input" aria-label="Teléfono" />
          </ActionForm>
          <p className="mt-2 text-xs text-slate-500">Última actualización: {formatDateTime(settings?.find((s) => s.key === 'company')?.updated_at)}</p>
        </Card>
      </div>
      <p className="mt-4 text-xs text-slate-500">
        Estado de políticas: {policies?.map((p) => <span key={p.id} className="mr-2">v{p.version} <StatusBadge map={{ active: { label: 'activa', tone: 'success' }, draft: { label: 'borrador', tone: 'warning' }, retired: { label: 'retirada', tone: 'neutral' } }} value={p.status} /></span>)}
      </p>
    </>
  );
}
