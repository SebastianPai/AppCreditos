import { NextResponse } from 'next/server';
import { signOut } from '@/lib/auth';

export async function POST() {
  await signOut();
  // Redirección relativa: detrás del proxy de Heroku el "origin" interno es localhost.
  return new NextResponse(null, { status: 303, headers: { Location: '/login' } });
}
