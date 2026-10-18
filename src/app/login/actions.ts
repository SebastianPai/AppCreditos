'use server';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { ROLE_HOME, signIn as doSignIn } from '@/lib/auth';
import type { ActionResult } from '@/lib/errors';
import { formString } from '@/lib/validation';

const credentials = z.object({ email: z.string().email('Correo no válido'), password: z.string().min(1).max(200) });

/** Evita redirecciones abiertas: solo rutas internas. */
function safeNext(next: string): string | null {
  return next.startsWith('/') && !next.startsWith('//') ? next : null;
}

export async function signIn(_: ActionResult, fd: FormData): Promise<ActionResult> {
  const parsed = credentials.safeParse({ email: formString(fd, 'email'), password: fd.get('password') });
  if (!parsed.success) return { ok: false, error: 'Correo o contraseña incorrectos.' };
  const result = await doSignIn(parsed.data.email, parsed.data.password, (await headers()).get('user-agent'));
  if (!result.ok) return { ok: false, error: result.error };
  if (result.mustChange) redirect('/activar');
  redirect(safeNext(formString(fd, 'next')) ?? ROLE_HOME[result.role]);
}
