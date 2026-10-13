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
La biblioteca cliente manual E3 está escrita pero su verificación completa sigue pendiente.
No está conectada a la interfaz publicada. La interfaz y la recuperación R siguen pendientes.

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

## Cliente manual E3 · biblioteca sin conexión a la interfaz

`src/fotos-listado.ts` exporta `crearClienteListadoFotos(opciones)`. No agrega botones,
arranque automático, respaldo en segundo plano ni integración en `main.ts`. Pages sigue
estático y publicado; esta biblioteca no autoriza despliegue ni cierra T6.

### Acción explícita y resultado

1. Construir con `{ plan, origen, presupuesto, http? }`: cero red, lectura de cuerpos,
   timers, IDs, crypto, IndexedDB o colas. Opciones/puerto/presupuesto son datos propios
   exactos, sin accessors, símbolos ni campos extra. Captura métodos y receiver una vez.
2. Pedir `listar(null)` para una primera página. Cada acción admitida con HTTP disponible
   inicia exactamente una GET a `/api/fotos/listado`, sin descargar originales ni seguir
   la continuación. Cursor inválido, instancia ocupada/cerrada o HTTP ausente no inician GET.
3. Entregar el string RAW de `pagina.continuacion` a otra llamada manual si se desea.
   El cursor es posición, no permiso ni snapshot exhaustivo. IDs menores incorporados
   después pueden requerir reiniciar manualmente desde null; no hay acumulación automática.

La instancia congelada `ListadoFotos` ofrece `listar(continuacion)`, `cancelar()` y
`cerrar()`. `ResultadoListadoFotosCliente` discrimina:

| Resultado | Campos |
| --- | --- |
| `pagina` | `pagina: PaginaListadoFotos`, congelada junto con `solicitudesIniciales`. |
| `fallida` | `motivo`: `sin-sesion`, `argumentos-invalidos`, `consulta-rechazada`, `infraestructura`, `respuesta-inesperada`, `formato-invalido`, `presupuesto-excedido` u `ocupada`. |
| `detenida` | `motivo`: `cancelada`, `plazo` o `cerrada`. |

No devuelve cookies, cuerpos de errores del proveedor, SQL, stacks ni metadata reflejada
como motivo. La fábrica inválida usa un mensaje español neutral fijo. `http` omitido
captura el fetch nativo y su receiver; `http: null` impide fallback y la acción falla por
infraestructura. `{ http: { fetch } }` es un puerto explícito confiable de pruebas; sólo
ese puerto admite una Response sintética nativa de URL vacía. No usarlo como autoridad
remota ni aceptar un origen procedente del cursor o de una página.

El origen debe ser HTTPS exacto y, en navegador, `location.origin`, sin credenciales,
ruta añadida, barra final, query ni hash. Cada GET usa `credentials/mode: same-origin`,
`cache: no-store`, `redirect: error`, `Accept: application/json` y señal propia. No hay
CORS, URL pública/prefirmada, fallback de assets/login/cache ni nueva navegación.
El servidor vuelve a autenticar cada página; el cliente no deriva autorización del cursor.

Antes de leer payload exige Response de marca nativa, URL esperada, sin redirección ni
respuesta opaque/error, estado 200 y JSON UTF-8 privado con no-store, Vary Cookie,
Pragma no-cache y nosniff. Los strings de headers seleccionados se limitan a 256 antes
de split/regex/parse. Content-Length sólo es una pista acotada: no asigna capacidad,
no demuestra EOF, longitud decodificada/comprimida ni facturación. Estados 401/400/503
producen motivos tipados; otros estados no se interpretan como página. Los intrínsecos
evitan getters propios falsos de Response/Headers/streams/typed arrays, no constituyen
un sandbox frente a Proxy o un realm modificado por código privilegiado.

El lector propio copia inmediatamente cada Uint8Array a un único buffer P fijo, después
del gate HTTP. Admite Buffer nativo; rechaza backing SharedArrayBuffer o detached.
Cuenta lecturas vacías y EOF, exige EOF completo antes de parsear, usa UTF-8 fatal y
conserva BOM para que el scanner lo rechace. Reutiliza el codec E1 sin relajar esquema;
INITIAL, UUID case-sensitive, NFD/NUL, MIME raro, surrogates JSON escapados y -0 no se
normalizan. Con cursor de entrada, **todas** las filas deben estar en `(despuesDe,hasta]`,
incluso si la página termina con null; una nueva continuación conserva hasta.

### Admisión lógica del cliente

Los ocho campos de `PresupuestoListadoFotosCliente` son obligatorios, sin defaults,
reducción silenciosa de N ni asignaciones derivadas de un máximo arbitrario:

| Campo | Dominio |
| --- | --- |
| `maxFilas` (N) | Entero seguro 1–8. |
| `maxBytesPagina` | Entero seguro positivo, al menos P; el buffer efectivo sigue siendo P. |
| `maxBytesChunk` | Entero 1–4.194.304, no mayor que el límite de backing. |
| `maxBytesBackingChunk` (C) | Entero 1–4.194.304; cobra el backing completo, no sólo la vista. |
| `maxLecturas` | Entero 1–65.536, incluidos chunks vacíos y EOF. |
| `maxBytesPlan` | Entero 1–4.194.304, al menos D real medido antes del copier. |
| `maxBytesRetenidos` | Entero seguro positivo, al menos R. |
| `plazoMs` | Entero 1–2.147.483.647. |

Con M = 65.536, q(x) = 6x + 2:

**P(N) = 4096 + q(128) + q(1024) + N(q(M)+1)**

P1 = 404.231 y P8 = 3.156.764 bytes. La retención cliente adoptada es:

**R = 16P + 32NM + C + (8N+16)D + 1.048.576**

| Reserva | Representaciones/referencias propias contempladas |
| --- | --- |
| `16P` | Buffer fijo, decode/encode, scanner, parse, render canónico, cursor/página y DTO congelado. |
| `32NM` | INITIAL RAW y sus validaciones, renders y referencias acotadas por fila. |
| `C` | Un backing upstream actual completo; no array creciente, clone ni tee. |
| `(8N+16)D` | Plan capturado y copias de codecs/cursor/página, validaciones de rango y arrays de búsquedas de destinos por fila; sin sharing gratuito. |
| `1 MiB` | Referencias acotadas de headers, solicitud, reloj, acción y ownership. |

`medirPlan` precede a `copiarPlanFotos` y a la admisión del presupuesto/origen/HTTP/reloj.
D tiene hard cap independiente 4 MiB, profundidad 32 y 16.384 nodos; array length se
limita a 16.384 antes de recorrer sus descriptores. Por aparición cobra contenedor 256,
cada propiedad propia 256 + 4×longitud UTF-16 de la clave, y escalar 16 más 4×longitud
UTF-16 si es string. `length` de array cuenta como propiedad y escalar. Aliases se cobran
por cada camino, no se deduplican; ciclos activos se rechazan. Sólo admite registros
plain/null o Array exactos y descriptores de datos, no funciones, símbolos ni getters.
No serializa el plan con JSON.stringify ni normaliza strings o -0. Sumas y productos
se comprueban como enteros seguros; R usa D **real**, no maxBytesPlan como multiplicador.

N8/D4MiB/C4MiB exige R = 408.072.640. Los 512 MiB del fixture son permiso lógico de
admisión, **no asignación, medición de RAM ni default para móviles/proveedores**. No se
midió aquí D del itinerario actual. El modelo no acredita heap global, todas las
asignaciones nativas de reflexión sobre datos enormes, GC, prefetch/SDK, CPU,
concurrencia entre instancias ni coste. Tampoco certifica aptitud Cloudflare: la cota
HTTP E2 N8 ya supera 128 MiB y es distinta de la reserva cliente.

### Recursos propios, no estado local

Sólo una acción activa por instancia; la segunda devuelve ocupada sin cola, fetch ni
Promise compartida. Plazo empieza con la llamada manual e incluye cursor, Request,
fetch, lecturas, decode/codec, rango y comprobación síncrona final. Captura performance.now
con receiver; Date.now es fallback si no está disponible. Reloj no finito/recedente
falla cerrado; no hay hook público de tiempo. El timer existe sólo durante la acción,
no puede interrumpir trabajo síncrono ni prometer cancelación física de HTTP/SQL.

Cancelar/plazo entregan resultado lógico inmediato; mantienen busy mientras quedan
fetch/read/cancel propios sin asentarse, aunque un puerto ignore abort. No permiten
reentrada ilimitada sobre trabajo colgado. Una entrega tardía sólo cancela body propio
libre/no usado de URL esperada; nunca body ajeno ya usado/bloqueado ni el puerto HTTP.
Cleanup es idempotente y la liberación del reader espera el asentamiento de read.
`cancelar()` sin acción no hace nada; `cerrar()` es permanente, no resetea cuotas ni
cierra almacenes ajenos. No hay promesa de liberación física inmediata por GC.

Leer una página sólo descubre metadata: no guarda placeholders, PhotoDB, ledger,
progreso, SENT/NEG, recibos o historia importada. Descargar exige otra selección y
acción explícita con el existente `crearDescargaFotos`; no requiere metadata local previa,
pero sólo guarda original y metadata juntos tras GET/atestación. Nunca convierte el
listado, guardado local o recibo importado en ACK fresco de respaldo. Un MIME RAW que
Blob no represente no se normaliza para forzar ese guardado.

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
- `npm test -- pruebas/fotos-listado.test.ts pruebas/servidor/worker-fotos.test.ts`:
  cliente manual, guards y Worker/SDK/PGlite con estado local no vacío. El padre observó
  el RED inicial del comportamiento; la validación completa de E3 sigue pendiente.
- `npm run check`: los cuatro controles TypeScript existentes. El control estricto adicional
  E3 debe incluir cliente, pruebas unitarias/nativas e integración Worker.
- `npm test`: regresión completa, incluidos SQL/PGlite preexistentes en memoria.
- `npm run test:e2e`: regresión de entrada/app, no runtime Cloudflare ni SW/offline;
  requiere autorización de sus salidas compiladas y resultados fuera de las superficies fuente.

`pruebas/fotos-listado.e2e.ts` declara siete casos nativos adicionales: página y continuación
manual, 401 sin navegación, redirect sin destino, cuerpo inválido/truncado/excesivo,
aborto/plazo sin retry, conservación local no vacía y original en segunda acción.
Usa fetch por defecto/cookie HMAC HttpOnly Secure Lax reales sobre TLS loopback,
Worker/router/SDK reales y SQL001–006 en PGlite; R2 y CF-IP son modelados. Compara seis
tablas y objetos antes del ROLLBACK exterior: no certifica COMMIT ni multiconexión.
PhotoDB/ledger/progreso/historia/legado/cache se siembran sólo en el contexto efímero;
SENT y recibos archivados siguen siendo historia, no autoridad activa. Estos casos están
escritos, no se declara aquí que hayan pasado. El navegador filtra Set-Cookie; su ausencia
en LIST se comprueba en el Response servidor del fixture, no sólo en Headers de JS.

Ejecución y artefactos son del proceso padre: el fixture crea su propio directorio
`itinerario-listado-tls-*` con mkdtemp, genera `clave-fixture.pem` y `certificado-fixture.pem`
mediante openssl, compila módulos con Vite write:false en memoria, abre puerto TLS 0 y
restaura fetch/cierra servidor y DB/limpia sólo ese directorio propio. No lee claves de
usuarios ni contacta Neon: el transporte SDK admite exclusivamente consultas locales
parametrizadas de su allowlist. El runner existente puede generar dist y resultados;
no se ejecuta desde el escritor limitado a fuentes. Sin SW activo, validación física de
móviles, AA, cookies entre sitios ni despliegue productivo.

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
anterior. No DROP, reverse SQL, delete, GC, reset ni adopción. La validación E3,
su futura interfaz, R y T7–9 siguen pendientes; esta unidad no cierra T6 ni habilita respaldo automático.

Revisión E3: `src/fotos-listado.ts` → protocolo/copy/guards existentes (sólo lectura)
→ unitarias → integración Worker → fixture nativo → cotas/documentación.
Reversión **sólo de código E3**: retirar biblioteca y sus pruebas/docs dentro de sus cinco
superficies; no retirar E1/E2 ni modificar UI/SW. Conservar SQL005/006, filas, reservas,
operaciones, recibos, objetos R2, sesiones, raíces, decisiones, progreso, PhotoDB, ledger,
SENT/NEG, importaciones, auditoría/historia, legado, cachés, viajes ajenos y huérfanos previos.
No DROP/delete/wipe/reset/GC, limpieza de objetos, adopción, lease/hash witness ni UUID nuevo
para escapar de una reserva incierta. Reserva vacía sigue dando 503 sin PUT ni retry garantizado.
