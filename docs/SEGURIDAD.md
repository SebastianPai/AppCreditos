# Seguridad, copias de seguridad y restauración

## Controles implementados

| Control | Dónde |
|---|---|
| Sin registro público; primer administrador solo con script y solo si no existe ninguno | `handle_new_auth_user`, `scripts/bootstrap-admin.mts` |
| El rol viene de `app_metadata` (solo escribible con service_role), nunca de datos del usuario | trigger de alta |
| Roles verificados en el servidor y otra vez en cada RPC (`_require_role`) | `src/lib/auth.ts`, migración 0003 |
| RLS en todas las tablas; clientes solo ven lo suyo; cobradores solo lo asignado | migración 0004 |
| Escrituras financieras solo vía RPC (sin INSERT/UPDATE directos para `authenticated`) | migración 0004 |
| Inmutabilidad: pagos, asignaciones, asientos, auditoría, aportes, gastos, contratos, comisiones, informes aprobados | triggers `_forbid_change`, `_guard_*` |
| Idempotencia de pagos | `payments.idempotency_key` único + bloqueo del préstamo |
| Restricciones de importes (positivos, totales cuadrados, pagado ≤ contractual) | CHECKs en 0001 |
| Partida doble balanceada | restricción diferida `financial_entries_balanced` |
| Auditoría con actor, rol, valores anteriores/nuevos; documento y teléfono enmascarados | `audit_row` |
| Comprobantes y QR guardados en PostgreSQL con RLS; se sirven solo a quien puede ver al cliente; tipos y tamaño limitados | `stored_files`, `/api/archivos/[id]` |
| Contraseñas con scrypt y sal; sesiones aleatorias (solo se guarda su SHA-256) en cookie httpOnly; bloqueo tras 5 intentos fallidos | `src/lib/auth.ts`, `src/lib/password.ts` |
| La app usa un usuario de base de datos no superusuario con FORCE RLS; el contexto de sistema solo existe dentro de funciones verificadas | `db/migrations/000000_platform.sql`, `000004_rls.sql` |
| Webhook de pasarela con firma SHA-256 y comparación en tiempo constante; importe y referencia verificados | `src/lib/wompi.ts` |
| Cron protegido con secreto (comparación en tiempo constante) | `/api/cron/daily` |
| Cabeceras: CSP, HSTS, X-Frame-Options DENY, nosniff, Referrer-Policy | `next.config.ts` |
| Páginas con datos: `Cache-Control: private, no-store`; el service worker no cachea datos | `src/proxy.ts`, `public/sw.js` |
| Notificaciones sin importes, nombres ni documentos | `src/lib/push.ts` |
| Redirecciones de login solo a rutas internas | `src/app/login/actions.ts` |

### Mejoras recomendadas antes de producción

- Añadir MFA (TOTP) para administradores.
- CSP con nonce en lugar de `'unsafe-inline'` (middleware que genere nonce por petición).
- Limitar tasa del simulador anónimo (`/api/simulate`, `simulate_loan`), p. ej. con
  Vercel Firewall o una tabla de contadores, para evitar llenar `loan_simulations`.
- Verificar contraseñas contra listas de contraseñas filtradas.
- Revisión periódica de usuarios activos y permisos explícitos.

## Copias de seguridad

1. **Heroku Postgres**: copias automáticas diarias (`heroku pg:backups:schedule DATABASE_URL --at '02:00 America/Bogota'`)
   y manuales (`heroku pg:backups:capture`). Descarga: `heroku pg:backups:download`.
2. **Copia lógica propia (recomendada, diaria y cifrada)** fuera de Heroku:
   ```bash
   pg_dump --format=custom --no-owner "$DATABASE_URL" -f backup-$(date +%F).dump
   gpg --symmetric --cipher-algo AES256 backup-$(date +%F).dump
   ```
   Conserve al menos 30 copias diarias y 12 mensuales en otro proveedor. Los comprobantes
   viven en la tabla `stored_files`, así que quedan incluidos.

## Restauración (procedimiento)

1. Cree una base de datos nueva (nunca restaure sobre producción sin respaldo previo):
   `heroku addons:create heroku-postgresql:essential-0 --as RESTORE` o `createdb` en Docker.
2. Restaure: `heroku pg:backups:restore <backup> RESTORE_URL` o
   `gpg -d backup.dump.gpg > backup.dump && pg_restore --no-owner -d "$NEW_DATABASE_URL" backup.dump`.
3. Verifique la integridad:
   ```sql
   -- Toda transacción debe cuadrar en cero
   select tx_id from financial_entries group by tx_id having sum(amount) <> 0;
   -- Cuotas pagadas no superan lo contractual
   select id from loan_installments where paid_principal > principal_amount or paid_interest > interest_amount;
   -- Saldos de préstamos = suma de pagos confirmados
   select l.code from loans l join v_loan_balances b on b.id = l.id
    where b.paid_total <> (select coalesce(sum(amount),0) from payments p where p.loan_id = l.id and p.status = 'confirmed');
   ```
4. Apunte `DATABASE_URL` a la base restaurada (`heroku pg:promote`).
5. Pruebe una restauración completa al menos **cada trimestre** y deje constancia.

## Incidentes

- Rotar credenciales de la base de datos (`heroku pg:credentials:rotate`) si se sospecha filtración.
- Cerrar todas las sesiones: `delete from auth.sessions;` (los usuarios deberán ingresar de nuevo).
- Desactivar usuarios comprometidos o restablecer su contraseña en Administración → Usuarios.
- Consultar la auditoría (`audit_logs`) para reconstruir las operaciones.
