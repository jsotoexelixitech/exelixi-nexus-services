/**
 * Catálogo de canales alternos y gestores (nest-api GET /api/v1/canal/actores, apikey de Nexus).
 * Sirve para llevar las pólizas de un gestor sin ccanalalt al canal al que pertenece y para
 * mostrar el nombre del canal. Caché de 10 minutos; nunca lanza (sin catálogo → null).
 */
import logger from '../../utils/logger';
import { NombresActores, normalizarCodigoActor } from './expedientes.domain';
import { nestMailConfig } from './expedientes.env';

/** Canal activo con el código tal como lo guarda el OCR en `ocrOpcional.canales`. */
export interface CanalCatalogo {
  /** String(ccanalalt).trim(): el mismo formato que compara el OCR en tiempo de ejecución. */
  codigo: string;
  nombre: string;
}

/** Punto de comercialización (magestor) de un canal: sigue la configuración del canal. */
export interface PuntoCatalogo {
  codigo: string;
  nombre: string;
}

export interface CatalogoCanales {
  /** ccanalalt → nombre del canal. */
  nombres: Map<string, string>;
  /** cgestor → ccanalalt del canal al que pertenece. */
  gestorCanal: Map<string, string>;
  /** cgestor → nombre del gestor (xgestor), también los que no tienen canal. */
  gestorNombre?: Map<string, string>;
  /** Canales en el orden de nest-api (también los que no traen nombre). */
  canales?: CanalCatalogo[];
  /**
   * ccanalalt (mismo formato que `canales[].codigo`) → puntos activos de ese canal, ordenados
   * por nombre. nest-api ya resuelve el canal de cada punto (columna o prefijo del código) y
   * deja fuera los de canales inactivos; los gestores sin canal (productores) no entran.
   */
  puntos?: Map<string, PuntoCatalogo[]>;
}

const TTL_MS = 10 * 60 * 1000;
let cache: { en: number; valor: CatalogoCanales | null } | null = null;

export async function catalogoCanales(
  ahora: number = Date.now(),
): Promise<CatalogoCanales | null> {
  if (cache && ahora - cache.en < TTL_MS) return cache.valor;
  const { url, apiKey } = nestMailConfig();
  if (!apiKey) return null;
  let valor: CatalogoCanales | null = null;
  try {
    const res = await fetch(`${url}/api/v1/canal/actores`, {
      headers: { Accept: 'application/json', apikey: apiKey },
      signal: AbortSignal.timeout(5_000),
    });
    const body = (await res.json().catch(() => ({}))) as {
      data?: { canales?: unknown[]; gestores?: unknown[] };
    };
    if (res.ok && body.data) {
      const canales: CanalCatalogo[] = [];
      const puntos = new Map<string, PuntoCatalogo[]>();
      const gestorNombre = new Map<string, string>();
      valor = {
        nombres: new Map(),
        gestorCanal: new Map(),
        gestorNombre,
        canales,
        puntos,
      };
      for (const raw of body.data.canales ?? []) {
        const c = (raw ?? {}) as Record<string, unknown>;
        const cod = normalizarCodigoActor(
          c.ccanalalt == null ? null : String(c.ccanalalt),
        );
        const nombre =
          typeof c.xcanalalt === 'string' ? c.xcanalalt.trim() : '';
        if (cod && nombre) valor.nombres.set(cod, nombre.slice(0, 120));
        const codigo = c.ccanalalt == null ? '' : String(c.ccanalalt).trim();
        if (codigo && !canales.some((x) => x.codigo === codigo)) {
          canales.push({ codigo, nombre: nombre.slice(0, 120) });
        }
      }
      for (const raw of body.data.gestores ?? []) {
        const g = (raw ?? {}) as Record<string, unknown>;
        const gestor = normalizarCodigoActor(
          g.cgestor == null ? null : String(g.cgestor),
        );
        const canal = normalizarCodigoActor(
          g.ccanalalt == null ? null : String(g.ccanalalt),
        );
        if (gestor && canal) valor.gestorCanal.set(gestor, canal);
        const xgestor = typeof g.xgestor === 'string' ? g.xgestor.trim() : '';
        if (gestor && xgestor) gestorNombre.set(gestor, xgestor.slice(0, 120));
        const codigoPunto = g.cgestor == null ? '' : String(g.cgestor).trim();
        const codigoCanal =
          g.ccanalalt == null ? '' : String(g.ccanalalt).trim();
        if (codigoPunto && codigoCanal) {
          const lista = puntos.get(codigoCanal) ?? [];
          lista.push({
            codigo: codigoPunto.slice(0, 64),
            nombre:
              typeof g.xgestor === 'string'
                ? g.xgestor.trim().slice(0, 120)
                : '',
          });
          puntos.set(codigoCanal, lista);
        }
      }
      // magestor.cgestor es VARCHAR y puede venir compuesto («215-2168», «0-1162»): el monitor
      // guarda a veces solo el número. Se indexa también el último tramo si no es ambiguo.
      const porNumero = new Map<string, string | null>();
      for (const [cod, canal] of valor.gestorCanal) {
        if (!cod.includes('-')) continue;
        const num = cod.split('-').pop() as string;
        const previo = porNumero.get(num);
        porNumero.set(num, previo === undefined || previo === canal ? canal : null);
      }
      for (const [num, canal] of porNumero)
        if (canal && !valor.gestorCanal.has(num)) valor.gestorCanal.set(num, canal);
      for (const lista of puntos.values()) {
        lista.sort(
          (a, b) =>
            a.nombre.localeCompare(b.nombre, 'es') ||
            a.codigo.localeCompare(b.codigo, 'es'),
        );
      }
    } else {
      logger.warn(`[expedientes] catálogo de canales: HTTP ${res.status}`);
    }
  } catch (err) {
    logger.warn(
      `[expedientes] catálogo de canales no disponible: ${err instanceof Error ? err.name : 'error'}`,
    );
  }
  // Un fallo también se guarda (1 minuto) para no reintentar en cada consulta.
  cache = { en: valor ? ahora : ahora - TTL_MS + 60_000, valor };
  return valor;
}

/**
 * gestor → canal del último catálogo cargado (o null). Lo usa la exclusión por canal, que es
 * síncrona; exclusionesActivas() carga el catálogo antes cuando hay alguna exclusión de canal.
 */
export function gestorCanalEnCache(): Map<string, string> | null {
  return cache?.valor?.gestorCanal ?? null;
}

/** ccanalalt → nombre del último catálogo cargado (o null). Para «emitida por» en la bandeja. */
export function nombresCanalEnCache(): Map<string, string> | null {
  return cache?.valor?.nombres ?? null;
}

/** Catálogos del último cargado para «emitida por» (canal, gestor y gestor → canal). */
export function nombresActoresEnCache(): NombresActores | null {
  const v = cache?.valor;
  return v
    ? { canal: v.nombres, gestor: v.gestorNombre ?? null, gestorCanal: v.gestorCanal }
    : null;
}

/** Solo pruebas. */
export function _resetCatalogoCanales(valor?: CatalogoCanales | null): void {
  cache = valor === undefined ? null : { en: Date.now(), valor };
}

// ─── Canal/productor registrado en la póliza (Sis2000, solo lectura) ───────

/** Lo que Sis2000 tiene en adpoliza (o adrecibos) de una póliza: la fuente de verdad. */
export interface EmisorPoliza {
  cnpoliza: string;
  ccanalalt: string | null;
  xcanalalt: string | null;
  cproductor: string | null;
  xproductor: string | null;
  cgestor: string | null;
}

const LOTE_POLIZAS = 50;

function texto(v: unknown, max: number): string | null {
  const s = v == null ? '' : String(v).trim();
  return s ? s.slice(0, max) : null;
}

/**
 * nest-api GET /api/v1/canal/polizas-emisor?cnpoliza=a,b,… (apikey de Nexus). Lotes de 50.
 * Nunca lanza: si nest-api no responde (o aún no tiene la ruta) devuelve lo que haya podido.
 * Solo devuelve pólizas encontradas; los ccanalalt/cproductor 0 o vacíos llegan como null.
 */
export async function emisoresDePolizas(
  cnpolizas: string[],
): Promise<Map<string, EmisorPoliza>> {
  const out = new Map<string, EmisorPoliza>();
  const { url, apiKey } = nestMailConfig();
  const lista = [...new Set(cnpolizas.map((p) => p.trim()).filter(Boolean))];
  if (!apiKey || !lista.length) return out;
  for (let i = 0; i < lista.length; i += LOTE_POLIZAS) {
    const lote = lista.slice(i, i + LOTE_POLIZAS);
    try {
      const res = await fetch(
        `${url}/api/v1/canal/polizas-emisor?cnpoliza=${encodeURIComponent(lote.join(','))}`,
        {
          headers: { Accept: 'application/json', apikey: apiKey },
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!res.ok) {
        logger.warn(`[expedientes] canal de pólizas en Sis2000: HTTP ${res.status}`);
        // 404: nest-api sin la ruta todavía; no tiene sentido seguir con los demás lotes.
        if (res.status === 404 || res.status === 403) break;
        continue;
      }
      const body = (await res.json().catch(() => ({}))) as { data?: unknown[] };
      for (const raw of Array.isArray(body.data) ? body.data : []) {
        const r = (raw ?? {}) as Record<string, unknown>;
        const cnpoliza = texto(r.cnpoliza, 64);
        if (!cnpoliza) continue;
        const canal = texto(r.ccanalalt, 32);
        const prod = texto(r.cproductor, 32);
        out.set(cnpoliza, {
          cnpoliza,
          ccanalalt: canal && canal !== '0' ? canal : null,
          xcanalalt: texto(r.xcanalalt, 120),
          cproductor: prod && prod !== '0' ? prod : null,
          xproductor: texto(r.xproductor, 150),
          cgestor: texto(r.cgestor, 50),
        });
      }
    } catch (err) {
      logger.warn(
        `[expedientes] canal de pólizas en Sis2000 no disponible: ${err instanceof Error ? err.name : 'error'}`,
      );
      break;
    }
  }
  return out;
}
