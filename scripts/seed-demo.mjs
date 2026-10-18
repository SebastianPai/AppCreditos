// Carga datos de DEMOSTRACIÓN (portafolio): un usuario por rol, socios, capital,
// clientes, préstamos con pagos y solicitudes pendientes. Activa el modo demostración.
// Uso: npm run db:seed   (idempotente: si ya existe el administrador de demo, no hace nada)
//
// Todas las operaciones pasan por las mismas funciones de la base de datos que usa
// la aplicación (con sus validaciones, contabilidad y auditoría).
import { randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { connect } from './db.mjs';

const PASSWORD = process.env.DEMO_PASSWORD ?? 'Demo2026!';
const USERS = {
  admin: { email: 'admin@demo.co', name: 'Laura Administradora', role: 'admin' },
  collector: { email: 'cobrador@demo.co', name: 'Carlos Cobrador', role: 'collector' },
  collector2: { email: 'cobrador2@demo.co', name: 'Diana Cobradora', role: 'collector' },
  partner1: { email: 'socio1@demo.co', name: 'Andrés Socio', role: 'partner' },
  partner2: { email: 'socio2@demo.co', name: 'Beatriz Socia', role: 'partner' },
};

function hash(password) {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return ['scrypt', 16384, 8, 1, salt.toString('base64url'), key.toString('base64url')].join('$');
}
const day = (offset) => {
  const t = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date());
  const d = new Date(`${t}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};

const client = connect();
await client.connect();

async function as(claims, sql, params = []) {
  await client.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify(claims)]);
  return (await client.query(sql, params)).rows;
}
const system = (sql, params) => as({ role: 'service_role' }, sql, params);
let adminId;
const admin = (sql, params) => as({ sub: adminId, role: 'authenticated' }, sql, params);
const rpc = async (who, fn, args) => {
  const keys = Object.keys(args);
  const rows = await as(who, `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`,
    keys.map((k) => (args[k] !== null && typeof args[k] === 'object' ? JSON.stringify(args[k]) : args[k])));
  return rows[0].r;
};
const asAdmin = () => ({ sub: adminId, role: 'authenticated' });

try {
  const existing = await system('select id from auth.users where email = $1', [USERS.admin.email]);
  if (existing.length) {
    console.log('Los datos de demostración ya existen. Nada que hacer.');
    process.exit(0);
  }
  const anyAdmin = await system(`select 1 from public.profiles where role = 'admin'`);
  if (anyAdmin.length) {
    console.error('Ya existe un administrador real: no se cargan datos de demostración sobre una base en uso.');
    process.exit(1);
  }

  // 1. Usuarios (el primer administrador con la marca de inicialización; el resto los crea él).
  const pw = hash(PASSWORD);
  [{ id: adminId }] = await system(
    `insert into auth.users (email, password_hash, must_change_password, raw_app_meta_data, raw_user_meta_data)
     values ($1, $2, false, '{"role":"admin","bootstrap":"true"}', jsonb_build_object('full_name', $3::text)) returning id`,
    [USERS.admin.email, pw, USERS.admin.name]);
  const ids = { admin: adminId };
  for (const key of ['collector', 'collector2', 'partner1', 'partner2']) {
    const u = USERS[key];
    ids[key] = await rpc(asAdmin(), 'admin_create_user', { p_email: u.email, p_password_hash: pw, p_full_name: u.name, p_phone: '3001112233', p_role: u.role, p_customer_id: null });
  }

  // 2. Modo demostración, socios 50/50 y aportes de capital.
  await rpc(asAdmin(), 'update_setting', { p_key: 'compliance', p_value: { mode: 'demo', legal_review_completed: false } });
  await rpc(asAdmin(), 'update_setting', { p_key: 'company', p_value: { name: 'Capital Control (demo)', legal_name: null, nit: null, support_phone: null } });
  const p1 = await rpc(asAdmin(), 'upsert_partner', { p_id: null, p_seq: 1, p_display_name: USERS.partner1.name, p_share_bps: 5000, p_profile_id: ids.partner1, p_active: true });
  const p2 = await rpc(asAdmin(), 'upsert_partner', { p_id: null, p_seq: 2, p_display_name: USERS.partner2.name, p_share_bps: 5000, p_profile_id: ids.partner2, p_active: true });
  for (const p of [p1, p2]) {
    await rpc(asAdmin(), 'record_capital_movement', { p_partner_id: p, p_kind: 'contribution', p_amount: 5_000_000, p_occurred_on: day(-40), p_notes: 'Aporte inicial' });
  }

  // 3. Clientes (el primero con cuenta en la app).
  const customers = [];
  const people = [
    ['María Gómez', '1012345678', ids.collector], ['José Pérez', '1023456789', ids.collector], ['Ana Rodríguez', '1034567890', ids.collector],
    ['Luis Martínez', '1045678901', ids.collector2], ['Sofía Herrera', '1056789012', ids.collector2],
  ];
  for (const [name, doc, col] of people) {
    customers.push(await rpc(asAdmin(), 'create_customer', {
      p_full_name: name, p_document_type: 'CC', p_document_number: doc, p_phone: `300${doc.slice(-7)}`,
      p_address: 'Calle 10 # 20-30, Pasto', p_collector_id: col, p_notes: null, p_data_consent: true }));
  }
  const customerUser = await rpc(asAdmin(), 'admin_create_user', {
    p_email: 'cliente@demo.co', p_password_hash: pw, p_full_name: 'María Gómez', p_phone: '3002345678', p_role: 'customer', p_customer_id: customers[0] });
  await system('update auth.users set must_change_password = false');

  // 4. Préstamos: (cliente, cobrador, capital, cuotas, modalidad, días desde el desembolso, pagos [días, valor])
  const loans = [
    [0, ids.collector, 600_000, 4, 'weekly', -15, [[-8, 180_000], [-1, 100_000]]],
    [1, ids.collector, 300_000, 3, 'weekly', -22, [[-15, 120_000], [-8, 120_000], [-1, 120_000]]],
    [2, ids.collector, 800_000, 5, 'biweekly', -35, [[-20, 192_000]]],
    [3, ids.collector2, 500_000, 5, 'weekly', -10, [[-3, 120_000]]],
    [4, ids.collector2, 1_000_000, 4, 'biweekly', 0, []],
  ];
  for (const [ci, col, principal, n, freq, disbursedOffset, payments] of loans) {
    const app = await rpc(asAdmin(), 'create_application', {
      p_principal: principal, p_installments: n, p_frequency: freq, p_start_date: day(0),
      p_simulation_id: null, p_customer_id: customers[ci], p_message: 'Préstamo de demostración' });
    const loan = await rpc(asAdmin(), 'approve_application', {
      p_application_id: app, p_collector_id: col, p_principal: principal, p_installments: n, p_frequency: freq, p_start_date: day(0) });
    await rpc(asAdmin(), 'disburse_loan', { p_loan_id: loan, p_disbursed_on: day(disbursedOffset) });
    for (const [offset, amount] of payments) {
      // Los pagos históricos los registra administración con su fecha (un cobrador solo registra con la fecha de hoy).
      await rpc(asAdmin(), 'register_payment', {
        p_loan_id: loan, p_amount: amount, p_idempotency_key: randomUUID(), p_method: 'cash',
        p_received_on: day(offset), p_notes: null, p_evidence_path: null });
    }
  }
  // Un pago de hoy registrado por el cobrador (queda en su custodia hasta entregarlo).
  const [{ id: todayLoan }] = await admin(`select id from public.loans where customer_id = $1`, [customers[2]]);
  await rpc({ sub: ids.collector, role: 'authenticated' }, 'register_payment', {
    p_loan_id: todayLoan, p_amount: 50_000, p_idempotency_key: randomUUID(), p_method: 'cash', p_received_on: null, p_notes: 'Abono parcial', p_evidence_path: null });

  // 5. Una solicitud pendiente del cliente con cuenta y un gasto.
  await rpc({ sub: customerUser, role: 'authenticated' }, 'create_application', {
    p_principal: 400_000, p_installments: 4, p_frequency: 'weekly', p_start_date: day(2), p_simulation_id: null, p_customer_id: null, p_message: 'Para surtir mi negocio' });
  await rpc(asAdmin(), 'record_expense', { p_amount: 35_000, p_category: 'Transporte', p_description: 'Movilidad ruta de cobro', p_occurred_on: day(-5) });

  console.log('\nDatos de demostración cargados. Usuarios (contraseña para todos: ' + PASSWORD + '):');
  console.log('  Administrador: admin@demo.co');
  console.log('  Cobrador:      cobrador@demo.co   (y cobrador2@demo.co)');
  console.log('  Socio:         socio1@demo.co     (y socio2@demo.co)');
  console.log('  Cliente:       cliente@demo.co');
} finally {
  await client.end();
}
