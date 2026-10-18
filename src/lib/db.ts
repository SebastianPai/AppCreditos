import 'server-only';
import pg from 'pg';

/**
 * Acceso a PostgreSQL. Cada operación corre en su propia transacción con
 * request.jwt.claims fijado al usuario de la petición: las políticas RLS
 * (FORCE ROW LEVEL SECURITY) y las funciones de la base de datos deciden qué
 * puede ver y hacer. El servidor nunca omite ese contexto.
 */

// int8 y numeric como número (los importes caben de sobra en 2^53); fechas como texto ISO.
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));
pg.types.setTypeParser(1082, (v) => v);
pg.types.setTypeParser(1184, (v) => new Date(v).toISOString());
pg.types.setTypeParser(1114, (v) => new Date(`${v}Z`).toISOString());

declare global {
  // eslint-disable-next-line no-var
  var __ccPool: pg.Pool | undefined;
}

function pool(): pg.Pool {
  if (!globalThis.__ccPool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('Falta DATABASE_URL. Consulte .env.example y docs/DESPLIEGUE.md.');
    const local = /localhost|127\.0\.0\.1|@db:|@postgres:/.test(url) || process.env.DATABASE_SSL === 'false';
    globalThis.__ccPool = new pg.Pool({
      connectionString: url,
      // Heroku Postgres exige TLS con certificado autofirmado.
      ssl: local ? undefined : { rejectUnauthorized: false },
      max: Number(process.env.DATABASE_POOL_MAX ?? 8),
      application_name: 'capital_control',
    });
  }
  return globalThis.__ccPool;
}

export type Claims = { sub: string; role: 'authenticated' } | { role: 'service_role' } | { role: 'anon' };

export interface Db {
  query<T = Record<string, any>>(sql: string, params?: unknown[]): Promise<T[]>;
  one<T = Record<string, any>>(sql: string, params?: unknown[]): Promise<T | null>;
  rpc<T = any>(fn: string, args?: Record<string, unknown>): Promise<T>;
  /** Como rpc(), pero devuelve el error en lugar de lanzarlo (para Server Actions). */
  call<T = any>(fn: string, args?: Record<string, unknown>): Promise<{ data: T | null; error: Error | null }>;
}

const IDENT = /^[a-z_][a-z0-9_]*$/;
const ROLE = process.env.DATABASE_ROLE && IDENT.test(process.env.DATABASE_ROLE) ? process.env.DATABASE_ROLE : '';

async function run<T>(claims: Claims, sql: string, params: unknown[]): Promise<T[]> {
  const client = await pool().connect();
  try {
    await client.query('begin');
    // Opcional: rol propietario no superusuario cuando la conexión es de superusuario (desarrollo local).
    if (ROLE) await client.query(`set local role ${ROLE}`);
    await client.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
    const res = await client.query(sql, params as unknown[]);
    await client.query('commit');
    return res.rows as T[];
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

function serialize(v: unknown) {
  // Objetos y arreglos se envían como JSON (parámetros jsonb).
  return v !== null && typeof v === 'object' && !(v instanceof Date) && !(v instanceof Buffer) ? JSON.stringify(v) : v;
}

export function dbAs(claims: Claims): Db {
  const db: Db = {
    query: (sql, params = []) => run(claims, sql, params),
    one: async (sql, params = []) => (await run<any>(claims, sql, params))[0] ?? null,
    rpc: async (fn, args = {}) => {
      if (!IDENT.test(fn)) throw new Error('Función no válida');
      const keys = Object.keys(args);
      if (!keys.every((k) => IDENT.test(k))) throw new Error('Parámetro no válido');
      const named = keys.map((k, i) => `${k} => $${i + 1}`).join(', ');
      const rows = await run<{ result: any }>(claims, `select public.${fn}(${named}) as result`, keys.map((k) => serialize(args[k])));
      return rows[0]?.result;
    },
    call: async (fn, args = {}) => {
      try {
        return { data: await db.rpc(fn, args), error: null };
      } catch (e) {
        return { data: null, error: e as Error };
      }
    },
  };
  return db;
}

/** Contexto de sistema (cron, webhooks, inicio de sesión). Úselo solo tras verificar la operación. */
export const systemDb = () => dbAs({ role: 'service_role' });
