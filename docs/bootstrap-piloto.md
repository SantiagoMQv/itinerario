# Preparar la raíz inicial del piloto sin conectar a Neon

El generador produce dos archivos no secretos para una **base nueva dedicada**. No crea recursos, no lee URI PostgreSQL, no conecta, no ejecuta SQL ni prepara la web. La generación local no demuestra que el piloto remoto esté operativo.

## Generar archivos nuevos

Con Node 22 y las dependencias locales ya instaladas, desde la raíz del repositorio:

```sh
PATH=/Users/emeku/.local/share/nvm/v22.22.2/bin:$PATH \
WRANGLER_SEND_METRICS=false CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false \
node scripts/generar-semilla-piloto.mjs /ruta/canonica/externa/semilla-nueva
```

Sustituí el último argumento por una ruta **absoluta nueva**. Su padre debe existir, ser canónico, sin enlaces y estar fuera del repositorio. No se aceptan rutas relativas, componentes `.`/`..`, barra final, argumentos adicionales, salidas existentes (incluidos enlaces rotos), rutas interiores o que contengan el repositorio. Un rechazo de preflight no crea salida.

| Archivo | Contenido para revisar |
| --- | --- |
| `parametros-semilla.json` | `id`, `revision_servidor: 0`, `estado_json` como cadena de texto; no es una instantánea envuelta. |
| `semilla-piloto.sql` | Un bloque transaccional con bloqueo, excepción si existe la raíz e inserción inicial; nunca upsert ni reinicio. |

El helper usa `crearProgreso(itinerario)`, valida con `esInstantaneaProgreso` y serializa únicamente el estado con `serializarProgreso`. El viaje real es `d64bf870a2c193e5`; paradas, pendientes y operaciones son objetos vacíos, y aquí es `null` con revisión cero. SQL conserva el texto con literales explícitos `TEXT`, no `JSONB`.

Vite empaqueta solamente este helper en memoria (`write: false`, `configFile: false`, raíz y `envDir` vacíos); no carga configuraciones públicas ni arranca la app. La carpeta de salida se reserva atómicamente antes del bundle. Los archivos se crean en modo exclusivo, sin sobrescritura.

## Procedimiento humano posterior: no ejecutado por este generador

1. Verificá en el proveedor la identidad del **proyecto, rama y base dedicada nueva de Neon**. No reutilices las bases anteriores ni aceptes una conexión inferida. La URI y los secretos permanecen fuera de argumentos, archivos, capturas y logs de este proceso.
2. Confirmá que esa base no tiene raíces ni datos de un piloto previo. Si existe una raíz, **detenete**: no reset, upsert, borrado ni reintento. Una semilla no es una herramienta de recuperación.
3. Revisá y aplicá, únicamente con autorización específica y en esa base dedicada, las migraciones existentes de `servidor/migraciones/` en orden: `001_base.sql`, `002_progreso.sql`, `003_sesiones.sql`, `004_limite.sql`, `005_fotos.sql`, `006_listado_fotos.sql`. Aquí solo se documenta el requisito; no se modifica ni aplica ninguna migración.
4. Revisá ambos archivos generados contra el constructor real. Ejecutá `semilla-piloto.sql` una sola vez en la base verificada. El bloqueo serializa inserciones concurrentes; una raíz con ese ID provoca una excepción que aborta el bloque, sin modificarla. La clave primaria también impide duplicados.
5. Corroborá después el ID, revisión cero y el texto exacto almacenado en `itinerario.viajes.estado_json`. No certifiques despliegue, autenticación, R2 o funcionamiento en Fold7 por haber generado estos archivos.

## Si falla

Si falla antes de reservar, no hay salida nueva. Si falla después, puede quedar una carpeta vacía o con artefactos parciales: **no se borra, no se sobrescribe ni se reintenta automáticamente**. Inspeccioná solo esa salida nueva y prepará otra ruta nueva para una generación futura autorizada; no uses un SQL parcial ni interpretes un fallo como aplicación en la base.

Este procedimiento no instala herramientas, no lee `.env`/`.dev.vars`, no rellena conexiones y no realiza acciones de proveedor. La aplicación futura de SQL y su comprobación real siguen pendientes de un operador autorizado.
