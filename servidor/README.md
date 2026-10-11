# Worker compuesto para verificación local

`worker.ts` conecta las bibliotecas reales de sesiones, progreso, SQL y entrada HTML.
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

En T7 aplicar manualmente SQL 001–004 sobre DB dedicada autorizada y crear la raíz
inicial del viaje: columna `estado_json` TEXT con `serializarProgreso(crearProgreso(itinerario))`
y `revision_servidor` 0. **No** guardar el sobre API `{revisionServidor, estado}` en esa columna.
Nunca reiniciar o sembrar estado desde requests. Validar transporte Neon, locks,
concurrencia, persistencia y presupuesto CPU/runtime de reconstrucción por solicitud;
no hay promesa de rendimiento. PGlite de una conexión no prueba estos aspectos.

T4 sigue pendiente: el SW actual cachea GET públicos y `guardarApp` usa `cache.add`;
una entrada HTML redirigida puede envenenar el shell. `no-store` no excluye CacheStorage.
Verificar exclusiones privadas, SW activo y migración de origen relativo, después T8
con dispositivos físicos. No cambiar ni retirar Pages antes de esa validación.

## Verificación y reversión

Con Node 22.22.2 y dependencias existentes:

- `npm test -- pruebas/servidor/worker.test.ts`: arnés del export Worker real, Web API,
  controladores/fábricas y SDK Neon real con `fetch` local simulado. No hace red ni SQL real.
- `npm run check`: los cuatro controles TypeScript existentes.
- `npm test`: regresión completa, incluidos SQL/PGlite preexistentes en memoria.
- `npm run test:e2e`: regresión de entrada/app, no runtime Cloudflare ni SW/offline;
  requiere autorización de sus salidas compiladas y resultados fuera de estos cuatro archivos.

Revisión: empezar por el gate y el borde de red en `worker.ts`, después pruebas y config.
Reversión antes de desplegar: retirar exclusivamente `worker.ts`, este README,
`../pruebas/servidor/worker.test.ts` y `../wrangler.jsonc`; no hay datos reales que migrar.
Con despliegue/datos futuros, esa reversión deja de ser una garantía operativa.
