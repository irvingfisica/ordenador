use futures::stream::{self, StreamExt};
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, ACCEPT_LANGUAGE, CACHE_CONTROL, PRAGMA, USER_AGENT};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use std::time::Duration;
use tokio::sync::Semaphore;

const API: &str = "https://www.datos.gob.mx/api/3/action";

// Máximo de consultas simultáneas a datastore_info, para no saturar la API.
const MAX_CONSULTAS_DICC: usize = 1;
// Pausa tras cada consulta de diccionario.
const PAUSA_DICC_MS: u64 = 250;

fn cliente_ckan() -> Result<&'static reqwest::Client, String> {
    static CLIENTE: OnceLock<reqwest::Client> = OnceLock::new();
    if let Some(c) = CLIENTE.get() {
        return Ok(c);
    }

    let mut headers = HeaderMap::new();
    headers.insert(
        USER_AGENT,
        HeaderValue::from_static(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) \
             AppleWebKit/537.36 (KHTML, like Gecko) \
             Chrome/122.0.0.0 Safari/537.36",
        ),
    );
    headers.insert(ACCEPT, HeaderValue::from_static("application/json, text/plain, */*"));
    headers.insert(ACCEPT_LANGUAGE, HeaderValue::from_static("es-MX,es;q=0.9,en;q=0.8"));
    headers.insert(CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    headers.insert(PRAGMA, HeaderValue::from_static("no-cache"));

    let cliente = reqwest::Client::builder()
        .default_headers(headers)
        .gzip(true)
        .brotli(true)
        .deflate(true)
        .tcp_keepalive(Duration::from_secs(30))
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;

    Ok(CLIENTE.get_or_init(|| cliente))
}

fn semaforo_dicc() -> &'static Semaphore {
    static SEM: OnceLock<Semaphore> = OnceLock::new();
    SEM.get_or_init(|| Semaphore::new(MAX_CONSULTAS_DICC))
}

#[derive(Deserialize)]
struct CkanRespuesta {
    success: bool,
    #[serde(default)]
    result: Value,
    #[serde(default)]
    error: Value,
}

/// Lee una respuesta CKAN y extrae `result`, conservando el mensaje de error de CKAN si lo hay.
async fn leer_ckan<T: DeserializeOwned>(respuesta: reqwest::Response) -> Result<T, String> {
    let status = respuesta.status();
    let texto = respuesta.text().await.map_err(|e| e.to_string())?;

    let datos: CkanRespuesta = match serde_json::from_str(&texto) {
        Ok(d) => d,
        Err(_) => {
            let corto: String = texto.chars().take(200).collect();
            return Err(format!("HTTP {}: {}", status.as_u16(), corto));
        }
    };

    if !datos.success {
        let msg = datos
            .error
            .get("message")
            .and_then(|m| m.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| datos.error.to_string());
        return Err(format!("HTTP {}: {}", status.as_u16(), msg));
    }

    serde_json::from_value(datos.result).map_err(|e| e.to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Institucion {
    pub id: String,
    pub name: String,
    pub display_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CacheInstituciones {
    pub instituciones: Vec<Institucion>,
}

#[derive(Debug, Deserialize)]
struct PackageSearch {
    results: Vec<ConjuntoBreve>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConjuntoBreve {
    pub id: String,
    pub name: String,
    pub title: String,
}

#[derive(Debug, Deserialize)]
struct Paquete {
    id: String,
    name: String,
    title: String,
    #[serde(default)]
    resources: Vec<RecursoCkan>,
}

#[derive(Debug, Deserialize)]
struct RecursoCkan {
    id: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    format: Option<String>,
    #[serde(default)]
    position: Option<i64>,
    #[serde(default)]
    datastore_active: Option<bool>,
    #[serde(default)]
    dashboard: Option<String>,
    #[serde(default)]
    resource_viz: Option<String>,
    #[serde(default)]
    chart_type: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct Recurso {
    pub id: String,
    pub name: String,
    pub format: String,
    pub position: Option<i64>,
    pub datastore_active: bool,
    pub dashboard: String,
    pub resource_viz: String,
    pub chart_type: String,
    pub visualizado: bool,
}

#[derive(Debug, Serialize)]
pub struct DetalleConjunto {
    pub id: String,
    pub name: String,
    pub title: String,
    pub recursos: Vec<Recurso>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EstadoDiccionario {
    /// "completo" | "parcial" | "vacio" | "sin_datastore"
    pub estado: String,
    pub campos: usize,
    pub con_info: usize,
    /// Momento de la revisión (segundos desde 1970).
    #[serde(default)]
    pub revisado: u64,
}

#[derive(Debug, Serialize)]
pub struct ResultadoOrden {
    pub cambiado: bool,
    pub orden: Vec<String>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            obtener_instituciones,
            obtener_conjuntos,
            obtener_recursos,
            estado_diccionario,
            diccionarios_en_cache,
            reordenar_recursos
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

async fn consultar_paquete(id: &str, apikey: Option<&str>) -> Result<Paquete, String> {
    let cliente = cliente_ckan()?;
    let mut peticion = cliente
        .get(format!("{API}/package_show"))
        .query(&[("id", id)]);

    if let Some(k) = apikey.filter(|k| !k.trim().is_empty()) {
        peticion = peticion.header("Authorization", k.trim());
    }

    let respuesta = peticion.send().await.map_err(|e| e.to_string())?;
    leer_ckan(respuesta).await
}

/// Lee el conjunto directamente (package_show), así el orden es el actual de la plataforma
/// y no el del índice de búsqueda, que puede ir retrasado.
#[tauri::command]
async fn obtener_recursos(conjunto: String, apikey: Option<String>) -> Result<DetalleConjunto, String> {
    let paquete = consultar_paquete(&conjunto, apikey.as_deref()).await?;

    let recursos = paquete
        .resources
        .into_iter()
        .map(|r| {
            let dashboard = r.dashboard.clone().unwrap_or_default();
            // Solo importa si es "none" o no: puede haber varios tipos de visualizador.
            // Si el campo no existe (recursos antiguos) se toma como sin visualización.
            let visualizado = !dashboard.trim().is_empty() && dashboard.trim() != "none";
            Recurso {
                id: r.id,
                name: r.name.unwrap_or_default(),
                format: r.format.unwrap_or_default(),
                position: r.position,
                datastore_active: r.datastore_active.unwrap_or(false),
                dashboard,
                resource_viz: r.resource_viz.unwrap_or_default(),
                chart_type: r.chart_type.unwrap_or_default(),
                visualizado,
            }
        })
        .collect();

    Ok(DetalleConjunto {
        id: paquete.id,
        name: paquete.name,
        title: paquete.title,
        recursos,
    })
}

/// Revisa en datastore_info si las columnas del recurso tienen etiqueta/descripción
/// (los campos `info.label` e `info.notes` que se envían con datastore_create).
#[tauri::command]
async fn estado_diccionario(resource_id: String, apikey: Option<String>) -> Result<EstadoDiccionario, String> {
    let _permiso = semaforo_dicc().acquire().await.map_err(|e| e.to_string())?;

    let cliente = cliente_ckan()?;
    let mut peticion = cliente
        .get(format!("{API}/datastore_info"))
        .query(&[("id", resource_id.as_str())]);

    if let Some(k) = apikey.as_deref().filter(|k| !k.trim().is_empty()) {
        peticion = peticion.header("Authorization", k.trim());
    }

    let respuesta = peticion.send().await.map_err(|e| e.to_string())?;
    let status = respuesta.status();

    let resultado = if status.as_u16() == 404 {
        Ok(EstadoDiccionario { estado: "sin_datastore".into(), campos: 0, con_info: 0, revisado: ahora() })
    } else {
        let info: Value = leer_ckan(respuesta).await?;
        let campos: Vec<&Value> = info
            .get("fields")
            .and_then(|f| f.as_array())
            .map(|a| a.iter().filter(|c| c.get("id").and_then(|i| i.as_str()) != Some("_id")).collect())
            .unwrap_or_default();

        let con_info = campos
            .iter()
            .filter(|c| {
                let texto = |k: &str| {
                    c.get("info")
                        .and_then(|i| i.get(k))
                        .and_then(|v| v.as_str())
                        .map(|s| !s.trim().is_empty())
                        .unwrap_or(false)
                };
                texto("label") || texto("notes")
            })
            .count();

        let estado = if campos.is_empty() {
            "sin_datastore"
        } else if con_info == 0 {
            "vacio"
        } else if con_info < campos.len() {
            "parcial"
        } else {
            "completo"
        };

        Ok(EstadoDiccionario { estado: estado.into(), campos: campos.len(), con_info, revisado: ahora() })
    };

    if let Ok(e) = &resultado {
        guardar_en_cache_dicc(&resource_id, e.clone());
    }

    tokio::time::sleep(Duration::from_millis(PAUSA_DICC_MS)).await;
    resultado
}

/// Devuelve, sin hacer ninguna petición, los estados de diccionario guardados en disco.
#[tauri::command]
fn diccionarios_en_cache(ids: Vec<String>) -> HashMap<String, EstadoDiccionario> {
    let cache = cache_dicc().lock().unwrap_or_else(|e| e.into_inner());
    ids.into_iter()
        .filter_map(|id| cache.get(&id).cloned().map(|e| (id, e)))
        .collect()
}

fn ahora() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn ruta_cache_dicc() -> Result<PathBuf, String> {
    let mut path = ruta_cache()?;
    path.set_file_name("diccionarios.json");
    Ok(path)
}

fn cache_dicc() -> &'static Mutex<HashMap<String, EstadoDiccionario>> {
    static CACHE: OnceLock<Mutex<HashMap<String, EstadoDiccionario>>> = OnceLock::new();
    CACHE.get_or_init(|| {
        let mapa = ruta_cache_dicc()
            .ok()
            .and_then(|r| std::fs::read_to_string(r).ok())
            .and_then(|c| serde_json::from_str(&c).ok())
            .unwrap_or_default();
        Mutex::new(mapa)
    })
}

fn guardar_en_cache_dicc(id: &str, estado: EstadoDiccionario) {
    let mut cache = cache_dicc().lock().unwrap_or_else(|e| e.into_inner());
    cache.insert(id.to_string(), estado);
    if let (Ok(ruta), Ok(json)) = (ruta_cache_dicc(), serde_json::to_string(&*cache)) {
        if let Err(e) = std::fs::write(ruta, json) {
            eprintln!("No se pudo guardar la caché de diccionarios: {e}");
        }
    }
}

/// Envía únicamente el nuevo orden con package_resource_reorder.
/// Antes verifica que la lista sea exactamente el mismo conjunto de recursos que hay en la plataforma.
#[tauri::command]
async fn reordenar_recursos(apikey: String, conjunto: String, orden: Vec<String>) -> Result<ResultadoOrden, String> {
    let apikey = apikey.trim().to_string();
    if apikey.is_empty() {
        return Err("Falta la APIkey.".into());
    }

    let actual = consultar_paquete(&conjunto, Some(&apikey)).await?;
    let ids_actuales: Vec<String> = actual.resources.iter().map(|r| r.id.clone()).collect();

    let set_actual: HashSet<&String> = ids_actuales.iter().collect();
    let set_nuevo: HashSet<&String> = orden.iter().collect();

    if set_nuevo.len() != orden.len() {
        return Err("El orden contiene recursos repetidos.".into());
    }
    if set_actual != set_nuevo {
        return Err("Los recursos del conjunto cambiaron en la plataforma desde que se cargaron. Recarga el conjunto antes de ordenar.".into());
    }
    if ids_actuales == orden {
        return Ok(ResultadoOrden { cambiado: false, orden: ids_actuales });
    }

    let cliente = cliente_ckan()?;
    let cuerpo = serde_json::json!({ "id": actual.id, "order": orden });

    let respuesta = cliente
        .post(format!("{API}/package_resource_reorder"))
        .header("Authorization", apikey)
        .json(&cuerpo)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let resultado: Value = leer_ckan(respuesta).await?;
    let orden_final = resultado
        .get("order")
        .and_then(|o| o.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or(orden);

    Ok(ResultadoOrden { cambiado: true, orden: orden_final })
}

#[tauri::command]
async fn obtener_conjuntos(institucion: String) -> Result<Vec<ConjuntoBreve>, String> {
    let cliente = cliente_ckan()?;
    let respuesta = cliente
        .get(format!("{API}/package_search"))
        .query(&[
            ("fq", format!("organization:{institucion}")),
            ("rows", "1000".to_string()),
            ("fl", "id,name,title".to_string()),
        ])
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let datos: PackageSearch = leer_ckan(respuesta).await?;
    let mut conjuntos = datos.results;
    conjuntos.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()));
    Ok(conjuntos)
}

#[tauri::command]
async fn obtener_instituciones() -> Result<Vec<Institucion>, String> {
    let cliente = cliente_ckan()?;

    let respuesta = cliente
        .get(format!("{API}/organization_list"))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let lista_actual: Vec<String> = leer_ckan(respuesta).await?;

    let mut cache = cargar_cache();
    let conocidas: HashSet<String> = cache.instituciones.iter().map(|i| i.name.clone()).collect();
    let faltantes: Vec<String> = lista_actual.iter().filter(|n| !conocidas.contains(*n)).cloned().collect();

    let nuevas: Vec<Institucion> = stream::iter(faltantes)
        .map(|nombre| async move { obtener_detalle_institucion(&nombre).await })
        .buffer_unordered(4)
        .filter_map(|x| async move {
            match x {
                Ok(i) => Some(i),
                Err(e) => {
                    eprintln!("Error: {}", e);
                    None
                }
            }
        })
        .collect()
        .await;

    cache.instituciones.extend(nuevas);
    let vigentes: HashSet<&String> = lista_actual.iter().collect();
    cache.instituciones.retain(|i| vigentes.contains(&i.name));
    guardar_cache(&cache)?;

    let mapa: HashMap<String, Institucion> = cache.instituciones.iter().cloned().map(|x| (x.name.clone(), x)).collect();
    let mut resultado: Vec<Institucion> = lista_actual.iter().filter_map(|n| mapa.get(n).cloned()).collect();
    resultado.sort_by(|a, b| a.display_name.cmp(&b.display_name));

    Ok(resultado)
}

async fn obtener_detalle_institucion(nombre: &str) -> Result<Institucion, String> {
    let cliente = cliente_ckan()?;
    let respuesta = cliente
        .get(format!("{API}/organization_show"))
        .query(&[("id", nombre)])
        .send()
        .await
        .map_err(|e| e.to_string())?;
    leer_ckan(respuesta).await
}

// Misma caché que usan validador y diccionarios, para no volver a pedir las instituciones.
fn ruta_cache() -> Result<PathBuf, String> {
    let mut path = dirs::cache_dir().ok_or("No se pudo localizar el directorio de cache")?;
    path.push("validador_app");
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    path.push("instituciones.json");
    Ok(path)
}

fn cargar_cache() -> CacheInstituciones {
    ruta_cache()
        .ok()
        .and_then(|r| std::fs::read_to_string(r).ok())
        .and_then(|c| serde_json::from_str(&c).ok())
        .unwrap_or_default()
}

fn guardar_cache(cache: &CacheInstituciones) -> Result<(), String> {
    let ruta = ruta_cache()?;
    let json = serde_json::to_string_pretty(cache).map_err(|e| e.to_string())?;
    std::fs::write(ruta, json).map_err(|e| e.to_string())
}
