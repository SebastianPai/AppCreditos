'use server';
import { redirect } from 'next/navigation';
import { changeOwnPassword, getSessionProfile, ROLE_HOME } from '@/lib/auth';
import type { ActionResult } from '@/lib/errors';
import { hashPassword, passwordProblem } from '@/lib/password';

export async function setPassword(_: ActionResult, fd: FormData): Promise<ActionResult> {
  const profile = await getSessionProfile();
  if (!profile) redirect('/login');
  const password = String(fd.get('password') ?? '');
  if (password !== String(fd.get('confirm') ?? '')) return { ok: false, error: 'Las contraseñas no coinciden.' };
  const problem = passwordProblem(password);
  if (problem) return { ok: false, error: problem };
  await changeOwnPassword(profile.id, await hashPassword(password));
  redirect(ROLE_HOME[profile.role]);
}
