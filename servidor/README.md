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
| `FOTOS_LISTADO_PRESUPUESTO?` | Seis campos propios de datos del catálogo (tabla siguiente), sin defaults. Sólo se inspecciona en `/api/fotos/listado`. |

### Activación aislada de fotos por solicitud

Los tres campos opcionales deben estar presentes y válidos para atender únicamente
`/api/fotos/respaldo` y `/api/fotos/<un segmento codificado>/original`. Se inspeccionan
sus descriptores propios de datos, sin ejecutar getters, y se capturan plan, presupuesto,
origen y métodos R2 **antes** del primer await de credenciales. Después se enlaza el
método de autenticación del controlador real de sesiones; no hay segundo MAC ni gate
adicional en el router. Cada Request conserva identidad/cuerpo/señal/cookie y cada
respuesta A conserva bytes, estado y cabeceras. El catálogo de metadatos se activa por separado;
no hay API de recuperación de reservas inciertas.

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

## Catálogo privado de metadatos · preparado sólo localmente

`GET /api/fotos/listado` sirve una página manual de INITIAL confirmados, con su texto
canónico exacto. No descarga originales, miniaturas, URLs, claves R2, reservas ni recibos;
no escribe datos, importa fotos, confirma ledger ni desencadena otras páginas.
El cliente manual E3 y su interfaz siguen pendientes, igual que la recuperación R.

La preparación `prepararListadoFotos` copia el plan antes de inspeccionar presupuesto
o métodos, construye internamente el repositorio E1 real y captura todo antes del await
de credenciales. Después enlaza `sesiones.autenticar` real. La ruta nunca inspecciona
`FOTOS_BUCKET` ni `FOTOS_PRESUPUESTO`, ni construye composición binaria. Una configuración
de catálogo ausente/parcial/inválida sólo deshabilita esa ruta (503 privado), no el respaldo,
las sesiones, el progreso ni los assets. Cada petición recaptura configuración, sin singleton.

| Campo de presupuesto de catálogo | Dominio |
| --- | --- |
| `maxFilas` (N) | Entero seguro 1–8, sin reducción silenciosa. |
| `maxOperacionesPorFoto` (K) | Entero seguro 1–64. |
| `maxBytesSql`, `maxBytesRespuesta`, `maxBytesRetenidos` | Enteros seguros positivos, al menos las cotas derivadas de N/K. |
| `plazoMs` | Entero 1–2.147.483.647. |

Retención exigida HTTP: **R_E1 + 6P + 65.536**. P es la cota efectiva de respuesta,
no un máximo arbitrario configurado. El extra cobra encoder hasta 3P antes del rechazo,
decode 2P, cuerpo Response P y referencias acotadas de query/auth/vigencia. No se parsea
ni recanonicaliza otra página completa: E1 cerrado ya validó el dominio. N1 exige
51.431.476 bytes y N8 243.480.256. Fixtures locales N1 (SQL 5MiB, respuesta 512KiB,
retención 64MiB) y N8 (24MiB, 4MiB, 256MiB) **no son defaults productivos**;
N8 supera 128MiB y no acredita aptitud Cloudflare. Este modelo de referencias propias
no certifica heap físico, GC, prefetch/SDK, scans/CPU, catálogo de fábrica, concurrencia o coste.

Orden del gate: TLS → path exacto → sólo GET (otros 405/Allow GET; HEAD sin cuerpo)
→ origen destino confiable → sesión inicial DB → cursor → una SELECT006 → sesión DB
fresca después de RETURN **y entrega SDK** → misma identidad temporal → ambos vencimientos
y vigencia justo antes de devolver Response. Revocación, caducidad o cambio de cookie
a otra sesión durante la espera niegan la página (401). Infraestructura, corrupción,
aborto y plazo fallidos dan 503 sin detalles. GET no exige Origin de mutación ni ofrece CORS:
la cookie identifica, no un dispositivo dueño de las fotos ni permiso derivado del cursor.

Sin query, se pide la primera página. Sólo se admite `continuacion` literal, una vez,
no vacía y sin parámetros extra, separadores vacíos ni alias escapados. Se acota la query
serializada nativa a 3.086 caracteres antes de decode estricto único y el cursor UTF8
a 1.024 bytes; scanner máximo profundidad 16/256 nodos y forma canónica exacta con
viaje y posiciones UUID case-sensitive. `=` dentro del valor es dato; `&` exige encoding.
Un `?` vacío conservado por Request nativo se rechaza; no se certifican bytes perdidos
por normalización HTTP. El dominio de viaje de 128 bytes sólo permite cursores de hasta
892 bytes: los casos 1.024/1.025 son negativos del guard, no cursores válidos inventados.
Cursor unsigned es posición, no autorización, ACK ni snapshot exhaustivo.

Todas las respuestas llevan JSON UTF8, `private, no-store`, `Vary: Cookie`,
`Pragma: no-cache` y `nosniff`; no emiten cookie, CORS, ETag, Location ni parámetros/error
SQL reflejados. El router conserva los mismos Request y Response, sin doble autenticación.
El plazo HTTP comienza **después** del await de credenciales del Worker. Aborto/timeout
ignora entregas tardías, no cancela SQL físicamente, revierte COMMIT ni garantiza liberar
locks/referencias de puertos pendientes. No hay retries ni fallback de caché, assets o login.

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

T7 aún requiere validar SQL 001–006 sobre una DB dedicada autorizada y preparar la raíz
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
  SQL001–006 ejecutado en PGlite propio en memoria; transporte Neon sustituido totalmente
  por fetch local de consultas parametrizadas admitidas explícitamente y R2 condicional modelado.
  Login/HMAC reales y cookie reenviada en Node; no acredita SameSite nativo, confianza CF-IP,
  TLS/COMMIT remoto, concurrencia multiconexión ni durabilidad Cloudflare/Neon.
- `npm test -- pruebas/servidor/api-listado-fotos.test.ts`: frontera HTTP con E1 real y
  envelopes SQL sintéticos negativos; no sustituye el positivo Worker/SDK/PGlite.
- `npm run check`: los cuatro controles TypeScript existentes. El control estricto adicional
  incluye las tres fuentes E2, sus cuatro pruebas y la regresión nativa A9.
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
limpiar huérfanos ni intentar deshacer promesas ya iniciadas.

Revisión E2: `api-listado-fotos.ts` → Worker/router → pruebas → estas cotas/documentación.
Reversión **sólo de código E2**: retirar la API de catálogo y su integración/pruebas/docs
(diez superficies), conservando E1, SQL005/006, todos los datos/recibos/objetos y el resto
anterior. No DROP, reverse SQL, delete, GC, reset ni adopción. E3/manual/UI, R y T7–9
siguen pendientes; esta unidad no cierra T6 ni habilita respaldo automático.
