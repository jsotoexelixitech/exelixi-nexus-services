/**
 * Reenlazar por huella (24-nov-2026, punto 1b). Lógica del script `scripts/reenlazar-por-huella.ts`.
 *
 * Hay filas cuyo archivo actual (`ref`) ya no tiene la huella del archivo que se analizó
 * (`archivoHash`) pero cuyo original exacto sigue en otra ruta de la carpeta de uploads del OCR.
 * Aquí se copia ese original a la carpeta de la póliza (o a su `pendiente/`) y se actualizan `ref` y
 * `analisisRef` de la fila.
 *
 * Reglas:
 * - SOLO si la lectura propia de la fila (ocrDatos con analisisRef === ref) pertenece a esa póliza
 *   (`archivoEsDeLaPoliza === true`). Si esa lectura es el RIF jurídico del tomador no se reenlaza:
 *   lo cubre el RIF compartido.
 * - Copia SIN sobrescribir (COPYFILE_EXCL) con nombre único. Nunca borra ni mueve nada.
 * - Actualiza de forma condicional (mismo ref, analisisRef y huella) y deja un evento. No cambia
 *   estados ni decisiones. Quita la marca informativa de archivo cambiado, si la hubiera.
 * - Sin correos, sin IA. Vista previa por defecto: no copia ni escribe.
 * - Las rutas `ref` vienen con y sin `/files/` y con o sin host (misma lógica que `claveArchivo`, sin bajar a minúsculas porque en disco importan).
 */
import { createHash } from 'crypto';
import {
  constants as fsc,
  createReadStream,
  promises as fs,
  type Dirent,
} from 'fs';
import path from 'path';
import type { Prisma } from '@prisma/client';
import prisma from '../../config/prisma';
import type { ContextoPoliza } from './expedientes.ia';
import {
  archivoEsDeLaPoliza,
  contextoPoliza,
  lecturaEsRifDelTomador,
} from './expedientes.ia';

export const EVENTO_REENLAZADO = 'documento_reenlazado';
const TOPE_BYTES = 60 * 1024 * 1024;

export interface OpcionesReenlazar {
  /** Carpeta de uploads del OCR (EXPEDIENTES_ROOT). */
  root: string;
  aplicar: boolean;
  actor?: string;
  /** Contexto de la póliza; por defecto, el del snapshot del expediente. */
  contextoDe?: (exp: ExpedienteMin) => Promise<ContextoPoliza>;
}

export interface ExpedienteMin {
  id: number;
  producto: string;
  snapshot?: unknown;
  aseguradoTipoDoc?: string | null;
  aseguradoDocumento?: string | null;
  aseguradoNombre?: string | null;
  aseguradoApellido?: string | null;
  carpetaExpediente?: string | null;
}

export interface ResumenReenlace {
  aplicar: boolean;
  filasRevisadas: number;
  archivoCoincide: number;
  /** Candidatas: el archivo actual no tiene la huella analizada. */
  candidatas: number;
  conOriginal: number;
  sinOriginal: number;
  lecturaNoEsDeLaPoliza: number;
  esRifDelTomador: number;
  sinDestino: number;
  reenlazadas: number;
  errores: number;
  /** Detalle sin datos personales. */
  detalle: {
    requisitoId: number;
    expedienteId: number;
    tipo: string;
    hash8: string;
    accion: string;
    destino?: string;
  }[];
}

// ─── Disco ──────────────────────────────────────────────────────────────────

/**
 * Ruta del ref relativa a la carpeta de uploads, CONSERVANDO mayúsculas (en disco importan; la
 * `claveArchivo` del monitor las baja para comparar). Quita host, /ocr y /files/ y decodifica.
 */
export function refRelativa(ref: string): string {
  let s = ref.trim();
  try {
    if (/^https?:\/\//i.test(s)) s = new URL(s).pathname;
  } catch {
    /* se usa tal cual */
  }
  const i = s.indexOf('/files/');
  if (i >= 0) s = s.slice(i + '/files/'.length);
  try {
    s = decodeURIComponent(s);
  } catch {
    /* se usa tal cual */
  }
  return s.replace(/^\/+/, '');
}


function hashArchivo(abs: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(abs)
      .on('error', reject)
      .on('data', (c) => h.update(c))
      .on('end', () => resolve(h.digest('hex')));
  });
}

/** Ruta relativa segura dentro de root (sin .., sin absolutas); null si no vale. */
export function relSegura(root: string, rel: string): string | null {
  const limpio = rel.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!limpio || limpio.includes('\0')) return null;
  const abs = path.resolve(root, limpio);
  const r = path.relative(path.resolve(root), abs);
  if (!r || r.startsWith('..') || path.isAbsolute(r)) return null;
  return r.split(path.sep).join('/');
}

async function esArchivoNormal(abs: string): Promise<boolean> {
  try {
    const st = await fs.lstat(abs);
    return st.isFile() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

/** Índice huella → rutas relativas de todos los archivos de la carpeta (sin enlaces). */
export async function indexarPorHuella(
  root: string,
): Promise<Map<string, string[]>> {
  const idx = new Map<string, string[]>();
  async function recorrer(dir: string): Promise<void> {
    let ents: Dirent[];
    try {
      ents = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const abs = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) await recorrer(abs);
      else if (e.isFile()) {
        try {
          if ((await fs.stat(abs)).size > TOPE_BYTES) continue;
          const h = await hashArchivo(abs);
          const rel = path.relative(root, abs).split(path.sep).join('/');
          const l = idx.get(h) ?? [];
          l.push(rel);
          idx.set(h, l);
        } catch {
          /* ilegible: se ignora */
        }
      }
    }
  }
  await recorrer(path.resolve(root));
  for (const l of idx.values()) l.sort();
  return idx;
}

/** Copia sin sobrescribir con nombre único; si ya existe el mismo contenido, lo reutiliza. */
async function copiarSinPisar(
  rootAbs: string,
  origenRel: string,
  dirDestinoRel: string,
  base: string,
  ext: string,
  hash: string,
): Promise<string> {
  const origen = path.join(rootAbs, origenRel);
  await fs.mkdir(path.join(rootAbs, dirDestinoRel), { recursive: true });
  for (let n = 0; n < 50; n++) {
    const nombre = `${base}${n ? `-${n + 1}` : ''}${ext}`;
    const rel = `${dirDestinoRel}/${nombre}`;
    const destino = path.join(rootAbs, rel);
    try {
      await fs.copyFile(origen, destino, fsc.COPYFILE_EXCL);
      return rel;
    } catch (err) {
      if ((err as { code?: string }).code !== 'EEXIST') throw err;
      // Ya hay un archivo con ese nombre: si es el mismo contenido, sirve (idempotente).
      if ((await hashArchivo(destino).catch(() => '')) === hash) return rel;
    }
  }
  throw new Error('No se encontró un nombre libre.');
}

// ─── Lógica ─────────────────────────────────────────────────────────────────

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

export async function reenlazarPorHuella(
  opts: OpcionesReenlazar,
): Promise<ResumenReenlace> {
  const rootAbs = path.resolve(opts.root);
  const actor = (opts.actor ?? 'reenlazar_huella').slice(0, 128);
  const r: ResumenReenlace = {
    aplicar: opts.aplicar,
    filasRevisadas: 0,
    archivoCoincide: 0,
    candidatas: 0,
    conOriginal: 0,
    sinOriginal: 0,
    lecturaNoEsDeLaPoliza: 0,
    esRifDelTomador: 0,
    sinDestino: 0,
    reenlazadas: 0,
    errores: 0,
    detalle: [],
  };
  const filas = await prisma.mktExpedienteRequisito.findMany({
    where: {
      AND: [
        { ref: { not: null } },
        { archivoHash: { not: null } },
        { analisisRef: { not: null } },
      ],
    },
  });
  const propias = (filas as unknown as RequisitoMin[]).filter(
    (f) =>
      f.ref && f.analisisRef === f.ref && f.archivoHash && f.ocrDatos,
  );
  // 1. ¿El archivo actual conserva la huella analizada?
  const candidatas: RequisitoMin[] = [];
  for (const f of propias) {
    r.filasRevisadas++;
    const rel = relSegura(rootAbs, refRelativa(f.ref as string));
    let coincide = false;
    if (rel) {
      const abs = path.join(rootAbs, rel);
      if (await esArchivoNormal(abs))
        coincide = (await hashArchivo(abs).catch(() => '')) === f.archivoHash;
    }
    if (coincide) r.archivoCoincide++;
    else candidatas.push(f);
  }
  r.candidatas = candidatas.length;
  if (!candidatas.length) return r;

  const indice = await indexarPorHuella(rootAbs);
  const exps = new Map(
    (
      (await prisma.mktExpediente.findMany({
        where: { id: { in: [...new Set(candidatas.map((c) => c.expedienteId))] } },
      })) as unknown as ExpedienteMin[]
    ).map((e) => [e.id, e]),
  );
  for (const f of candidatas) {
    const hash8 = (f.archivoHash as string).slice(0, 8);
    const det = (accion: string, destino?: string) =>
      r.detalle.push({
        requisitoId: f.id,
        expedienteId: f.expedienteId,
        tipo: f.tipo,
        hash8,
        accion,
        ...(destino ? { destino } : {}),
      });
    const exp = exps.get(f.expedienteId);
    if (!exp) continue;
    const refActualRel = relSegura(rootAbs, refRelativa(f.ref as string));
    const originales = (indice.get(f.archivoHash as string) ?? []).filter(
      (p) => p !== refActualRel,
    );
    if (!originales.length) {
      r.sinOriginal++;
      det('sin_original');
      continue;
    }
    r.conOriginal++;
    // La lectura propia debe ser de esta póliza; el RIF del tomador lo cubre el RIF compartido.
    const ctx = await (opts.contextoDe ?? (async (e) => contextoPoliza(e)))(exp);
    const lectura = rec(f.ocrDatos);
    if (lecturaEsRifDelTomador(lectura, ctx)) {
      r.esRifDelTomador++;
      det('rif_del_tomador_lo_cubre_el_rif_compartido');
      continue;
    }
    if (archivoEsDeLaPoliza(lectura, ctx) !== true) {
      r.lecturaNoEsDeLaPoliza++;
      det('lectura_no_es_de_la_poliza');
      continue;
    }
    // Destino: carpeta de la póliza o, si no hay, su pendiente/.
    const dirDestino = await destinoDe(rootAbs, exp, refRelativa(f.ref as string));
    if (!dirDestino) {
      r.sinDestino++;
      det('sin_destino');
      continue;
    }
    // Si el original ya está en el destino, solo se reenlaza (sin copiar).
    const origen = originales.find((p) => path.posix.dirname(p) === dirDestino) ?? originales[0];
    if (!opts.aplicar) {
      det('se_reenlazaria', `${dirDestino}/…`);
      continue;
    }
    try {
      const ext = path.posix.extname(origen);
      const nuevaRel =
        path.posix.dirname(origen) === dirDestino
          ? origen
          : await copiarSinPisar(
              rootAbs,
              origen,
              dirDestino,
              `${f.tipo}-${hash8}`,
              ext,
              f.archivoHash as string,
            );
      const diag = { ...rec(f.diagnostico) };
      delete diag.archivoCambiado;
      const upd = await prisma.mktExpedienteRequisito.updateMany({
        where: {
          id: f.id,
          ref: f.ref,
          analisisRef: f.analisisRef,
          archivoHash: f.archivoHash,
        },
        data: {
          ref: nuevaRel,
          analisisRef: nuevaRel,
          ...(f.diagnostico ? { diagnostico: diag as Prisma.InputJsonValue } : {}),
        },
      });
      if (upd.count === 1) {
        r.reenlazadas++;
        det('reenlazada', nuevaRel);
        await prisma.mktExpedienteEvento.create({
          data: {
            expedienteId: f.expedienteId,
            tipo: EVENTO_REENLAZADO,
            actor,
            detalle: {
              tipo: f.tipo,
              refAnterior: f.ref,
              refNuevo: nuevaRel,
              hash8,
              motivo: 'El archivo guardado ya no era el analizado; se reenlazó el original exacto por huella.',
            } as Prisma.InputJsonValue,
          },
        });
      }
    } catch (err) {
      r.errores++;
      det(`error:${(err as { code?: string }).code ?? 'desconocido'}`);
    }
  }
  return r;
}

interface RequisitoMin {
  id: number;
  expedienteId: number;
  tipo: string;
  ref: string | null;
  analisisRef: string | null;
  archivoHash: string | null;
  ocrDatos: unknown;
  diagnostico: unknown;
}

/** Carpeta de la póliza (si existe) o su pendiente/. Relativa a root, sin barra final. */
async function destinoDe(
  rootAbs: string,
  exp: ExpedienteMin,
  refActualClave: string,
): Promise<string | null> {
  const carpeta = exp.carpetaExpediente
    ? relSegura(rootAbs, refRelativa(exp.carpetaExpediente))
    : null;
  if (carpeta) {
    try {
      const st = await fs.lstat(path.join(rootAbs, carpeta));
      if (st.isDirectory() && !st.isSymbolicLink()) return carpeta;
    } catch {
      /* no existe: se busca el pendiente */
    }
  }
  // pendiente/: el de la ruta actual si ya es de pendiente; si no, el de la cédula de la póliza.
  const actual = relSegura(rootAbs, refActualClave);
  if (actual && /(^|\/)pendiente\//.test(actual))
    return path.posix.dirname(actual);
  if (carpeta) return `${path.posix.dirname(carpeta)}/pendiente`;
  return null;
}
