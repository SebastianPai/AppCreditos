# Capital Control

Aplicación web instalable (PWA) para gestionar préstamos, clientes, cobradores,
cuotas, capital de dos socios, comisiones, pagos por QR y liquidaciones
trimestrales. Moneda COP, zona horaria America/Bogota.

> **Proyecto de portafolio.** Para demostrar el flujo completo active
> *Configuración → Cumplimiento → Modo demostración*. En modo producción el sistema
> bloquea préstamos cuya tasa efectiva anual supere la tasa de usura registrada;
> ver [docs/CUMPLIMIENTO.md](docs/CUMPLIMIENTO.md).

## Tecnología

Next.js 16 (App Router, TypeScript) · Tailwind CSS 4 · PostgreSQL (SQL puro con RLS,
sin servicios externos) · autenticación propia (scrypt + sesiones) · React Hook Form + Zod · Recharts · Web Push (VAPID) · ExcelJS ·
Vitest + PGlite.

## Funcionalidad por rol

| Rol | Puede |
|---|---|
| **Administrador** | Tablero de capital/cartera/ganancias con gráficos y filtros; clientes; usuarios e invitaciones; solicitudes (aprobar, rechazar, pedir información, contraoferta); préstamos presenciales; desembolsos; verificación de pagos QR; reversos; capital, gastos y ajustes; comisiones de cobradores; liquidaciones trimestrales; reportes (día/semana/mes/trimestre/rango, Excel); configuración (cumplimiento, política versionada, medios de pago, socios); auditoría. |
| **Cobrador** | Agenda de hoy y próximos 7 días, clientes asignados, ficha con calendario, registro de pagos (parciales incluidos) con comprobante, solicitud de corrección, informe diario descargable, comisiones, entrega de efectivo. |
| **Socio** | Capital, participación, préstamos activos, capital recuperado, intereses, ganancias estimadas/distribuidas/pagadas y liquidaciones (solo lectura). |
| **Cliente** | Préstamos, cuotas y vencimientos, pagos y comprobantes, saldo, **simulador** con comparación de modalidades e informe imprimible, solicitud de préstamo, respuesta a contraofertas, pago por QR con comprobante, notificaciones. |

## Comandos

```bash
npm install
npm run dev           # desarrollo
npm test              # pruebas (no requieren servidor de base de datos)
npm run typecheck
npm run build && npm start
npm run db:local      # PostgreSQL local sin Docker (o: docker compose up)
npm run db:migrate    # aplica migraciones
npm run db:seed       # usuarios y datos de demostración (contraseña Demo2026!)
npm run bootstrap:admin -- correo@empresa.co "Nombre"   # primer administrador real
npm run vapid         # claves para notificaciones push
npm run icons         # regenera iconos PWA
```

## Pruebas

`npm test` ejecuta 46 pruebas reales:

- `tests/finance/rules.test.ts` — reglas de cálculo puras.
- `tests/db/*.test.ts` — ejecutan **las migraciones reales** en PostgreSQL (PGlite)
  con un usuario propietario no superusuario y FORCE RLS, igual que en producción.

| # | Requisito | Prueba |
|---|---|---|
| 1–4 | $600.000 → $120.000 interés, $720.000 total, 4×$180.000, 5×$144.000 | `rules.test.ts` |
| 5–6 | Semanal y quincenal para $600.000; solo semanal < $500.000 | `rules.test.ts`, paridad SQL/TS en `loans-payments.test.ts` |
| 7 | Simulación sin deuda ni reserva de capital | `loans-payments.test.ts` |
| 8 | Solicitud pendiente de aprobación (y contraoferta) | `loans-payments.test.ts` |
| 9–10 | $120.000 → $30.000 cobrador + $90.000 socios → $45.000 c/u | `rules.test.ts` |
| 11–12 | Pago parcial; pago completo y saldo | ambos archivos |
| 13 | Pago duplicado (idempotencia) | `loans-payments.test.ts` |
| 14 | Cliente sin acceso a datos de otro | `loans-payments.test.ts` |
| 15 | Cobrador no puede alterar capital, contratos ni comisiones | `loans-payments.test.ts` |
| 16 | Liquidación trimestral completa | `settlement.test.ts`, `rules.test.ts` |
| 17 | Reverso autorizado | `loans-payments.test.ts` |
| 18 | Conciliación QR y pasarela | `loans-payments.test.ts` |
| 19 | Capital disponible | `capital-collectors.test.ts`, `rules.test.ts` |
| 20 | Auditoría de movimientos y configuración | `loans-payments.test.ts` |

## Documentación

- [docs/DESPLIEGUE.md](docs/DESPLIEGUE.md) — local (Docker o sin Docker), usuarios de demo, Heroku, cron, push, pasarela, instalación en Android/iPhone.
- [docs/ARQUITECTURA.md](docs/ARQUITECTURA.md) — modelo de datos, reglas financieras, políticas de pagos, contabilidad.
- [docs/SEGURIDAD.md](docs/SEGURIDAD.md) — controles, copias de seguridad y restauración.
- [docs/CUMPLIMIENTO.md](docs/CUMPLIMIENTO.md) — normativa colombiana y lista previa a producción.
