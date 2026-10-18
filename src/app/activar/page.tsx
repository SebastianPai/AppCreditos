import { redirect } from 'next/navigation';
import { ActionForm } from '@/components/action-form';
import { getSessionProfile } from '@/lib/auth';
import { setPassword } from './actions';

export const metadata = { title: 'Activar cuenta' };

export default async function ActivatePage() {
  const profile = await getSessionProfile();
  if (!profile) redirect('/login?error=link');
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-6 py-10">
      <h1 className="text-2xl font-bold">Hola, {profile.full_name.split(' ')[0]}</h1>
      <p className="mt-1 text-sm text-slate-600">
        Cree una contraseña para activar su cuenta (
        {profile.email.endsWith('@clientes.capital-control.local') ? `usuario: cédula ${profile.email.split('@')[0]}` : profile.email}).
      </p>
      <div className="mt-6">
        <ActionForm action={setPassword} submitLabel="Guardar contraseña">
          <div>
            <label className="label" htmlFor="password">Nueva contraseña</label>
            <input id="password" name="password" type="password" autoComplete="new-password" required minLength={10} className="input" />
            <p className="mt-1 text-xs text-slate-500">Mínimo 10 caracteres, con letras y números.</p>
          </div>
          <div>
            <label className="label" htmlFor="confirm">Repita la contraseña</label>
            <input id="confirm" name="confirm" type="password" autoComplete="new-password" required minLength={10} className="input" />
          </div>
        </ActionForm>
      </div>
    </main>
  );
}
