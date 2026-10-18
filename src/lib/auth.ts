import 'server-only';
import { createHash, randomBytes } from 'node:crypto';
import { cache } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { dbAs, systemDb, type Db } from '@/lib/db';
import { DUMMY_HASH, verifyPassword } from '@/lib/password';

export type AppRole = 'admin' | 'collector' | 'partner' | 'customer';

export interface SessionProfile {
  id: string;
  email: string;
  role: AppRole;
  full_name: string;
  active: boolean;
  must_change_password: boolean;
}

export const ROLE_HOME: Record<AppRole, string> = { admin: '/admin', collector: '/cobrador', partner: '/socio', customer: '/cliente' };
export const ROLE_LABEL: Record<AppRole, string> = { admin: 'Administrador', collector: 'Cobrador', partner: 'Socio', customer: 'Cliente' };

export const SESSION_COOKIE = 'cc_session';
const SESSION_DAYS = 7;
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Perfil del usuario de la sesión actual (validada en la base de datos, no solo por la cookie). */
export const getSessionProfile = cache(async (): Promise<SessionProfile | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return systemDb().one<SessionProfile>(
    `select u.id, u.email, u.must_change_password, p.role, p.full_name, p.active
       from auth.sessions s
       join auth.users u on u.id = s.user_id
       join public.profiles p on p.id = u.id
      where s.token_hash = $1 and s.expires_at > now()`,
    [sha256(token)],
  );
});

/** Exige sesión activa con uno de los roles; si no, redirige. La base de datos vuelve a verificarlo. */
export async function requireRole(...roles: AppRole[]): Promise<SessionProfile> {
  const profile = await getSessionProfile();
  if (!profile) redirect('/login');
  if (!profile.active) redirect('/login?error=inactive');
  if (profile.must_change_password) redirect('/activar');
  if (!roles.includes(profile.role)) redirect(ROLE_HOME[profile.role]);
  return profile;
}

/** Base de datos con la identidad del usuario de la petición (RLS aplicado). */
export async function userDb(): Promise<Db> {
  const profile = await getSessionProfile();
  return profile ? dbAs({ sub: profile.id, role: 'authenticated' }) : dbAs({ role: 'anon' });
}

export type SignInResult = { ok: true; role: AppRole; mustChange: boolean } | { ok: false; error: string };

export async function signIn(email: string, password: string, userAgent: string | null): Promise<SignInResult> {
  const sys = systemDb();
  const user = await sys.one<{ id: string; password_hash: string; locked_until: string | null; must_change_password: boolean; role: AppRole; active: boolean }>(
    `select u.id, u.password_hash, u.locked_until, u.must_change_password, p.role, p.active
       from auth.users u join public.profiles p on p.id = u.id where u.email = $1`,
    [email.toLowerCase().trim()],
  );
  const valid = await verifyPassword(password, user?.password_hash ?? DUMMY_HASH);
  const generic = 'Correo o contraseña incorrectos.';
  if (!user) return { ok: false, error: generic };
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    return { ok: false, error: `Cuenta bloqueada temporalmente por intentos fallidos. Intente en ${LOCK_MINUTES} minutos.` };
  }
  if (!valid) {
    await sys.query(
      `update auth.users set failed_attempts = failed_attempts + 1,
              locked_until = case when failed_attempts + 1 >= $2 then now() + make_interval(mins => $3) end
        where id = $1`,
      [user.id, MAX_FAILED, LOCK_MINUTES],
    );
    return { ok: false, error: generic };
  }
  if (!user.active) return { ok: false, error: 'Su cuenta está inactiva. Contacte a la administración.' };

  const token = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  await sys.query(`update auth.users set failed_attempts = 0, locked_until = null, last_sign_in_at = now() where id = $1`, [user.id]);
  await sys.query(`delete from auth.sessions where user_id = $1 and expires_at < now()`, [user.id]);
  await sys.query(`insert into auth.sessions (user_id, token_hash, expires_at, user_agent) values ($1, $2, $3, $4)`, [
    user.id, sha256(token), expires.toISOString(), userAgent?.slice(0, 200) ?? null,
  ]);
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    expires,
  });
  return { ok: true, role: user.role, mustChange: user.must_change_password };
}

export async function signOut() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await systemDb().query(`delete from auth.sessions where token_hash = $1`, [sha256(token)]);
  jar.delete(SESSION_COOKIE);
}

/** Cambia la contraseña del usuario actual y cierra sus otras sesiones. */
export async function changeOwnPassword(userId: string, passwordHash: string) {
  const token = (await cookies()).get(SESSION_COOKIE)?.value ?? '';
  const sys = systemDb();
  await sys.query(`update auth.users set password_hash = $2, must_change_password = false where id = $1`, [userId, passwordHash]);
  await sys.query(`delete from auth.sessions where user_id = $1 and token_hash <> $2`, [userId, sha256(token)]);
}
