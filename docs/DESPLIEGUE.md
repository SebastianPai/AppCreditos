# Instalación, configuración y despliegue

La aplicación solo necesita **Node.js** y **PostgreSQL** (sin servicios externos).

## 1. Requisitos

- Node.js 24 y npm.
- PostgreSQL 15 o superior: Heroku Postgres (producción), Docker (local) o el servidor
  local sin Docker incluido (`npm run db:local`).

## 2. Ejecutar en local

### Opción A — Docker (recomendada)
```bash
docker compose up --build                              # PostgreSQL 17 + app en http://localhost:3000
docker compose exec app node scripts/seed-demo.mjs     # usuarios y datos de demostración
```

### Opción B — Sin Docker
```bash
npm install
cp .env.example .env.local
npm run db:local        # terminal 1: PostgreSQL local (datos en .pgdata/)
npm run db:migrate      # terminal 2
npm run db:seed         # usuarios y datos de demostración
npm run dev             # http://localhost:3000
```

### Usuarios de demostración (`db:seed`)
Contraseña para todos: `Demo2026!`

| Rol | Correo |
|---|---|
| Administrador | admin@demo.co |
| Cobrador | cobrador@demo.co · cobrador2@demo.co |
| Socio | socio1@demo.co · socio2@demo.co |
| Cliente | cliente@demo.co |

El seed activa el **modo demostración** (Configuración → Cumplimiento) y crea socios,
aportes, clientes, préstamos con pagos, una solicitud pendiente y un gasto.

## 3. Base de datos

- Migraciones en `db/migrations/` (SQL puro). `npm run db:migrate` aplica las pendientes
  y las registra en `ops.schema_migrations`.
- La app se conecta con un usuario **propietario que no es superusuario**, y todas las tablas
  usan `FORCE ROW LEVEL SECURITY`: las políticas aplican también a ese usuario.
- Cada petición abre una transacción con la identidad del usuario (`request.jwt.claims`);
  las escrituras financieras se hacen solo en funciones de la base de datos que verifican el rol.

## 4. Despliegue en Heroku

```bash
heroku create capital-control-<sufijo>
heroku addons:create heroku-postgresql:essential-0      # define DATABASE_URL
heroku config:set NEXT_PUBLIC_SITE_URL=https://<app>.herokuapp.com CRON_SECRET=$(openssl rand -hex 32)
git push heroku master                                   # build + migraciones (fase release del Procfile)
heroku run node scripts/seed-demo.mjs                    # opcional: datos de demostración
```

Sin datos de demostración, cree el primer administrador:
```bash
heroku run node scripts/bootstrap-admin.mjs -- admin@empresa.co "Nombre Apellido"
```
Solo funciona si no existe ningún administrador; muestra una contraseña temporal que se
cambia en el primer ingreso. Los demás usuarios se crean en **Administración → Usuarios**.

**Tarea diaria** (cuotas vencidas y recordatorios): agregue *Heroku Scheduler* y programe
a las 11:00 UTC (6:00 a. m. Bogotá):
```bash
curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://<app>.herokuapp.com/api/cron/daily
```

**Notificaciones push**: `npm run vapid` y `heroku config:set` con las tres variables.

## 5. Pasarela de pagos (opcional, Wompi)

Sin pasarela, los clientes pagan por QR o transferencia y adjuntan comprobante; la
administración lo verifica. Para pago en línea configure `WOMPI_PUBLIC_KEY`,
`WOMPI_INTEGRITY_SECRET` y `WOMPI_EVENTS_SECRET`, registre la URL de eventos
`https://<app>/api/webhooks/wompi` y pruebe primero en sandbox, contrastando el formato
de firma de `src/lib/wompi.ts` con la documentación vigente de Wompi.

## 6. Instalar la app en los teléfonos

La página **Instalar** (menú de usuario) muestra estas instrucciones.

**Android (Chrome):** abra el enlace HTTPS → *Instalar Capital Control* (o menú ⋮ →
*Instalar aplicación*). Notificaciones: *Avisos* → *Activar notificaciones* → *Permitir*.

**iPhone (Safari, iOS 16.4+ para notificaciones):** abra el enlace en Safari →
*Compartir* → *Añadir a pantalla de inicio* → abra la app desde el icono → *Avisos* →
*Activar notificaciones*.
