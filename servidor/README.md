# Worker compuesto para verificación local

`worker.ts` conecta las bibliotecas reales de sesiones, progreso, SQL, fotos privadas y entrada HTML.
Es una composición usable mediante Web API, **no un despliegue validado ni lista para producción**.
Pages permanece publicado hasta completar T4, T7, T8 y la migración T9.

## Frontera de ejecución

Cada `fetch(Request, entorno)` reconstruye las fábricas sin caché de composición, sesiones,
usuarios, instantáneas, límites en memoria ni configuración retenida. Usa el ID de
`src/datos/itinerario.ts`, sin duplicarlo en el navegador o entorno. Importar el módulo
no inicializa credenciales, genera aleatoriedad ni ejecuta SQL. No hay bootstrap ni seed.

El ejecutor Neon alimenta el repositorio de sesiones y la pasarela de progreso;
los controladores reales alimentan el router y `proveerRespuestaEntrada` real.
El wrapper propio de `ASSETS.fetch` conserva el receiver del binding nativo.
HTTP falla con 400 antes de leer bindings; configuración fallida responde 503 privado,
sin reflejar secretos ni servir HTML/assets como fallback. Origin, cuerpo, señal y cookie
permanecen en el Request original. Los assets requieren sesión vigente comprobada en DB.

| Binding privado | Contrato |
| --- | --- |
| `CLAVE_COMPARTIDA` | Clave exacta y material HMAC del contrato existente de credenciales; sin segunda clave MAC. Generar fuera del repositorio con CSPRNG en T7. |
| `URL_BASE_DATOS` | DSN privado validado por el ejecutor Neon. Nunca `VITE_*`, código cliente ni logs. |
| `ASSETS` | Binding de infraestructura, no secreto; método `fetch` obligatorio. |
| `FOTOS_ORIGEN?` | Origen HTTPS exacto confiable, sin ruta, barra final, credenciales, query ni fragmento. |
| `FOTOS_PRESUPUESTO?` | Objeto estructurado con los ocho campos obligatorios de admisión (tabla siguiente); no cadena JSON ni valores cliente. |
| `FOTOS_BUCKET?` | Vínculo estructural privado con `get`/`put`, incluidos métodos prototípicos ligados a su receiver. No recurso provisionado. |

### Activación aislada de fotos por solicitud

Los tres campos opcionales deben estar presentes y válidos para atender únicamente
`/api/fotos/respaldo` y `/api/fotos/<un segmento codificado>/original`. Se inspeccionan
sus descriptores propios de datos, sin ejecutar getters, y se capturan plan, presupuesto,
origen y métodos R2 **antes** del primer await de credenciales. Después se enlaza el
método de autenticación del controlador real de sesiones; no hay segundo MAC ni gate
adicional en el router. Cada Request conserva identidad/cuerpo/señal/cookie y cada
respuesta A conserva bytes, estado y cabeceras. No hay listado ni API de recuperación.

Configuración de fotos ausente, parcial o inválida: 503 privado sin leer cuerpo,
consultar SQL de fotos ni acceder a R2; sesiones/progreso/entrada/assets siguen disponibles.
Otras rutas no inspeccionan esos campos. Errores privados no caen en assets, HTML,
login ni copia offline; `Cache-Control: private, no-store`, `Vary: Cookie` y `nosniff`
son obligatorios; errores del router/configuración también llevan `Pragma: no-cache`.
POST exige Origin exacto; no se aceptan presupuestos por cabeceras, query o formulario.

| Campo de presupuesto | Dominio |
| --- | --- |
| `maxBytesOriginal`, `maxBytesEntrada`, `maxBytesChunk`, `maxBytesCabeceras`, `maxBytesRetenidos`, `maxBloquesOriginal` | Enteros seguros ≥0; cero no significa ilimitado. |
| `bytesBloque` | Entero entre 1 y 1.048.576. |
| `plazoMs` | Entero entre 1 y 2.147.483.647. |

No hay defaults ni recomendación productiva basada en el presupuesto de pruebas.
La admisión cobra buffers/encuadre y rechaza desbordamientos; no acredita heap global,
GC, prefetched chunks del proveedor ni coste. El timeout no deshace trabajo externo iniciado.

Un INSERT ganador confirmado permite un único PUT condicional; después se verifica
el objeto completo (encuadre, cuerpo canónico inicial, bytes y EOF), se autentica de
nuevo y se finaliza SQL antes del acuse exacto. SQL no mantiene locks durante R2;
no hay atomicidad física entre proveedores. Reintentos compatibles conservan el cuerpo
inicial y reciben su propio recibo, sin segundo PUT. Reserva con objeto ausente: 503,
sin ACK, adopción, takeover ni retry garantizado; se conservan reservas/objetos inciertos.

## Identidad de red: hipótesis pendiente de T7

Solo el POST de login lee `CF-Connecting-IP`, bajo la hipótesis explícita de un Worker
como entrada directa Cloudflare `workers.dev`. T7 debe verificar que Cloudflare sobrescribe
esa cabecera, el acceso directo y la ausencia de proxies no confiables o Workers de la
misma zona que puedan reenviar identidad modificando `x-real-ip`. **No habilitar esta
composición en otra topología sin resolver esa autoridad.** Las pruebas con cabeceras
falsas demuestran únicamente la forma del adaptador, no confianza real de infraestructura.

Se aceptan literales IPv4 decimales de cuatro octetos (sin ceros iniciales) e IPv6 de
ocho grupos, compresión `::` única y cola IPv4 válida. Se rechazan puertos, listas,
corchetes, zonas, grupos extra y valores incompletos. Se conserva exactamente la cadena
que entrega `Headers.get`, sin normalización adicional. No se consulta `Forwarded`,
`X-Forwarded-For`, cuerpo, query ni ExecutionContext; dispositivo no autoriza.
IP ausente/inválida deja contexto indefinido: login válido falla 503, sin límite global
alternativo. Las rutas anónimas/API conservan sus respuestas existentes.

## Configuración estructural y preparación

`../wrangler.jsonc` fija `main`, `compatibility_date: 2026-10-11` y assets `./dist` con
binding `ASSETS` y `run_worker_first: true` para impedir asset-first antes del gate.
La fecha es un pin local, no prueba del runtime. No incluye nombre, cuenta, rutas,
dominios ni secretos; falta seleccionar recursos/cuenta/nombre y configurar secretos
con autorización T7. No se instaló ni ejecutó Wrangler, ni se crearon recursos.

T7 aún requiere validar SQL 001–005 sobre una DB dedicada autorizada y preparar la raíz
inicial del viaje: columna `estado_json` TEXT con `serializarProgreso(crearProgreso(itinerario))`
y `revision_servidor` 0. **No** guardar el sobre API `{revisionServidor, estado}` en esa columna.
Nunca reiniciar o sembrar estado desde requests. Validar transporte Neon, locks,
concurrencia, persistencia y presupuesto CPU/runtime de reconstrucción por solicitud;
no hay promesa de rendimiento. PGlite de una conexión no prueba estos aspectos.

El SW actual prepara explícitamente el núcleo y publica raíz/dependencias juntas,
sin sustituir una generación preparada anterior si falla. Excluye API, entrada y fotos
privadas; sólo usa la copia ante fallo de red, no ante denegación/redirección/error online.
`no-store` por sí solo no excluye CacheStorage ni borra copias al revocar. Falta validar
SW activo/migración de origen en infraestructura real y T8 con dispositivos físicos.
No cambiar ni retirar Pages antes de esa validación.

## Verificación y reversión

Con Node 22.22.2 y dependencias existentes:

- `npm test -- pruebas/servidor/worker.test.ts`: arnés del export Worker real, Web API,
  controladores/fábricas y SDK Neon real con `fetch` local simulado. No hace red ni SQL real.
- `npm test -- pruebas/servidor/worker-fotos.test.ts`: Worker/router/A/B/C y SDK reales,
  SQL001–005 ejecutado en PGlite propio en memoria; transporte Neon sustituido totalmente
  por fetch local de consultas parametrizadas admitidas explícitamente y R2 condicional modelado.
  Login/HMAC reales y cookie reenviada en Node; no acredita SameSite nativo, confianza CF-IP,
  TLS/COMMIT remoto, concurrencia multiconexión ni durabilidad Cloudflare/Neon.
- `npm run check`: los cuatro controles TypeScript existentes.
- `npm test`: regresión completa, incluidos SQL/PGlite preexistentes en memoria.
- `npm run test:e2e`: regresión de entrada/app, no runtime Cloudflare ni SW/offline;
  requiere autorización de sus salidas compiladas y resultados fuera de estos cuatro archivos.

La regresión nativa `api-fotos.e2e.ts` usa TLS/Origin locales reales para A, no certifica
cookies ni despliegue de esta composición Worker. Referencias de contrato, no pruebas
productivas: [Workers R2](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/),
[límites R2](https://developers.cloudflare.com/r2/platform/limits/),
[SDK Neon](https://neon.com/docs/serverless/serverless-driver) y
[PGlite](https://pglite.dev/docs/). Sin bindings R2 reales ni recursos creados.

Revisión D: `composicion-fotos.ts` → `worker.ts` → `router.ts` → pruebas locales.
Reversión **sólo de código D**: retirar composición/integración de fotos y sus pruebas/docs
(nueve superficies de D), dejando fotos no disponibles en el Worker. Mantener íntegros
A/B/C, SQL005, filas, reservas, operaciones, recibos, objetos, PhotoDB, progreso, sesiones,
raíz, historia, ledger, legado y cachés. No revertir migraciones, borrar objetos/datos,
limpiar huérfanos ni intentar deshacer promesas ya iniciadas. Listado/recuperación/UI y
T7–9 siguen pendientes; esta unidad no cierra T6 ni habilita respaldo automático.
