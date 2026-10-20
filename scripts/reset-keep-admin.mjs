// Deja la base de datos VACÍA conservando solo los administradores y la configuración
// (política de préstamo, ajustes, medios de pago, permisos). Opcionalmente crea un cobrador.
// Uso: npm run db:reset -- --yes [usuario contraseña "Nombre completo"]
import { scryptSync, randomBytes } from 'node:crypto';
import { connect } from './db.mjs';

const args = process.argv.slice(2);
if (!args.includes('--yes')) {
  console.error('Esto BORRA clientes, préstamos, pagos, capital y usuarios que no sean administradores.');
  console.error('Para confirmar: npm run db:reset -- --yes [usuario contraseña "Nombre"]');
  process.exit(1);
}
const [username, password, ...nameParts] = args.filter((a) => a !== '--yes');

function hash(pw) {
  const salt = randomBytes(16);
  const key = scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return ['scrypt', 16384, 8, 1, salt.toString('base64url'), key.toString('base64url')].join('$');
}

const DATA_TABLES = [
  'audit_logs', 'stored_files', 'notification_subscriptions', 'settlement_distributions', 'quarterly_settlements',
  'cash_handovers', 'collector_commissions', 'collector_payouts', 'reversal_requests', 'payment_allocations', 'payments',
  'payment_requests', 'loan_installments', 'loans', 'loan_applications', 'loan_simulations', 'customers', 'expenses',
  'capital_contributions', 'financial_entries', 'financial_transactions', 'capital_accounts', 'partners',
];
const SEQUENCES = ['tx_number_seq', 'customer_code_seq', 'application_code_seq', 'loan_code_seq', 'payment_request_code_seq', 'receipt_number_seq'];

const client = connect();
await client.connect();
try {
  await client.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', false)`);
  await client.query('begin');
  await client.query(`truncate ${DATA_TABLES.map((t) => `public.${t}`).join(', ')} restart identity cascade`);
  for (const s of SEQUENCES) await client.query(`alter sequence public.${s} restart with 1`);
  await client.query(`update public.loan_policies set created_by = null, activated_by = null
                       where created_by in (select id from public.profiles where role <> 'admin')
                          or activated_by in (select id from public.profiles where role <> 'admin')`);
  await client.query(`update public.app_settings set updated_by = null where updated_by in (select id from public.profiles where role <> 'admin')`);
  await client.query(`delete from auth.users where id in (select id from public.profiles where role <> 'admin')`);
  await client.query('truncate auth.sessions');
  await client.query(`update public.app_settings set value = value || '{"collectors_can_create_customers": true, "collectors_can_approve_loans": true}'::jsonb
                       where key = 'operations'`);
  if (username && password) {
    await client.query(
      `insert into auth.users (email, password_hash, must_change_password, raw_app_meta_data, raw_user_meta_data)
       values (lower($1), $2, false, '{"role":"collector"}', jsonb_build_object('full_name', $3::text))`,
      [username, hash(password), nameParts.join(' ').trim() || username],
    );
  }
  await client.query('commit');
  const { rows } = await client.query(`select u.email, p.role, p.full_name from auth.users u join public.profiles p on p.id = u.id order by p.role`);
  console.log('Base de datos reiniciada. Usuarios:');
  for (const r of rows) console.log(`  ${r.role.padEnd(10)} ${r.email}  (${r.full_name})`);
} catch (e) {
  await client.query('rollback').catch(() => {});
  throw e;
} finally {
  await client.end();
}
