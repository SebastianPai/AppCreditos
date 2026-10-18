import { redirect } from 'next/navigation';
import { getSessionProfile, ROLE_HOME } from '@/lib/auth';

/** Sin sesión no hay contenido: se redirige al login o al panel del rol. */
export default async function Home() {
  const profile = await getSessionProfile().catch(() => null);
  redirect(profile?.active ? ROLE_HOME[profile.role] : '/login');
}
