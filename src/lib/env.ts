/** Variables de entorno. Las públicas (NEXT_PUBLIC_*) se incrustan en el cliente. */
export const publicEnv = {
  siteUrl: process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000',
  vapidPublicKey: process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? '',
};

export function optionalServerEnv() {
  return {
    vapidPrivateKey: process.env.VAPID_PRIVATE_KEY ?? '',
    vapidSubject: process.env.VAPID_SUBJECT ?? '',
    cronSecret: process.env.CRON_SECRET ?? '',
  };
}
