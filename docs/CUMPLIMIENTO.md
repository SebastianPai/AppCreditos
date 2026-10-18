# Cumplimiento normativo (Colombia) — leer antes de operar con dinero real

> Este documento no es asesoría legal. Resume los controles que implementa el
> sistema y los puntos que un abogado colombiano debe revisar **antes** de
> procesar préstamos reales.

## 1. Alerta crítica: tasa de interés y usura

La regla de negocio solicitada (20 % único sobre el capital, pagado en 1 a 5
cuotas semanales o quincenales) equivale a estas **tasas efectivas anuales (EA)**,
calculadas por el propio sistema (TIR diaria, base 365):

| Préstamo de $600.000 | Última cuota | Tasa EA equivalente |
|---|---|---:|
| 4 cuotas semanales de $180.000 | día 28 | ≈ 4.716 % |
| 5 cuotas semanales de $144.000 | día 35 | ≈ 2.443 % |
| 4 cuotas quincenales de $180.000 | día 60 | ≈ 510 % |
| 5 cuotas quincenales de $144.000 | día 75 | ≈ 353 % |

En Colombia la Superintendencia Financiera certifica periódicamente el interés
bancario corriente, y la **tasa de usura** es 1,5 veces ese valor (art. 884 del
Código de Comercio). Cobrar intereses por encima de la tasa de usura:

- es el **delito de usura** (art. 305 del Código Penal);
- implica la pérdida de los intereses cobrados en exceso (art. 884 C. Co.;
  art. 72 de la Ley 45 de 1990).

Las condiciones descritas superan la tasa de usura vigente por un margen muy
amplio. **El sistema no permite aprobar ni desembolsar un préstamo cuya tasa EA
supere la tasa de usura registrada.**

### Cómo funciona el control (`_assert_compliance`)

Se ejecuta en la base de datos al **aprobar** y al **desembolsar**:

1. Debe existir revisión legal marcada como completada, con su referencia.
2. Debe existir una tasa de usura EA registrada con vigencia que incluya la fecha actual.
3. La tasa EA del préstamo (calculada sobre su calendario real) debe ser ≤ tasa de usura.

Si falla cualquiera, la operación se rechaza con `COMPLIANCE_BLOCKED`.

**Modo demostración:** en *Configuración → Cumplimiento* el administrador puede
cambiar el modo a *Demostración* (para portafolio o pruebas, sin dinero real). En
ese modo el control no bloquea, el tablero muestra un aviso permanente y el cambio
queda auditado. Vuelva a *Producción* antes de cualquier uso real. Los
cambios de esta configuración quedan en la auditoría (usuario, fecha, valor
anterior y nuevo). Registrar una tasa distinta de la certificada es
responsabilidad de quien la registra y queda trazado.

El simulador **sí** funciona sin esta configuración (no crea obligaciones) y
muestra al cliente la tasa EA equivalente, como exige el deber de información.

### Opciones que el negocio debe evaluar con su abogado

- Plazos más largos para el mismo 20 % (con 20 % total, la EA baja a niveles
  cercanos a la usura solo con plazos del orden de 10–12 meses o más, que exceden
  el máximo de 5 cuotas configurado).
- Un porcentaje menor. La política es versionada (Configuración → Política) y
  cada versión aplica solo a préstamos futuros.
- Cualquier cargo adicional (estudio, seguros, administración) se computa dentro
  del interés para efectos de usura.

## 2. Otras normas a revisar

| Tema | Referencia | Estado en el sistema |
|---|---|---|
| Captación masiva de dinero del público | Decreto 4334 de 2008; art. 316 C. Penal | El sistema solo presta capital propio de los socios; no capta depósitos. Confirmar la estructura societaria. |
| Habitualidad en préstamos / registro | Revisar con abogado y contador (eventual necesidad de forma societaria, RUT, facturación) | Pendiente legal. |
| Protección de datos personales | Ley 1581 de 2012, Decreto 1377 de 2013 (compilado en el 1074 de 2015) | Se exige y registra la autorización (`data_consent_at`) al crear cada cliente; documentos y teléfonos enmascarados en auditoría, notificaciones y comprobantes. Falta: política de tratamiento publicada, aviso de privacidad, procedimiento de consultas/reclamos y, si aplica, registro en el RNBD. |
| Habeas data financiero / reportes a centrales | Ley 1266 de 2008 y Ley 2157 de 2021 | El sistema **no** reporta a centrales. Si se hace, requiere autorización previa y comunicación previa de 20 días. |
| Cobranza | Ley 1480 de 2011 (Estatuto del Consumidor), Ley 2300 de 2023 («dejen de fregar») | Las notificaciones no muestran montos en la pantalla bloqueada. Definir horarios y canales de contacto permitidos; capacitar a los cobradores; prohibir cualquier forma de cobro intimidatorio. |
| Prepago | Ley 1555 de 2012 | Se aceptan pagos anticipados sin penalidad. Revisar si el interés debe reducirse proporcionalmente al prepagar (el sistema no lo hace automáticamente; puede aplicarse un ajuste autorizado). |
| Contrato y pagaré | Código de Comercio, Ley 527 de 1999 (firma electrónica) | El sistema genera la tabla de amortización y el informe de simulación; el contrato y el pagaré deben redactarse y firmarse fuera del sistema. |
| Prevención de lavado de activos | Revisar aplicabilidad (SAGRILAFT/SARLAFT según la forma societaria) | Pendiente. |
| Intereses de mora | Art. 884 C. Co. (también limitados por la usura) | **No se cobran**: no existe una regla autorizada. Añadirla requiere definición legal. |

## 3. Lista de verificación previa a producción

- [ ] Concepto legal escrito sobre tasa, plazos, contrato, pagaré y cobranza.
- [ ] Tasa de usura vigente registrada (y procedimiento mensual para actualizarla).
- [ ] Política de tratamiento de datos y aviso de privacidad publicados.
- [ ] Formato de autorización de datos firmado por cada cliente.
- [ ] Protocolo de cobranza respetuosa firmado por cada cobrador.
- [ ] Revisión contable/tributaria de la distribución de utilidades entre socios.
- [ ] Prueba de restauración de copia de seguridad realizada (ver SEGURIDAD.md).
