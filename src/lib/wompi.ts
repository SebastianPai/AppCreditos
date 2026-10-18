import 'server-only';
import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Integración opcional con Wompi (pasarela colombiana). Se activa solo si están
 * configuradas WOMPI_PUBLIC_KEY, WOMPI_INTEGRITY_SECRET y WOMPI_EVENTS_SECRET.
 * Antes de producción, valide estos formatos contra la documentación vigente de
 * Wompi y pruebe en su ambiente sandbox.
 */
export function wompiConfig() {
  const publicKey = process.env.WOMPI_PUBLIC_KEY ?? '';
  const integritySecret = process.env.WOMPI_INTEGRITY_SECRET ?? '';
  const eventsSecret = process.env.WOMPI_EVENTS_SECRET ?? '';
  return { enabled: Boolean(publicKey && integritySecret && eventsSecret), publicKey, integritySecret, eventsSecret };
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** URL del Web Checkout con firma de integridad (referencia = código de la solicitud de pago). */
export function checkoutUrl(reference: string, amountPesos: number, redirectUrl: string): string | null {
  const cfg = wompiConfig();
  if (!cfg.enabled) return null;
  const amountInCents = amountPesos * 100;
  const signature = sha256(`${reference}${amountInCents}COP${cfg.integritySecret}`);
  const params = new URLSearchParams({
    'public-key': cfg.publicKey,
    currency: 'COP',
    'amount-in-cents': String(amountInCents),
    reference,
    'signature:integrity': signature,
    'redirect-url': redirectUrl,
  });
  return `https://checkout.wompi.co/p/?${params.toString()}`;
}

interface WompiEvent {
  event?: string;
  data?: Record<string, unknown>;
  signature?: { properties?: string[]; checksum?: string };
  timestamp?: number;
}

function pick(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);
}

/** Verifica la firma del evento: SHA256(valores de signature.properties + timestamp + secreto de eventos). */
export function verifyEvent(body: WompiEvent, secret: string): boolean {
  const props = body.signature?.properties;
  const checksum = body.signature?.checksum;
  if (!Array.isArray(props) || !checksum || typeof body.timestamp !== 'number' || !body.data) return false;
  const concatenated = props.map((p) => String(pick(body.data, p) ?? '')).join('') + body.timestamp + secret;
  const expected = Buffer.from(sha256(concatenated));
  const received = Buffer.from(checksum.toLowerCase());
  return expected.length === received.length && timingSafeEqual(expected, received);
}

export type { WompiEvent };
