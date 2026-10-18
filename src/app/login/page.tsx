import { ActionForm } from '@/components/action-form';
import { Notice } from '@/components/ui';
import { signIn } from './actions';

export const metadata = { title: 'Iniciar sesión' };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const { next, error } = await searchParams;
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-6 py-10">
      <div className="mb-6 flex items-center gap-2 font-bold text-brand-700">
        <img src="/icons/icon-192.png" alt="" className="size-9 rounded-xl" /> Capital Control
      </div>
      <h1 className="text-2xl font-bold">Iniciar sesión</h1>
      {error === 'inactive' && <div className="mt-4"><Notice tone="danger">Su cuenta está inactiva. Contacte a la administración.</Notice></div>}
      <div className="mt-6">
        <ActionForm action={signIn} submitLabel="Entrar">
          <input type="hidden" name="next" value={next ?? ''} />
          <div>
            <label className="label" htmlFor="email">Correo o cédula</label>
            <input id="email" name="email" type="text" autoComplete="username" autoCapitalize="none" required className="input" />
          </div>
          <div>
            <label className="label" htmlFor="password">Contraseña</label>
            <input id="password" name="password" type="password" autoComplete="current-password" required className="input" />
          </div>
        </ActionForm>
      </div>
      <p className="mt-8 text-xs text-slate-500">
        Las cuentas las crea la administración. Si olvidó su contraseña, pida a un administrador que la restablezca.
      </p>
    </main>
  );
}
