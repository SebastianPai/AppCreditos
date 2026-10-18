# Arquitectura y reglas financieras

## Visión general

```
Navegador / PWA (Next.js App Router, React 19, Tailwind 4)
   │  Server Components + Server Actions (validación Zod)
   ▼
Servidor Next.js ── sesión propia (cookie httpOnly + auth.sessions, contraseñas scrypt)
   │  driver pg: una transacción por consulta con request.jwt.claims del usuario
   ▼
PostgreSQL (Heroku Postgres / Docker)
                       ├─ RLS en todas las tablas (lectura)
                       ├─ Funciones SECURITY DEFINER (todas las escrituras financieras)
                       ├─ Triggers de inmutabilidad y auditoría
                       └─ Contabilidad por partida doble
```

**Principio central:** el navegador nunca escribe directamente en tablas
financieras. Cada operación (aprobar, desembolsar, registrar pago, reversar,
liquidar…) es una función de PostgreSQL que verifica el rol con `auth.uid()`,
valida importes y estados, y ejecuta todos los cambios en **una sola
transacción**. La interfaz y las Server Actions también validan, pero la
autoridad final es la base de datos.

## Estructura del proyecto

| Ruta | Contenido |
|---|---|
| `db/migrations/` | Esquema, autenticación, funciones y RLS (fuente de verdad) |
| `scripts/` | Migrador, datos de demostración, primer administrador, PostgreSQL local |
| `src/lib/finance/` | Reglas financieras puras en TypeScript (espejo exacto del SQL) |
| `src/app/admin`, `cobrador`, `socio`, `cliente` | Áreas por rol |
| `src/app/simulador`, `simulaciones/[id]` | Simulador público y su informe |
| `src/app/api/` | Simulación, push, cron, webhook de pasarela, exportación Excel |
| `public/sw.js` | Service worker (sin caché de datos financieros) |
| `tests/finance` | Pruebas unitarias de cálculo |
| `tests/db` | Pruebas de integración contra PostgreSQL real (PGlite) con RLS |

## Modelo de datos (principales)

- `profiles` (rol: admin, collector, partner, customer), `permissions`, `role_permissions`, `user_permissions`
- `customers` (código único, documento único por tipo, cobrador asignado, autorización de datos)
- `loan_policies` (versionadas; cada préstamo guarda copia de sus tasas)
- `loan_simulations` (separadas de los préstamos; anónimas sin datos personales)
- `loan_applications` (pendiente → información solicitada / contraoferta → aceptada → aprobada / rechazada / cancelada)
- `loans`, `loan_installments` (importes contractuales inmutables)
- `payments`, `payment_allocations` (cada abono por cuota, capital e interés), `reversal_requests`
- `payment_methods`, `payment_requests` (QR / transferencia / pasarela)
- `collector_commissions`, `collector_payouts`, `cash_handovers`
- `partners`, `capital_contributions`, `expenses`
- `capital_accounts`, `financial_transactions`, `financial_entries` (partida doble)
- `quarterly_settlements`, `settlement_distributions`
- `notification_preferences`, `notification_subscriptions`
- `audit_logs`, `app_settings`

Importes: `BIGINT` en pesos enteros (COP no usa centavos en esta operación). No
hay redondeos de punto flotante en dinero.

## Reglas del préstamo

- Interés total = capital × 20 % (redondeo half-up a peso), **una sola vez**.
- Total = capital + interés. Cuotas: 1 a 5 (máximo configurable ≤ 5).
- Semanal: cada 7 días. Quincenal: cada 15 días. Quincenal solo si capital ≥ $500.000.
- Calendario determinista: cuotas iguales del total; los pesos residuales van a
  las primeras cuotas. El capital se reparte igual (residuos a las primeras) y el
  interés de cada cuota es la diferencia → todas las sumas cuadran exactamente.
- La aprobación crea el préstamo en estado **aprobado** (capital comprometido).
  Solo el **desembolso** lo activa; las fechas se recalculan desde la fecha de
  desembolso sin cambiar importes.
- Si la administración cambia condiciones, debe enviar una **contraoferta** y el
  cliente aceptarla; la base de datos rechaza aprobar condiciones distintas a las
  aceptadas (`TERMS_MISMATCH`).

## Distribución del interés

- 5 % del capital → comisión del cobrador del préstamo.
- 15 % del capital → bolsa de socios, repartida según participación (50/50 inicial; residuo al socio 1).
- Estados de la ganancia: **calculada** (contractual), **devengada/recaudada**
  (proporcional al interés efectivamente cobrado), **distribuida** (aprobada en
  liquidación) y **pagada**.
- Comisión devengada acumulada = ⌊interés cobrado × comisión total / interés total⌋;
  al pagarse todo el préstamo suma exactamente el 5 %. Los reversos la recalculan.

## Políticas de pagos

| Caso | Política |
|---|---|
| Abono parcial | Se aplica a la cuota más antigua pendiente; dentro de la cuota, capital/interés en proporción acumulada de la cuota. |
| Pago anticipado | El excedente pasa a las siguientes cuotas. El interés contractual no se reduce automáticamente (revisar Ley 1555 de 2012; ver CUMPLIMIENTO.md). |
| Pago mayor al saldo | Rechazado (`AMOUNT_EXCEEDS_BALANCE`). |
| Pago duplicado | Clave de idempotencia única por intento; un reintento devuelve el mismo pago. Misma clave con otros datos → `IDEMPOTENCY_CONFLICT`. |
| Mora | Sin intereses de mora: no hay regla autorizada. La cuota se marca **vencida**. |
| Cobrador | Solo efectivo, con fecha de hoy, en préstamos asignados. El efectivo queda en su custodia hasta que administración confirma la entrega. |
| QR / transferencia | El cliente envía comprobante → **pendiente de verificar**. Solo la confirmación de administración (o un webhook de pasarela con firma, referencia e importe válidos) reduce el saldo. |
| Corrección | Nada se borra. Reverso con motivo: asignaciones negativas, asientos opuestos con fecha de hoy, comisión recalculada. El cobrador puede solicitarlo; administración lo autoriza. |
| Cancelación | Solo préstamos aprobados y no desembolsados. |
| Reestructuración | No automatizada. Procedimiento: (1) registrar pagos recibidos; (2) acordar por escrito con revisión legal; (3) liquidar el saldo con los mecanismos existentes y otorgar un nuevo préstamo dentro de la política vigente. Una función específica debe diseñarse con el abogado. |

## Contabilidad y definiciones de capital

Cuentas: `CASH`, `COLLECTOR_CASH:<cobrador>`, `LOANS_RECEIVABLE`,
`PARTNER_CAPITAL:<socio>`, `PARTNER_ADVANCES:<socio>`,
`PARTNER_PROFIT_PAYABLE:<socio>`, `INTEREST_INCOME`, `COMMISSION_EXPENSE`,
`COMMISSION_PAYABLE:<cobrador>`, `OPERATING_EXPENSES`, `ADJUSTMENTS`,
`RETAINED_RESULT`. Débito positivo, crédito negativo; cada transacción suma 0
(restricción diferida en la base de datos).

| Operación | Asientos |
|---|---|
| Aporte | CASH + / PARTNER_CAPITAL − |
| Desembolso | LOANS_RECEIVABLE + / CASH − |
| Pago (cobrador) | COLLECTOR_CASH + ; LOANS_RECEIVABLE − (capital); INTEREST_INCOME − (interés); COMMISSION_EXPENSE + / COMMISSION_PAYABLE − |
| Entrega del cobrador | CASH + / COLLECTOR_CASH − |
| Gasto | OPERATING_EXPENSES + / CASH − |
| Cierre de liquidación | Cancela ingresos y gastos del periodo contra PARTNER_PROFIT_PAYABLE (y RETAINED_RESULT si hay pérdida) |
| Pago de utilidades | PARTNER_PROFIT_PAYABLE + / CASH − |

**Capital disponible** = caja conciliada − comisiones por pagar − utilidades por
pagar − resultado no liquidado (si es positivo) − capital comprometido. El
efectivo en poder de cobradores no cuenta hasta su entrega. No es la suma de los
préstamos ni incluye ganancias.

## Liquidación trimestral

Borrador → pendiente de aprobación → aprobada → pagada. Distribuible = intereses
cobrados − comisiones − gastos ± ajustes − pérdidas arrastradas. El capital
recuperado se informa aparte y nunca se distribuye. Al aprobar: se guarda el
informe exacto con su huella SHA-256 (inmutable), se generan asientos de cierre,
se descuentan anticipos y el periodo queda **cerrado** (no admite movimientos con
fechas dentro de él).

## Seguridad (resumen)

Ver [SEGURIDAD.md](SEGURIDAD.md).
