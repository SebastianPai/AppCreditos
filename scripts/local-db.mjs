// Servidor PostgreSQL local SIN Docker (PostgreSQL 17 compilado a WebAssembly, protocolo
// estándar en 127.0.0.1:54329). Los datos se guardan en .pgdata/.
// Uso: npm run db:local   y en otra terminal: npm run db:migrate && npm run db:seed && npm run dev
// Con Docker disponible, prefiera `docker compose up` (ver docs/DESPLIEGUE.md).
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

const port = Number(process.env.LOCAL_DB_PORT ?? 54329);
const db = await PGlite.create({ dataDir: './.pgdata', extensions: { pgcrypto } });
// Usuario propietario de la aplicación sin privilegios de superusuario, igual que en producción:
// así FORCE ROW LEVEL SECURITY se aplica de verdad.
await db.exec(`
  create extension if not exists pgcrypto;
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'app_owner') then
      create role app_owner nologin;
      grant create on database postgres to app_owner;
      grant create, usage on schema public to app_owner;
    end if;
  end $$;
`);
const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1', maxConnections: 20 });
await server.start();
console.log(`PostgreSQL local escuchando en postgres://postgres@127.0.0.1:${port}/postgres`);
console.log('Use en .env.local: DATABASE_URL=postgres://postgres:postgres@127.0.0.1:' + port + '/postgres y DATABASE_ROLE=app_owner');
process.on('SIGINT', async () => {
  await server.stop();
  await db.close();
  process.exit(0);
});
