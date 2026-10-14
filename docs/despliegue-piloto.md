# Preparar el piloto privado de Fold 7

El generador local entrega un perfil no secreto validado con el itinerario real y una configuración del Worker existente. **No construye ni despliega la app.** La cuenta debe confirmarse por separado; un ID válido sintácticamente no acredita identidad, acceso ni permisos.

## Preparación local

Con Node 22.22.2 y las dependencias locales instaladas, desde el repositorio:

```sh
node scripts/preparar-despliegue-piloto.mjs <account-id-real-32hex> <carpeta-absoluta-externa-nueva>
```

El padre debe existir y ser canónico, sin enlaces. La salida no puede existir ni contener el repositorio. Se reserva con `mkdir` exclusivo: no se adopta, sobrescribe ni borra una salida anterior. Si algo falla después, la carpeta nueva puede quedar parcial; detenerse y revisarla, sin reintento automático.

| Salida | Uso |
| --- | --- |
| `perfil.json` | Entrada del build privado existente, con respaldo, catálogo e importación/exportación activos. |
| `wrangler.privado.json` | Cuenta explícita, Worker `itinerario-piloto`, R2 `itinerario-piloto-fotos` y vars JSON estructuradas. |
| `web/` | **Todavía no existe**; la reservará el build privado. Solo esta carpeta va a ASSETS. |

El origen único es `https://itinerario-piloto.tumanag3r.workers.dev`. La entrada de servidor es la ruta absoluta de `servidor/worker.ts`, no un placeholder. Se conserva `compatibility_date: 2026-10-11`; la configuración pública actual no tiene compatibility flags. No se carga esa configuración, `.env`, `.dev.vars` ni credenciales durante la generación.

## Límites iniciales y alcance

Una persona, acciones manuales secuenciales: no una garantía de exclusión entre pestañas, móviles o solicitudes. Original remoto hasta **8 MiB (8388608 bytes)**. Un original mayor se conserva localmente, sin recomprimirlo ni borrarlo por rechazo del respaldo. El perfil no cambia el guardado local: `main.ts` pasa el respaldo por separado y `crearFotosUi` crea su controlador local sin ese tope; `guardarOriginal` escribe el Blob recibido. Esto es inspección de los callsites, **no prueba de almacenamiento físico en Fold 7**. Cuotas y evicción del navegador siguen pendientes.

| Presupuesto lógico | Valor |
| --- | --- |
| Declaración conservadora de cuerpo proveedor | 16 MiB; **no es capacidad certificada del proveedor**. |
| Entrada / chunk / cabeceras de respaldo | 9 MiB / 4 MiB / 16 KiB. |
| Bloques / tamaño / plazo de respaldo | 128 / 64 KiB / 120 s. |
| Retención de respaldo y de cada listado | 64 MiB cada uno, no heap global. |
| Listado servidor | 1 fila, 8 operaciones por foto, SQL 5 MiB, respuesta 512 KiB, 60 s. |
| Listado cliente | 1 fila, página 512 KiB, chunk y backing 4 MiB, 65536 lecturas, plan 1 MiB, 60 s. |
| Portabilidad | 256 registros, metadata 8 MiB, archivo 32 MiB, profundidad 64. |
| Historia total | 16 importaciones, 512 observaciones, 512 procedencias, 16 MiB. |

Las fábricas reales comprueban perfil, plan, catálogo cliente, composición de fotos/R2 y listado SQL/HTTP, transporte, descarga y portabilidad con historia. El preflight no abre bases ni inicia red. A 8 MiB, la admisión multipart cobra 21758464 bytes; el encuadre R2 eleva la retención lógica a **43254284 bytes**, incluso antes de afirmar heap físico: 32 MiB no alcanzan. La historia de 16 MiB puede rechazar un archivo de 32 MiB aunque el formato lo admita; no se omite ni elimina historia para hacerlo caber.

CPU, memoria física/GC, concurrencia, límites de Workers Free, chunks reales de R2, latencia, costes y autenticación no quedan certificados por estos validadores. Si la prueba real excede un límite, detenerse y registrar el caso; no ampliar presupuestos ni reducir originales silenciosamente.

## Receta futura: construir, inspeccionar y recién después publicar

**Estos pasos no se ejecutaron en F3.** Requieren autorización del padre y una cuenta real verificada. Usar rutas absolutas; `SALIDA` es la carpeta generada y `REPO` el repositorio actual.

```sh
npm run build:privado -- "$SALIDA/perfil.json" "$SALIDA/web"
WRANGLER_SEND_METRICS=false CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false \
  node "$REPO/node_modules/wrangler/bin/wrangler.js" deploy \
  --config "$SALIDA/wrangler.privado.json" --dry-run --outdir "$SALIDA/bundle"
```

Wrangler es el instalado localmente, fijado a **4.151.0**. `bundle/` debe ser una salida nueva y externa, nunca reutilizada. El dry-run compila y comprueba sin subir el Worker según su contrato CLI; aquí no hay evidencia de que se haya ejecutado ni de autorización de cuenta. Antes de hacerlo, el operador debe verificar el contexto seguro de autenticación y que no haya archivos de entorno/credenciales incorporados al artefacto.

Inspeccionar el resultado real: identificar el módulo de entrada emitido (y sus módulos auxiliares si los hubiera), comprobar perfil/web/config, cuenta, origen y bindings, y registrar hashes y ruta absoluta. **No se supone el nombre del bundle.** `BUNDLE_VERIFICADO` debe ser la entrada efectiva comprobada, no el TypeScript fuente ni una conjetura.

Antes de publicar, el humano carga directamente `CLAVE_COMPARTIDA` y `URL_BASE_DATOS` **solo de la base nueva** mediante el canal seguro aprobado. Nunca se pasan como argumentos, vars, plantillas, logs ni contenido de estos archivos. No usar cuentas implícitas ni inferir permisos de OAuth o de una prueba sintética.

Solo tras esa verificación y autorización de despliegue:

```sh
WRANGLER_SEND_METRICS=false CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false \
  node "$REPO/node_modules/wrangler/bin/wrangler.js" deploy "$BUNDLE_VERIFICADO" \
  --config "$SALIDA/wrangler.privado.json" --no-bundle
```

No cambia políticas de cuenta, `keep_vars`, opciones de compatibilidad ni recursos ajenos. No publica Pages ni toca `dist/`. El humo remoto, la sesión humana y la prueba de fotos/progreso en el teléfono siguen siendo pasos independientes pendientes.
