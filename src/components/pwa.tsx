'use client';
import { useEffect, useState, useSyncExternalStore } from 'react';

/** Registra el service worker y ofrece actualizar cuando hay una versión nueva en espera. */
export function ServiceWorkerRegister() {
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);

  useEffect(() => {
    if (!('serviceWorker' in navigator) || process.env.NODE_ENV !== 'production') return;
    let reloading = false;
    // Solo se recarga al ACTUALIZAR (ya había un service worker). En la primera visita el
    // service worker toma el control sin recargar: antes eso recargaba la página de sorpresa
    // y se perdían los toques del usuario.
    const hadController = Boolean(navigator.serviceWorker.controller);
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading || !hadController) return;
      reloading = true;
      window.location.reload();
    });
    navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }).then((reg) => {
      if (reg.waiting && navigator.serviceWorker.controller) setWaiting(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        sw?.addEventListener('statechange', () => {
          if (sw.state === 'installed' && navigator.serviceWorker.controller) setWaiting(sw);
        });
      });
      const timer = setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
      return () => clearInterval(timer);
    });
  }, []);

  if (!waiting) return null;
  return (
    <div className="no-print fixed inset-x-4 bottom-24 z-50 mx-auto max-w-md rounded-2xl bg-slate-900 p-4 text-sm text-white shadow-xl lg:bottom-6">
      <p className="font-semibold">Hay una nueva versión disponible</p>
      <p className="mt-0.5 text-slate-300">Actualice para usar las últimas correcciones.</p>
      <div className="mt-3 flex gap-2">
        <button className="btn-primary btn-sm" onClick={() => waiting.postMessage({ type: 'SKIP_WAITING' })}>
          Actualizar ahora
        </button>
        <button className="btn-sm rounded-xl px-3 text-slate-300" onClick={() => setWaiting(null)}>
          Más tarde
        </button>
      </div>
    </div>
  );
}

function subscribeOnline(cb: () => void) {
  window.addEventListener('online', cb);
  window.addEventListener('offline', cb);
  return () => {
    window.removeEventListener('online', cb);
    window.removeEventListener('offline', cb);
  };
}

export function useOnline() {
  return useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true);
}

/** Aviso sin conexión: nada se registra ni se presenta como confirmado sin servidor. */
export function OnlineStatus() {
  const online = useOnline();
  if (online) return null;
  return (
    <div className="no-print bg-amber-100 px-4 py-2 text-center text-sm text-amber-900" role="status">
      Sin conexión. Los datos pueden estar desactualizados y no se pueden registrar pagos hasta recuperar Internet.
    </div>
  );
}

type BeforeInstallPromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };
type Platform = 'ios' | 'android' | 'other';

/*
 * Estado de instalación compartido. Chrome dispara `beforeinstallprompt` una sola vez por
 * carga de página (y a veces antes de que React hidrate), así que se escucha al cargar el
 * módulo y todos los componentes (banner, botón del login, página /instalar) leen lo mismo.
 */
let deferredPrompt: BeforeInstallPromptEvent | null = null;
let installedNow = false;
const installListeners = new Set<() => void>();
const notifyInstall = () => installListeners.forEach((l) => l());

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e as BeforeInstallPromptEvent;
    notifyInstall();
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    installedNow = true;
    notifyInstall();
  });
}

function subscribeInstall(cb: () => void) {
  installListeners.add(cb);
  return () => installListeners.delete(cb);
}

function isStandalone() {
  return (
    installedNow ||
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as { standalone?: boolean }).standalone === true
  );
}

function detectPlatform(): Platform {
  const ua = navigator.userAgent;
  return /iphone|ipad|ipod/i.test(ua) ? 'ios' : /android/i.test(ua) ? 'android' : 'other';
}

/** Lanza el diálogo nativo de instalación. Devuelve true si el usuario aceptó. */
async function runInstall() {
  const prompt = deferredPrompt;
  if (!prompt) return false;
  await prompt.prompt();
  const { outcome } = await prompt.userChoice;
  deferredPrompt = null; // el evento solo sirve una vez
  if (outcome === 'accepted') installedNow = true;
  notifyInstall();
  return outcome === 'accepted';
}

export function useInstall() {
  const canPrompt = useSyncExternalStore(subscribeInstall, () => deferredPrompt !== null, () => false);
  const installed = useSyncExternalStore(subscribeInstall, isStandalone, () => false);
  const platform = useSyncExternalStore(subscribeInstall, detectPlatform, () => 'other' as Platform);
  return { canPrompt, installed, platform, install: runInstall };
}

/** Botón grande de instalación con instrucciones de respaldo según el teléfono. */
export function InstallPrompt() {
  const { canPrompt, installed, platform, install } = useInstall();

  if (installed) return <p className="text-sm text-slate-800">✅ La aplicación ya está instalada en este dispositivo.</p>;
  if (canPrompt) {
    return (
      <div className="space-y-2">
        <button className="btn-primary w-full py-3 text-base" onClick={install}>
          📲 Descargar e instalar en este celular
        </button>
        <p className="text-xs text-slate-500">Un toque y listo: el icono aparece en su pantalla de inicio. Pesa menos de 1 MB.</p>
      </div>
    );
  }
  if (platform === 'ios') {
    return <p className="text-sm text-slate-600">En iPhone: toque <strong>Compartir</strong> en Safari y luego <strong>Añadir a pantalla de inicio</strong>.</p>;
  }
  if (platform === 'android') {
    return (
      <p className="text-sm text-slate-600">
        Abra este enlace en <strong>Google Chrome</strong>, toque el menú <strong>⋮</strong> (arriba a la derecha) y elija{' '}
        <strong>Instalar aplicación</strong> o <strong>Añadir a pantalla principal</strong>.
      </p>
    );
  }
  return <p className="text-sm text-slate-600">Abra el menú del navegador (⋮) y elija <strong>Instalar aplicación</strong> o <strong>Añadir a pantalla principal</strong>.</p>;
}

/** Comparte el enlace de descarga (WhatsApp, SMS…) para que otra persona instale la app. */
export function ShareInstallLink() {
  const [copied, setCopied] = useState(false);
  async function share() {
    const url = `${window.location.origin}/instalar`;
    const text = 'Descargue la app Capital Control en su celular:';
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Capital Control', text, url });
        return;
      } catch (e) {
        if ((e as Error).name === 'AbortError') return;
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      window.open(`https://wa.me/?text=${encodeURIComponent(`${text} ${url}`)}`, '_blank', 'noopener');
    }
  }
  return (
    <button className="btn-secondary w-full" onClick={share}>
      {copied ? '✅ Enlace copiado' : '🔗 Compartir enlace de descarga'}
    </button>
  );
}

/** Acceso directo de descarga en el login: un toque si el navegador lo permite, si no lleva a /instalar. */
export function InstallCallout() {
  const { canPrompt, installed, install } = useInstall();
  if (installed) return null;
  return (
    <div className="mt-6 rounded-2xl border border-brand-100 bg-brand-50 p-4">
      <p className="font-semibold text-brand-900">📲 Descargue la app en su celular</p>
      <p className="mt-0.5 text-sm text-slate-600">Gratis, sin tienda de aplicaciones y con avisos de cobro.</p>
      {canPrompt ? (
        <button className="btn-primary mt-3 w-full" onClick={install}>Descargar para Android</button>
      ) : (
        <a href="/instalar" className="btn-secondary mt-3 flex w-full">Ver cómo instalarla</a>
      )}
    </div>
  );
}

const DISMISS_KEY = 'cc_install_banner_dismissed';
const DISMISS_DAYS = 7;

/** Banner flotante que aparece solo cuando Android permite instalar con un toque. */
export function InstallBanner() {
  const { canPrompt, installed, install } = useInstall();
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    try {
      const at = Number(localStorage.getItem(DISMISS_KEY) ?? 0);
      setDismissed(Date.now() - at < DISMISS_DAYS * 24 * 60 * 60 * 1000);
    } catch {
      setDismissed(false);
    }
  }, []);

  if (!canPrompt || installed || dismissed) return null;
  const close = () => {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISS_KEY, String(Date.now()));
    } catch {}
  };
  return (
    <div className="no-print fixed inset-x-4 bottom-24 z-40 mx-auto flex max-w-md items-center gap-3 rounded-2xl bg-white p-3 shadow-xl ring-1 ring-slate-200 lg:bottom-6" role="dialog" aria-label="Instalar la aplicación">
      <img src="/icons/icon-192.png" alt="" className="size-11 shrink-0 rounded-xl" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">Instale Capital Control</p>
        <p className="text-xs text-slate-500">Ábrala desde su pantalla de inicio, como una app.</p>
      </div>
      <button className="btn-primary btn-sm shrink-0" onClick={install}>Instalar</button>
      <button className="shrink-0 px-1 text-lg leading-none text-slate-400" onClick={close} aria-label="Ahora no">×</button>
    </div>
  );
}

function urlBase64ToUint8Array(base64: string) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

/** Activa/desactiva notificaciones. El permiso se pide solo tras pulsar, después de explicar su utilidad. */
export function PushToggle({ vapidPublicKey, initiallyEnabled }: { vapidPublicKey: string; initiallyEnabled: boolean }) {
  const [status, setStatus] = useState<'idle' | 'working' | 'enabled' | 'disabled' | 'unsupported' | 'denied' | 'ios-browser'>('idle');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
      const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
      setStatus(ios ? 'ios-browser' : 'unsupported');
      return;
    }
    if (Notification.permission === 'denied') return setStatus('denied');
    navigator.serviceWorker.ready
      .then((reg) => reg.pushManager.getSubscription())
      .then((sub) => setStatus(sub && initiallyEnabled ? 'enabled' : 'disabled'))
      .catch(() => setStatus('disabled'));
  }, [initiallyEnabled]);

  async function enable() {
    setError('');
    if (!vapidPublicKey) return setError('Las notificaciones aún no están configuradas en el servidor (claves VAPID).');
    setStatus('working');
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') return setStatus(permission === 'denied' ? 'denied' : 'disabled');
      const reg = await navigator.serviceWorker.ready;
      const sub =
        (await reg.pushManager.getSubscription()) ??
        (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) }));
      const res = await fetch('/api/push/subscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sub.toJSON()) });
      if (!res.ok) throw new Error((await res.json()).error ?? 'Error');
      setStatus('enabled');
    } catch (e) {
      setError((e as Error).message);
      setStatus('disabled');
    }
  }

  async function disable() {
    setStatus('working');
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      await fetch('/api/push/subscribe', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: sub?.endpoint }) });
      await sub?.unsubscribe();
      setStatus('disabled');
    } catch (e) {
      setError((e as Error).message);
      setStatus('enabled');
    }
  }

  if (status === 'ios-browser')
    return <p className="text-sm text-slate-600">En iPhone las notificaciones requieren iOS 16.4 o superior y abrir la app desde la pantalla de inicio (no desde Safari).</p>;
  if (status === 'unsupported') return <p className="text-sm text-slate-600">Este navegador no admite notificaciones push.</p>;
  if (status === 'denied')
    return <p className="text-sm text-amber-800">El permiso fue bloqueado. Habilítelo en los ajustes del navegador o del teléfono para este sitio.</p>;
  return (
    <div className="space-y-2">
      {status === 'enabled' ? (
        <button className="btn-secondary" onClick={disable}>Desactivar notificaciones en este dispositivo</button>
      ) : (
        <button className="btn-primary" onClick={enable} disabled={status === 'working' || status === 'idle'}>
          {status === 'working' ? 'Activando…' : 'Activar notificaciones'}
        </button>
      )}
      {status === 'enabled' && <p className="text-sm text-slate-800">Notificaciones activas en este dispositivo.</p>}
      {error && <p className="field-error">{error}</p>}
    </div>
  );
}

export function PrintButton({ label = 'Imprimir / Guardar PDF' }: { label?: string }) {
  return (
    <button className="btn-secondary no-print" onClick={() => window.print()}>
      {label}
    </button>
  );
}
