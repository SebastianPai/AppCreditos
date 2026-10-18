// Conexión compartida por los scripts de línea de comandos (migraciones y datos de demostración).
import pg from 'pg';

export function connect() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('Falta DATABASE_URL (ej. postgres://usuario:clave@localhost:5432/capital_control).');
    process.exit(1);
  }
  const local = /localhost|127\.0\.0\.1|@db:|@postgres:/.test(url) || process.env.DATABASE_SSL === 'false';
  const client = new pg.Client({ connectionString: url, ssl: local ? undefined : { rejectUnauthorized: false }, application_name: 'capital_control_cli' });
  const role = process.env.DATABASE_ROLE;
  if (role && /^[a-z_][a-z0-9_]*$/.test(role)) {
    // Desarrollo local: los objetos quedan a nombre del propietario no superusuario.
    const original = client.connect.bind(client);
    client.connect = async () => { await original(); await client.query(`set role ${role}`); };
    const end = client.end.bind(client);
    client.end = async () => { await client.query('reset role').catch(() => {}); await client.query("select set_config('request.jwt.claims', '', false)").catch(() => {}); return end(); };
  }
  return client;
}
