// Crea el PRIMER administrador (solo si no existe ninguno; lo garantiza la base de datos).
// Uso: npm run bootstrap:admin -- admin@empresa.co "Nombre Apellido"
// Muestra una contraseña temporal que debe cambiarse en el primer ingreso.
import { randomBytes, scryptSync } from 'node:crypto';
import { connect } from './db.mjs';

const [email, ...nameParts] = process.argv.slice(2);
const fullName = nameParts.join(' ').trim();
if (!email || !fullName) {
  console.error('Uso: npm run bootstrap:admin -- <correo> "<Nombre completo>"');
  process.exit(1);
}

const password = `Cc-${randomBytes(9).toString('base64url')}7`;
const salt = randomBytes(16);
const key = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
const hash = ['scrypt', 16384, 8, 1, salt.toString('base64url'), key.toString('base64url')].join('$');

const client = connect();
await client.connect();
try {
  await client.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', false)`);
  const { rows } = await client.query(`select 1 from public.profiles where role = 'admin'`);
  if (rows.length) {
    console.error('Ya existe un administrador. Los siguientes se crean desde la aplicación (Usuarios).');
    process.exit(1);
  }
  await client.query(
    `insert into auth.users (email, password_hash, must_change_password, raw_app_meta_data, raw_user_meta_data)
     values (lower($1), $2, true, '{"role":"admin","bootstrap":"true"}', jsonb_build_object('full_name', $3::text))`,
    [email, hash, fullName],
  );
  console.log('Administrador creado:', email.toLowerCase());
  console.log('Contraseña temporal (se pedirá cambiarla al ingresar):', password);
} finally {
  await client.end();
}
