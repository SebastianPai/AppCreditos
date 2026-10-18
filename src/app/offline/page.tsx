export const metadata = { title: 'Sin conexión' };
export const dynamic = 'force-static';

export default function OfflinePage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-6 text-center">
      <img src="/icons/icon-192.png" alt="" className="mx-auto mb-4 size-14 rounded-2xl" />
      <h1 className="text-xl font-bold">Sin conexión a Internet</h1>
      <p className="mt-2 text-sm text-slate-600">
        Capital Control necesita conexión para mostrar saldos y registrar pagos. Ningún pago se registra ni se confirma sin conexión.
      </p>
      <a href="/" className="btn-primary mt-6">Reintentar</a>
    </main>
  );
}
