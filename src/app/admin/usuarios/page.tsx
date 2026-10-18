import { ActionForm } from '@/components/action-form';
import { Card, Notice, PageHeader } from '@/components/ui';
import { ROLE_LABEL, type AppRole } from '@/lib/auth';
import { formatDateTime } from '@/lib/finance';
import { userDb } from '@/lib/auth';
import { createUser, resetUserPassword, setPermission, updateProfile } from '../actions';

export const metadata = { title: 'Usuarios' };

export default async function UsersPage() {
  const db = await userDb();
  const [users, perms, grants, customers] = await Promise.all([
    db.query(`select p.*, u.email, u.last_sign_in_at from public.profiles p join auth.users u on u.id = p.id order by p.role, p.full_name`),
    db.query<{ code: string; description: string }>('select * from public.permissions order by code'),
    db.query<{ user_id: string; permission_code: string }>('select user_id, permission_code from public.user_permissions'),
    db.query<{ id: string; code: string; full_name: string }>('select id, code, full_name from public.customers where profile_id is null order by full_name'),
  ]);
  const granted = new Set((grants ?? []).map((g) => `${g.user_id}:${g.permission_code}`));
  const staff = (users ?? []).filter((u) => u.role !== 'customer');
  const customerUsers = (users ?? []).filter((u) => u.role === 'customer');

  return (
    <>
      <PageHeader title="Usuarios y permisos" subtitle="No existe registro público: todas las cuentas las crea un administrador." />
      <div className="grid gap-4 lg:grid-cols-[360px_1fr]">
        <Card title="Crear usuario">
          <ActionForm action={createUser} submitLabel="Crear cuenta" resetOnSuccess>
            <input name="full_name" required placeholder="Nombre completo" className="input" aria-label="Nombre" />
            <input name="email" type="email" required placeholder="Correo" className="input" aria-label="Correo" />
            <input name="phone" placeholder="Teléfono (opcional)" className="input" aria-label="Teléfono" />
            <select name="role" defaultValue="collector" className="input" aria-label="Rol">
              {(['collector', 'partner', 'admin', 'customer'] as AppRole[]).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
            </select>
            <select name="customer_id" defaultValue="" className="input" aria-label="Ficha de cliente">
              <option value="">Ficha de cliente (solo para rol Cliente)</option>
              {customers?.map((c) => <option key={c.id} value={c.id}>{c.full_name} ({c.code})</option>)}
            </select>
          </ActionForm>
          <div className="mt-3"><Notice tone="info">Se genera una contraseña temporal que se muestra una sola vez. Entréguela al usuario: deberá cambiarla en su primer ingreso.</Notice></div>
        </Card>
        <Card title={`Equipo (${staff.length})`}>
          <ul className="divide-y divide-slate-100">
            {staff.map((u) => (
              <li key={u.id} className="py-3">
                <details>
                  <summary className="flex cursor-pointer items-center justify-between gap-2">
                    <span><strong>{u.full_name}</strong> <span className="text-sm text-slate-500">· {ROLE_LABEL[u.role as AppRole]} · {u.email}</span></span>
                    <span className={`text-xs ${u.active ? 'text-emerald-700' : 'text-red-700'}`}>{u.active ? 'Activo' : 'Inactivo'}</span>
                  </summary>
                  <div className="mt-3 grid gap-4 sm:grid-cols-2">
                    <ActionForm action={updateProfile} submitLabel="Guardar">
                      <input type="hidden" name="user_id" value={u.id} />
                      <input name="full_name" defaultValue={u.full_name} required className="input" aria-label="Nombre" />
                      <input name="phone" defaultValue={u.phone ?? ''} className="input" aria-label="Teléfono" placeholder="Teléfono" />
                      <select name="role" defaultValue={u.role} className="input" aria-label="Rol">
                        {(['admin', 'collector', 'partner'] as AppRole[]).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                      </select>
                      <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="active" defaultChecked={u.active} className="size-4" /> Activo</label>
                    </ActionForm>
                    <div className="space-y-2">
                      <p className="text-sm font-medium">Permisos explícitos</p>
                      {perms?.map((p) => {
                        const has = granted.has(`${u.id}:${p.code}`);
                        return (
                          <ActionForm key={p.code} action={setPermission} submitLabel={has ? 'Quitar' : 'Conceder'} variant={has ? 'secondary' : 'primary'} className="flex items-center justify-between gap-2 text-sm">
                            <input type="hidden" name="user_id" value={u.id} />
                            <input type="hidden" name="permission" value={p.code} />
                            <input type="hidden" name="granted" value={String(!has)} />
                            <span className="text-xs text-slate-600">{p.description}</span>
                          </ActionForm>
                        );
                      })}
                      <p className="text-xs text-slate-500">Alta: {formatDateTime(u.created_at)} · Último ingreso: {formatDateTime(u.last_sign_in_at)}</p>
                      <ActionForm action={resetUserPassword} submitLabel="Restablecer contraseña" variant="secondary">
                        <input type="hidden" name="user_id" value={u.id} />
                      </ActionForm>
                    </div>
                  </div>
                </details>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-sm text-slate-500">Cuentas de clientes: {customerUsers.length}. Se gestionan desde la ficha de cada cliente.</p>
        </Card>
      </div>
    </>
  );
}
