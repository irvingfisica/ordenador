# Ordenador de recursos para PNDA

Herramienta para revisar y cambiar el orden en que se muestran los recursos de un conjunto de datos en la PNDA (datos.gob.mx). Funciona como aplicación independiente construida en Rust con Tauri, igual que `diccionarios` y `validador`.

## Qué hace

1. Se busca una institución y se elige uno de sus conjuntos.
2. Se muestran los recursos del conjunto en el mismo orden que en la plataforma (se leen con `package_show`).
3. Cada recurso indica con un ícono:
   - **Diccionario**: configurado, incompleto, sin diccionario o fuera del datastore. Se consulta `datastore_info` y se revisa si las columnas tienen `info.label` / `info.notes`, que son los campos que envía la herramienta de diccionarios con `datastore_create`.
   - **Visualización**: el recurso se considera visualizado si su campo `dashboard` tiene cualquier valor distinto de `none` (puede haber varios tipos de visualizador). Si el campo no existe se toma como sin visualización.
4. Los recursos se reordenan arrastrándolos (o con las flechas).
5. Con la APIkey, el nuevo orden se envía con `package_resource_reorder`, que solo cambia el orden. Antes de enviarlo, la app vuelve a leer el conjunto y aborta si sus recursos cambiaron.

### Cuidado con la API
- Revisar el diccionario cuesta una consulta `datastore_info` por recurso. Se hacen de una en una, con una pausa de 250 ms entre ellas, y solo para el conjunto elegido.
- El resultado se guarda en disco (`<caché del sistema>/validador_app/diccionarios.json`) y se reutiliza entre sesiones sin volver a consultar la API.
- Al abrir un conjunto, los recursos que ya están en la caché no se consultan. Si quedan 20 o menos sin revisar, se revisan automáticamente; si son más, se muestra el botón **Revisar pendientes**.
- Para actualizar los datos de la caché se usa **Volver a revisar todos** (pide confirmación si son más de 20) o se da clic en el ícono de diccionario de un recurso. La revisión se puede detener.
- Los recursos que no están en el datastore no se consultan.
- Si la API responde 403 o 429 se detiene la revisión.
- Se reutiliza la caché de instituciones de `validador`/`diccionarios`.

## Compilar

Los prerrequisitos son los mismos que en `diccionarios` (Tauri CLI, Rust y Node).

```shell
npm install
npm run tauri dev
npm run tauri build
```

Los ejecutables quedan en `./src-tauri/target/release/bundle`.
