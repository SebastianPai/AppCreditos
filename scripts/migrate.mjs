// Aplica en orden las migraciones de db/migrations que aún no se han aplicado.
// Uso: npm run db:migrate   (Heroku lo ejecuta en cada despliegue como fase "release")
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { connect } from './db.mjs';

const dir = join(process.cwd(), 'db', 'migrations');
const client = connect();
await client.connect();
try {
  await client.query("create schema if not exists ops");
  await client.query(`create table if not exists ops.schema_migrations (
    version text primary key, applied_at timestamptz not null default now())`);
  // Evita dos migraciones simultáneas (por ejemplo, dos despliegues).
  await client.query('select pg_advisory_lock(hashtext($1))', ['capital_control_migrations']);
  const done = new Set((await client.query('select version from ops.schema_migrations')).rows.map((r) => r.version));
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  let applied = 0;
  for (const file of files) {
    if (done.has(file)) continue;
    process.stdout.write(`Aplicando ${file}… `);
    await client.query('begin');
    try {
      // Heroku Postgres valida el texto de cada CREATE EXTENSION; se ejecutan aisladas
      // para que el resto del archivo (con expresiones regulares y barras) no interfiera.
      const sql = readFileSync(join(dir, file), 'utf8');
      const extensions = sql.match(/^create extension[^;]*;/gim) ?? [];
      for (const ext of extensions) await client.query(ext);
      await client.query(sql.replace(/^create extension[^;]*;/gim, ''));
      await client.query('insert into ops.schema_migrations (version) values ($1)', [file]);
      await client.query('commit');
      applied++;
      console.log('ok');
    } catch (e) {
      await client.query('rollback');
      console.log('ERROR');
      throw e;
    }
  }
  console.log(applied ? `${applied} migración(es) aplicadas.` : 'La base de datos ya está al día.');
} finally {
  await client.end();
}
