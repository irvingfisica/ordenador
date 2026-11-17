import 'bootstrap/dist/css/bootstrap.min.css';
import 'bootstrap-icons/font/bootstrap-icons.css';
import { Toast, Modal } from 'bootstrap';
import "@tarekraafat/autocomplete.js/dist/css/autoComplete.02.css";
import autoComplete from "@tarekraafat/autocomplete.js";
import Sortable from 'sortablejs';
import * as d3 from 'd3';
const { invoke } = window.__TAURI__.core;

// Estado de la app
const estado = {
  conjunto: null,        // {id, name, title, recursos}
  ordenOriginal: [],     // ids en el orden de la plataforma
  diccionarios: new Map(), // resource_id -> {estado, campos, con_info, revisado}
  tokenRevision: 0,      // para cancelar revisiones de diccionario de un conjunto anterior
  revisando: false,
  sortable: null,
};

const DICC = {
  completo:      { icono: "bi-journal-check", clase: "text-success",   texto: "Diccionario configurado" },
  parcial:       { icono: "bi-journal-minus", clase: "text-warning", texto: "Diccionario incompleto" },
  vacio:         { icono: "bi-journal-x",     clase: "text-danger",    texto: "Sin diccionario" },
  sin_datastore: { icono: "bi-journal",       clase: "text-secondary", texto: "El recurso no está en el datastore (no admite diccionario)" },
  error:         { icono: "bi-exclamation-triangle", clase: "text-secondary", texto: "No se pudo revisar el diccionario" },
  sin_revisar:   { icono: "bi-question-circle", clase: "text-secondary opacity-50", texto: "Diccionario sin revisar" },
};

// Si un conjunto tiene más recursos sin revisar que este número, la revisión no es automática:
// se pide con un botón para no lanzar muchas consultas a la API.
const UMBRAL_AUTO = 20;

// ---------- Instituciones ----------
let instituciones = [];
try {
  show_status("Cargando instituciones...");
  instituciones = await invoke("obtener_instituciones");
} catch (error) {
  showToast(`No se pudieron cargar las instituciones. Motivo: ${error}`, "danger");
} finally {
  hide_status();
}

const acjs = new autoComplete({
  selector: "#buscainst",
  placeHolder: "Busca una institución...",
  data: { src: instituciones, keys: ["display_name"] },
  diacritics: true,
  threshold: 1,
  debounce: 150,
  resultList: { maxResults: 10, noResults: true },
  resultItem: { highlight: true },
  events: {
    input: {
      selection(event) {
        event.preventDefault();
        const item = event.detail.selection.value;
        acjs.input.value = item.display_name;
        obtenerConjuntos(item.name);
      },
    },
  },
});

document.querySelector("#buscainst").addEventListener("focus", function () { this.value = ""; });

// ---------- Conjuntos ----------
async function obtenerConjuntos(name) {
  if (!(await descartarCambios())) return;

  let conjuntos;
  try {
    show_status("Cargando conjuntos...");
    conjuntos = await invoke("obtener_conjuntos", { institucion: name });
  } catch (error) {
    showToast(`No se pudieron cargar los conjuntos. Motivo: ${error}`, "danger");
    return;
  } finally {
    hide_status();
  }

  limpiarRecursos();
  const cont = d3.select("#conjuntos");
  cont.selectAll("*").remove();

  if (!conjuntos.length) {
    cont.append("p").attr("class", "text-muted").html("Esta institución no tiene conjuntos públicos.");
    return;
  }

  cont.append("label").attr("for", "selconjunto").attr("class", "form-label").html(`Selecciona un conjunto (${conjuntos.length}):`);
  const sel = cont.append("select").attr("class", "form-select").attr("id", "selconjunto");
  sel.append("option").attr("value", "").property("selected", true).property("disabled", true).html("— Elige un conjunto —");
  sel.selectAll("option.cj").data(conjuntos).join("option")
    .attr("class", "cj")
    .attr("value", d => d.name)
    .text(d => d.title);

  let previo = "";
  sel.on("change", async function () {
    const valor = this.value;
    if (!(await descartarCambios())) { this.value = previo; return; }
    previo = valor;
    cargarConjunto(valor);
  });
}

function hayCambios() {
  return estado.conjunto && !mismoOrden(ordenActual(), estado.ordenOriginal);
}

async function descartarCambios() {
  if (!hayCambios()) return true;
  return confirmar("Cambios sin guardar", "Hay un orden nuevo que no se ha enviado a la PNDA. ¿Descartarlo?", "Descartar", "btn-danger");
}

function limpiarRecursos() {
  estado.tokenRevision++;
  estado.conjunto = null;
  estado.ordenOriginal = [];
  if (estado.sortable) { estado.sortable.destroy(); estado.sortable = null; }
  d3.select("#recursos").selectAll("*").remove();
}

// ---------- Recursos ----------
async function cargarConjunto(nombre) {
  let detalle;
  try {
    show_status("Cargando recursos del conjunto...");
    detalle = await invoke("obtener_recursos", { conjunto: nombre, apikey: apikey() });
  } catch (error) {
    showToast(`No se pudieron cargar los recursos. Motivo: ${error}`, "danger");
    return;
  } finally {
    hide_status();
  }

  limpiarRecursos();
  estado.conjunto = detalle;
  estado.ordenOriginal = detalle.recursos.map(r => r.id);
  pintarRecursos();
  await prepararDiccionarios(detalle.recursos);
}

function pintarRecursos() {
  const det = estado.conjunto;
  const cont = d3.select("#recursos");
  cont.selectAll("*").remove();

  cont.append("h3").html("Recursos del conjunto");
  cont.append("p").attr("class", "mb-1").html(`<strong>Conjunto:</strong> ${esc(det.title)}`);
  cont.append("p").attr("class", "text-muted").html("Arrastra los recursos (o usa las flechas) para definir el nuevo orden. El primero de la lista es el que aparece primero en la plataforma.");

  const leyenda = cont.append("div").attr("class", "leyenda small text-muted mb-3");
  for (const k of ["completo", "parcial", "vacio", "sin_datastore"]) {
    leyenda.append("span").html(`<i class="bi ${DICC[k].icono} ${DICC[k].clase}"></i> ${DICC[k].texto}`);
  }
  leyenda.append("span").html(`<i class="bi ${DICC.sin_revisar.icono} ${DICC.sin_revisar.clase}"></i> ${DICC.sin_revisar.texto}`);
  leyenda.append("span").html(`<i class="bi bi-bar-chart-fill text-success"></i> Visualizado`);
  leyenda.append("span").html(`<i class="bi bi-bar-chart text-secondary opacity-50"></i> Sin visualización`);

  if (!det.recursos.length) {
    cont.append("p").html("Este conjunto no tiene recursos.");
    return;
  }

  cont.append("div").attr("id", "diccbar").attr("class", "d-flex align-items-center gap-2 flex-wrap mb-3 small");

  const lista = cont.append("ul").attr("class", "list-group").attr("id", "listaRecursos");
  const items = lista.selectAll("li").data(det.recursos, d => d.id).join("li")
    .attr("class", "list-group-item d-flex align-items-center gap-3 recurso")
    .attr("data-id", d => d.id);

  items.append("i").attr("class", "bi bi-grip-vertical asa").attr("title", "Arrastrar");
  items.append("span").attr("class", "posicion badge text-bg-light border");
  const cuerpo = items.append("div").attr("class", "flex-grow-1 nombre");
  cuerpo.append("div").text(d => d.name || "(sin nombre)");
  cuerpo.append("div").attr("class", "small text-muted original");
  items.append("span").attr("class", "badge text-bg-secondary formato").text(d => d.format || "—");

  items.append("i").attr("class", "icono dicc bi")
    .on("click", function () {
      if (this.classList.contains("spinner-border")) return;
      const r = estado.conjunto.recursos.find(x => x.id === this.closest("li").dataset.id);
      if (r && r.datastore_active) revisarDiccionarios([r]);
    });

  items.append("i")
    .attr("class", d => d.visualizado ? "icono bi bi-bar-chart-fill text-success" : "icono bi bi-bar-chart text-secondary opacity-50")
    .attr("title", d => d.visualizado
      ? `Visualizado (visualizador: ${d.dashboard})`
      : `Sin visualización${d.dashboard ? "" : " (el recurso no tiene campo dashboard)"}`);

  const flechas = items.append("div").attr("class", "btn-group-vertical btn-group-sm flechas");
  flechas.append("button").attr("class", "btn btn-outline-secondary").attr("title", "Subir")
    .html('<i class="bi bi-chevron-up"></i>')
    .on("click", function () { mover(this.closest("li"), -1); });
  flechas.append("button").attr("class", "btn btn-outline-secondary").attr("title", "Bajar")
    .html('<i class="bi bi-chevron-down"></i>')
    .on("click", function () { mover(this.closest("li"), 1); });

  for (const r of det.recursos) pintarDiccionario(r.id);

  estado.sortable = Sortable.create(document.getElementById("listaRecursos"), {
    animation: 150,
    handle: ".recurso",
    filter: ".flechas, .dicc",
    preventOnFilter: false,
    forceFallback: true,
    ghostClass: "fantasma",
    onEnd: actualizarVista,
  });

  const acciones = cont.append("div").attr("class", "d-flex gap-2 mt-4 flex-wrap");
  acciones.append("button").attr("class", "btn btn-primary").attr("id", "guardar")
    .html('<i class="bi bi-upload"></i> Guardar orden en la PNDA').on("click", guardarOrden);
  acciones.append("button").attr("class", "btn btn-outline-secondary").attr("id", "restaurar")
    .html('<i class="bi bi-arrow-counterclockwise"></i> Restaurar orden actual').on("click", restaurar);
  acciones.append("button").attr("class", "btn btn-outline-secondary").attr("id", "recargar")
    .html('<i class="bi bi-arrow-repeat"></i> Recargar desde la plataforma')
    .on("click", async () => { if (await descartarCambios()) cargarConjunto(estado.conjunto.name); });

  actualizarVista();
}

function mover(li, delta) {
  const lista = li.parentElement;
  if (delta < 0 && li.previousElementSibling) lista.insertBefore(li, li.previousElementSibling);
  if (delta > 0 && li.nextElementSibling) lista.insertBefore(li.nextElementSibling, li);
  actualizarVista();
}

function ordenActual() {
  return Array.from(document.querySelectorAll("#listaRecursos > li")).map(li => li.dataset.id);
}

function mismoOrden(a, b) {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function actualizarVista() {
  const actual = ordenActual();
  document.querySelectorAll("#listaRecursos > li").forEach((li, i) => {
    const original = estado.ordenOriginal.indexOf(li.dataset.id);
    li.querySelector(".posicion").textContent = i + 1;
    li.classList.toggle("movido", original !== i);
    li.querySelector(".original").textContent = original !== i ? `Antes en la posición ${original + 1}` : "";
  });
  const cambios = !mismoOrden(actual, estado.ordenOriginal);
  d3.select("#guardar").property("disabled", !cambios);
  d3.select("#restaurar").property("disabled", !cambios);
}

function restaurar() {
  const lista = document.getElementById("listaRecursos");
  const porId = new Map(Array.from(lista.children).map(li => [li.dataset.id, li]));
  for (const id of estado.ordenOriginal) lista.appendChild(porId.get(id));
  actualizarVista();
}

async function guardarOrden() {
  const key = apikey();
  if (!key) {
    showToast("Introduce tu APIkey para guardar el orden.", "warning");
    document.getElementById("apikey").focus();
    return;
  }

  const orden = ordenActual();
  const movidos = orden.filter((id, i) => estado.ordenOriginal[i] !== id).length;
  const ok = await confirmar(
    "Guardar orden",
    `Se enviará el nuevo orden de <strong>${orden.length}</strong> recursos (${movidos} cambian de posición) del conjunto <strong>${esc(estado.conjunto.title)}</strong>. Solo se modifica el orden.`,
    "Guardar", "btn-primary");
  if (!ok) return;

  const nombre = estado.conjunto.name;
  d3.selectAll("#recursos button").property("disabled", true);
  try {
    show_status("Enviando el nuevo orden a la PNDA...");
    const res = await invoke("reordenar_recursos", { apikey: key, conjunto: estado.conjunto.id, orden });
    if (!res.cambiado) {
      showToast("El orden ya era ese en la plataforma; no se envió nada.", "info");
    } else if (mismoOrden(res.orden, orden)) {
      showToast("Orden guardado con éxito.", "success");
    } else {
      showToast("La plataforma respondió con un orden distinto al enviado. Revisa la lista.", "warning");
    }
  } catch (error) {
    showToast(`No se pudo guardar el orden. Motivo: ${error}`, "danger");
    d3.selectAll("#recursos button").property("disabled", false);
    actualizarVista();
    return;
  } finally {
    hide_status();
  }

  // Volver a leer el conjunto para mostrar el orden real de la plataforma.
  await cargarConjunto(nombre);
}

// ---------- Diccionarios ----------
// Muestra lo que haya en la caché en disco (sin peticiones) y solo consulta la API
// automáticamente si faltan pocos recursos por revisar.
async function prepararDiccionarios(recursos) {
  for (const r of recursos) {
    if (!r.datastore_active) estado.diccionarios.set(r.id, { estado: "sin_datastore", campos: 0, con_info: 0 });
  }

  const conDatastore = recursos.filter(r => r.datastore_active).map(r => r.id);
  if (conDatastore.length) {
    try {
      const enCache = await invoke("diccionarios_en_cache", { ids: conDatastore });
      for (const [id, e] of Object.entries(enCache)) estado.diccionarios.set(id, e);
    } catch (error) {
      console.warn("No se pudo leer la caché de diccionarios:", error);
    }
  }
  for (const r of recursos) pintarDiccionario(r.id);

  const pendientes = recursos.filter(r => !estado.diccionarios.has(r.id));
  if (pendientes.length && pendientes.length <= UMBRAL_AUTO) {
    revisarDiccionarios(pendientes);
  } else {
    pintarBarraDicc();
  }
}

function pendientesDicc() {
  return (estado.conjunto?.recursos || []).filter(r => !estado.diccionarios.has(r.id));
}

function pintarBarraDicc(progreso) {
  const bar = d3.select("#diccbar");
  if (bar.empty() || !estado.conjunto) return;
  bar.selectAll("*").remove();

  if (progreso) {
    bar.append("span").attr("class", "spinner-border spinner-border-sm text-secondary");
    bar.append("span").attr("class", "text-muted").text(`Revisando diccionarios ${progreso.hecho} de ${progreso.total}...`);
    bar.append("button").attr("class", "btn btn-sm btn-link").text("Detener")
      .on("click", () => { estado.detener = true; });
    return;
  }

  const pendientes = pendientesDicc();
  const revisables = estado.conjunto.recursos.filter(r => r.datastore_active);

  if (pendientes.length) {
    bar.append("span").attr("class", "text-muted").text(`${pendientes.length} recurso(s) sin revisar su diccionario.`);
    bar.append("button").attr("class", "btn btn-sm btn-outline-primary")
      .html(`<i class="bi bi-journal-check"></i> Revisar pendientes (${pendientes.length})`)
      .on("click", () => revisarDiccionarios(pendientes));
  } else if (revisables.length) {
    const fechas = revisables.map(r => estado.diccionarios.get(r.id)?.revisado).filter(Boolean);
    if (fechas.length) bar.append("span").attr("class", "text-muted").text(`Revisión más antigua: ${fecha(Math.min(...fechas))}.`);
  }

  if (revisables.length) {
    bar.append("button").attr("class", "btn btn-sm btn-outline-secondary")
      .html(`<i class="bi bi-arrow-repeat"></i> Volver a revisar todos (${revisables.length})`)
      .on("click", async () => {
        if (revisables.length > UMBRAL_AUTO && !(await confirmar("Revisar diccionarios",
          `Se harán <strong>${revisables.length}</strong> consultas a la API, una por recurso.`, "Revisar", "btn-primary"))) return;
        revisarDiccionarios(revisables);
      });
    bar.append("span").attr("class", "text-muted").text("También puedes dar clic en el ícono de diccionario de un recurso para revisarlo.");
  }
}

async function revisarDiccionarios(recursos) {
  if (estado.revisando) {
    showToast("Ya hay una revisión de diccionarios en curso.", "info");
    return;
  }
  estado.revisando = true;
  estado.detener = false;
  const token = estado.tokenRevision;
  const lista = recursos.filter(r => r.datastore_active);

  try {
    // Una consulta a la vez; el backend además pausa entre consultas y guarda el resultado en disco.
    for (let i = 0; i < lista.length; i++) {
      if (token !== estado.tokenRevision || estado.detener) return;
      pintarBarraDicc({ hecho: i + 1, total: lista.length });
      const r = lista[i];
      marcarRevisando(r.id);
      try {
        const res = await invoke("estado_diccionario", { resourceId: r.id, apikey: apikey() });
        estado.diccionarios.set(r.id, res);
        pintarDiccionario(r.id);
      } catch (error) {
        pintarDiccionario(r.id, { estado: "error", detalle: String(error) });
        if (/HTTP 429|HTTP 403/.test(String(error))) {
          showToast(`La API rechazó la consulta (${error}). Se detuvo la revisión de diccionarios.`, "warning");
          return;
        }
      }
    }
  } finally {
    estado.revisando = false;
    if (token === estado.tokenRevision) {
      // Los que se quedaron a medias regresan a su estado anterior (o a "sin revisar").
      for (const r of lista) {
        const el = document.querySelector(`#listaRecursos li[data-id="${r.id}"] .dicc`);
        if (el && el.classList.contains("spinner-border")) pintarDiccionario(r.id);
      }
      pintarBarraDicc();
    }
  }
}

function marcarRevisando(id) {
  const el = document.querySelector(`#listaRecursos li[data-id="${id}"] .dicc`);
  if (!el) return;
  el.className = "icono dicc bi spinner-border spinner-border-sm text-secondary";
  el.title = "Revisando diccionario...";
}

function pintarDiccionario(id, temporal) {
  const el = document.querySelector(`#listaRecursos li[data-id="${id}"] .dicc`);
  if (!el) return;
  const info = temporal || estado.diccionarios.get(id) || { estado: "sin_revisar" };
  const d = DICC[info.estado] || DICC.error;
  el.className = `icono dicc bi ${d.icono} ${d.clase}`;
  let titulo = d.texto;
  if (info.campos) titulo += `\n${info.con_info} de ${info.campos} columnas con etiqueta/descripción`;
  if (info.revisado) titulo += `\nRevisado: ${fecha(info.revisado)}`;
  if (info.detalle) titulo += `\n${info.detalle}`;
  if (info.estado !== "sin_datastore") titulo += "\n(Clic para revisar)";
  el.title = titulo;
}

function fecha(segundos) {
  return new Date(segundos * 1000).toLocaleString("es-MX", { dateStyle: "medium", timeStyle: "short" });
}

// ---------- Utilidades ----------
function apikey() {
  return document.getElementById("apikey").value.trim();
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function confirmar(titulo, mensaje, textoOk, claseOk) {
  return new Promise(resolve => {
    const el = document.createElement("div");
    el.className = "modal fade";
    el.tabIndex = -1;
    el.innerHTML = `
      <div class="modal-dialog modal-dialog-centered">
        <div class="modal-content">
          <div class="modal-header"><h5 class="modal-title">${titulo}</h5></div>
          <div class="modal-body">${mensaje}</div>
          <div class="modal-footer">
            <button type="button" class="btn btn-outline-secondary" data-r="0">Cancelar</button>
            <button type="button" class="btn ${claseOk}" data-r="1">${textoOk}</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(el);
    const modal = new Modal(el, { backdrop: "static" });
    let respuesta = false;
    el.querySelectorAll("[data-r]").forEach(b => b.addEventListener("click", () => {
      respuesta = b.dataset.r === "1";
      modal.hide();
    }));
    el.addEventListener("hidden.bs.modal", () => { el.remove(); resolve(respuesta); });
    modal.show();
  });
}

export function showToast(message, type = "danger") {
  const container = document.getElementById("toast-container");
  const toastEl = document.createElement("div");
  toastEl.className = `toast align-items-center text-bg-${type} border-0`;
  toastEl.role = "alert";
  toastEl.innerHTML = `
    <div class="d-flex">
      <div class="toast-body">${message}</div>
      <button type="button" class="btn-close btn-close-white me-2 m-auto"
              data-bs-dismiss="toast" aria-label="Close"></button>
    </div>`;
  container.appendChild(toastEl);
  const toast = new Toast(toastEl, { delay: 5000 });
  toast.show();
  toastEl.addEventListener("hidden.bs.toast", () => toastEl.remove());
}

function show_status(message) {
  d3.select("#spinner").classed("d-none", false);
  d3.select("#status").html(message);
}

function hide_status() {
  d3.select("#spinner").classed("d-none", true);
  d3.select("#status").html("");
}
