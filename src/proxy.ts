import { NextResponse, type NextRequest } from 'next/server';

// Todo requiere sesión salvo el login, el cambio inicial de contraseña y la página sin conexión.
const PUBLIC = ['/login', '/activar', '/offline'];
const isPublic = (path: string) => PUBLIC.some((p) => path === p || path.startsWith(`${p}/`));

/**
 * Comprobación optimista: sin cookie de sesión no se entra a nada. La sesión se
 * valida de verdad contra la base de datos en el servidor (requireRole), y cada
 * consulta pasa por RLS.
 */
export function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  if (isPublic(path)) return NextResponse.next();
  if (!request.cookies.get('cc_session')?.value) {
    if (path.startsWith('/api/')) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
    const login = request.nextUrl.clone();
    login.pathname = '/login';
    login.search = path === '/' ? '' : `?next=${encodeURIComponent(path)}`;
    return NextResponse.redirect(login);
  }
  const response = NextResponse.next();
  // Las páginas con datos financieros nunca se guardan en cachés compartidas.
  response.headers.set('Cache-Control', 'private, no-store');
  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|icons/|sw.js|manifest.webmanifest|icon.png|favicon.ico|api/webhooks|api/cron).*)'],
};
