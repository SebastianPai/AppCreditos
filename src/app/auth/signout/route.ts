import { NextResponse, type NextRequest } from 'next/server';
import { signOut } from '@/lib/auth';

export async function POST(request: NextRequest) {
  await signOut();
  return NextResponse.redirect(new URL('/login', request.nextUrl.origin), { status: 303 });
}
