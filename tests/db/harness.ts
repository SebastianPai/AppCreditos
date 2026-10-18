/**
 * Arnés de integración: ejecuta las migraciones reales de db/migrations en
 * PostgreSQL (PGlite, WASM) con un rol propietario no superusuario, igual que en
 * producción. Las consultas fijan request.jwt.claims como lo hace el servidor,
 * de modo que FORCE RLS y las comprobaciones de rol se prueban de verdad.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

// Usuario propietario de la aplicación: NO superusuario, para que FORCE RLS aplique
// exactamente como en Heroku Postgres / Docker.
const APP_ROLE = `
create role app_owner nologin;
grant create on database postgres to app_owner;
grant create, usage on schema public to app_owner;
`;

export type Who = { kind: 'anon' } | { kind: 'service' } | { kind: 'user'; id: string } | { kind: 'owner' };

export class TestDb {
  private constructor(readonly pg: PGlite) {}

  static async create(): Promise<TestDb> {
    const pg = new PGlite({ extensions: { pgcrypto } });
    await pg.exec('create extension if not exists pgcrypto;');
    await pg.exec(APP_ROLE);
    await pg.exec('set role app_owner');
    const dir = join(process.cwd(), 'db', 'migrations');
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      try {
        await pg.exec(readFileSync(join(dir, file), 'utf8'));
      } catch (e) {
        throw new Error(`Migración ${file} falló: ${(e as Error).message}`);
      }
    }
    await pg.exec('reset role');
    return new TestDb(pg);
  }

  /** Como la app: rol propietario (no superusuario) + claims del usuario de la petición. */
  private async become(who: Who) {
    await this.pg.exec('reset role');
    if (who.kind === 'owner') {
      await this.pg.query(`select set_config('request.jwt.claims', '', false)`);
      return;
    }
    const claims =
      who.kind === 'user' ? { sub: who.id, role: 'authenticated' } : who.kind === 'service' ? { role: 'service_role' } : { role: 'anon' };
    await this.pg.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify(claims)]);
    await this.pg.exec('set role app_owner');
  }

  /** Ejecuta una consulta como el usuario indicado y vuelve al propietario. */
  async query<T = Record<string, unknown>>(who: Who, sql: string, params: unknown[] = []): Promise<T[]> {
    await this.become(who);
    try {
      return (await this.pg.query<T>(sql, params)).rows;
    } finally {
      await this.become({ kind: 'owner' });
    }
  }

  /** Llama a una función RPC con parámetros nombrados, como lo haría PostgREST. */
  async rpc<T = unknown>(who: Who, fn: string, args: Record<string, unknown> = {}): Promise<T> {
    const keys = Object.keys(args);
    const named = keys.map((k, i) => `${k} => $${i + 1}`).join(', ');
    const rows = await this.query<{ result: T }>(who, `select public.${fn}(${named}) as result`, keys.map((k) => args[k]));
    return rows[0]?.result as T;
  }

  async owner<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.query<T>({ kind: 'owner' }, sql, params);
  }

  /** Crea un usuario de auth (el trigger crea su perfil). */
  async createUser(role: 'admin' | 'collector' | 'partner' | 'customer', name: string, customerId?: string): Promise<string> {
    const meta: Record<string, string> = { role };
    if (role === 'admin') meta.bootstrap = 'true';
    if (customerId) meta.customer_id = customerId;
    const rows = await this.owner<{ id: string }>(
      `insert into auth.users (email, password_hash, raw_app_meta_data, raw_user_meta_data) values ($1, 'x', $2, $3) returning id`,
      [`${name.toLowerCase().replace(/\s+/g, '.')}@test.local`, JSON.stringify(meta), JSON.stringify({ full_name: name })],
    );
    return rows[0].id;
  }

  async close() {
    await this.pg.close();
  }
}

export const user = (id: string): Who => ({ kind: 'user', id });
export const anon: Who = { kind: 'anon' };
export const service: Who = { kind: 'service' };

export function isoDaysFromToday(days: number): string {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date());
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Escenario base: admin, cobradores, socios 50/50, clientes y cumplimiento configurado para pruebas. */
export async function seedScenario(db: TestDb) {
  const admin = await db.createUser('admin', 'Admin Principal');
  const collector = await db.createUser('collector', 'Cobrador Uno');
  const collector2 = await db.createUser('collector', 'Cobrador Dos');
  const partnerUser1 = await db.createUser('partner', 'Socio Uno');
  const partnerUser2 = await db.createUser('partner', 'Socio Dos');
  const A = user(admin);

  const partner1 = await db.rpc<string>(A, 'upsert_partner', {
    p_id: null, p_seq: 1, p_display_name: 'Socio 1', p_share_bps: 5000, p_profile_id: partnerUser1, p_active: true,
  });
  const partner2 = await db.rpc<string>(A, 'upsert_partner', {
    p_id: null, p_seq: 2, p_display_name: 'Socio 2', p_share_bps: 5000, p_profile_id: partnerUser2, p_active: true,
  });

  const newCustomer = async (name: string, doc: string, col: string) =>
    db.rpc<string>(A, 'create_customer', {
      p_full_name: name, p_document_type: 'CC', p_document_number: doc, p_phone: '3001234567',
      p_address: null, p_collector_id: col, p_notes: null, p_data_consent: true,
    });
  const customerA = await newCustomer('Cliente Ana', '1012345678', collector);
  const customerB = await newCustomer('Cliente Beto', '1098765432', collector2);
  const customerUserA = await db.createUser('customer', 'Cliente Ana', customerA);
  const customerUserB = await db.createUser('customer', 'Cliente Beto', customerB);

  return { admin, collector, collector2, partnerUser1, partnerUser2, partner1, partner2, customerA, customerB, customerUserA, customerUserB };
}

export async function enableComplianceForTests(db: TestDb, adminId: string) {
  // SOLO PARA PRUEBAS: habilita la aprobación con un tope ficticio muy alto para
  // poder ejercitar el flujo completo. En producción el administrador registra la
  // tasa de usura vigente certificada y la referencia del concepto legal.
  await db.rpc(user(adminId), 'update_setting', {
    p_key: 'compliance',
    p_value: JSON.stringify({
      legal_review_completed: true,
      legal_review_reference: 'PRUEBA-AUTOMATIZADA',
      usury_rate_ea_percent: 1_000_000,
      usury_rate_valid_from: isoDaysFromToday(-365),
      usury_rate_valid_until: isoDaysFromToday(365),
    }),
  });
}
