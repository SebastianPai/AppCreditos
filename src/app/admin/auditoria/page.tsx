import Link from 'next/link';
import { Card, PageHeader, TableWrap } from '@/components/ui';
import { formatDateTime } from '@/lib/finance';
import { userDb } from '@/lib/auth';

export const metadata = { title: 'Auditoría' };
const PAGE = 50;

const TABLES = ['app_settings', 'loan_policies', 'loans', 'payments', 'payment_requests', 'loan_applications', 'customers', 'profiles', 'partners', 'capital_contributions', 'expenses', 'quarterly_settlements', 'settlement_distributions', 'collector_payouts', 'cash_handovers', 'reversal_requests', 'payment_methods', 'user_permissions'];

function diff(oldData: Record<string, unknown> | null, newData: Record<string, unknown> | null): string {
  if (!oldData) return 'Creado';
  if (!newData) return 'Eliminado';
  const changed = Object.keys(newData).filter((k) => !['updated_at'].includes(k) && JSON.stringify(oldData[k]) !== JSON.stringify(newData[k]));
  return changed.map((k) => `${k}: ${JSON.stringify(oldData[k])} → ${JSON.stringify(newData[k])}`).join('; ').slice(0, 400) || 'Sin cambios de valor';
}

export default async function AuditPage({ searchParams }: { searchParams: Promise<{ tabla?: string; p?: string }> }) {
  const { tabla, p } = await searchParams;
  const page = Math.max(0, Number(p ?? 0) || 0);
  const db = await userDb();
  const [logs, people] = await Promise.all([
    db.query(
      `select * from public.audit_logs where ($3::text is null or table_name = $3) order by id desc limit $1 offset $2`,
      [PAGE, page * PAGE, tabla || null],
    ),
    db.query<{ id: string; full_name: string }>('select id, full_name from public.profiles'),
  ]);
  const names = new Map((people ?? []).map((x) => [x.id, x.full_name]));
  const href = (np: number) => `/admin/auditoria?${new URLSearchParams({ ...(tabla ? { tabla } : {}), p: String(np) })}`;

  return (
    <>
      <PageHeader title="Auditoría" subtitle="Registro inmutable de operaciones y cambios de configuración. Los documentos y teléfonos aparecen enmascarados." />
      <form className="mb-4 flex gap-2">
        <select name="tabla" defaultValue={tabla ?? ''} className="input max-w-xs" aria-label="Tabla">
          <option value="">Todas las entidades</option>
          {TABLES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <button className="btn-secondary">Filtrar</button>
      </form>
      <Card>
        <TableWrap>
          <table className="table">
            <thead><tr><th>Fecha</th><th>Usuario</th><th>Acción</th><th>Entidad</th><th>Detalle</th></tr></thead>
            <tbody>
              {(logs ?? []).map((l) => (
                <tr key={l.id}>
                  <td className="whitespace-nowrap">{formatDateTime(l.occurred_at)}</td>
                  <td>{l.actor_id ? names.get(l.actor_id) ?? l.actor_id.slice(0, 8) : l.actor_role ?? 'sistema'}<br /><span className="text-xs text-slate-500">{l.actor_role}</span></td>
                  <td>{l.action}</td>
                  <td>{l.table_name}<br /><span className="text-xs text-slate-500">{l.record_id?.slice(0, 8)}</span></td>
                  <td className="max-w-md text-xs break-words text-slate-600">{l.context ? JSON.stringify(l.context) : diff(l.old_data, l.new_data)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
        <div className="mt-3 flex justify-between">
          {page > 0 ? <Link href={href(page - 1)} className="btn-secondary btn-sm">← Más recientes</Link> : <span />}
          {(logs?.length ?? 0) === PAGE && <Link href={href(page + 1)} className="btn-secondary btn-sm">Anteriores →</Link>}
        </div>
      </Card>
    </>
  );
}
