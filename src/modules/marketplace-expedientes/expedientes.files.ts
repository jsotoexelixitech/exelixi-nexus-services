/**
 * Enlace firmado del asegurado, carga multipart (sin dependencias nuevas) y
 * reenvío del archivo al endpoint interno del OCR, que es quien lo guarda.
 */
import { createHash, randomBytes } from 'crypto';
import { Readable, Transform } from 'stream';
import type { Request } from 'express';
import { AppError } from '../../utils/app-error';
import { ocrInternalConfig } from './expedientes.env';

// ─── Token del enlace ───────────────────────────────────────────────────────

/** 32 bytes aleatorios en base64url (43 caracteres). Solo se guarda el hash. */
export function generarToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Una cédula, un número de póliza o cualquier texto corto nunca pasa este filtro. */
export function formatoTokenValido(token: unknown): token is string {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token);
}

// ─── Archivos ───────────────────────────────────────────────────────────────

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_BODY_BYTES = MAX_FILE_BYTES + 1024 * 1024;

export interface ArchivoCargado {
  buffer: Buffer;
  filename: string;
  mimetype: 'image/jpeg' | 'image/png' | 'image/heic' | 'application/pdf';
  size: number;
}

const HEIC_BRANDS = new Set([
  'heic',
  'heix',
  'hevc',
  'hevx',
  'heim',
  'heis',
  'mif1',
  'msf1',
]);

/** Tipo real por firma (no se confía en el nombre ni en el content-type). */
export function detectarTipoArchivo(
  buf: Buffer,
): ArchivoCargado['mimetype'] | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)
    return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)
    return 'image/png';
  if (buf.subarray(0, 4).toString('latin1') === '%PDF')
    return 'application/pdf';
  if (buf.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = buf.subarray(8, 12).toString('latin1').toLowerCase();
    if (HEIC_BRANDS.has(brand)) return 'image/heic';
  }
  return null;
}

/**
 * Lee multipart/form-data con el parser nativo de Node (undici), con tope de
 * tamaño en el flujo. Devuelve el campo `file` y los campos de texto.
 */
export async function leerMultipart(
  req: Request,
): Promise<{ file: ArchivoCargado; fields: Record<string, string> }> {
  const ctype = String(req.headers['content-type'] ?? '');
  if (!ctype.toLowerCase().startsWith('multipart/form-data')) {
    throw new AppError('Envíe el archivo como multipart/form-data.', 400);
  }
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > MAX_BODY_BYTES) {
    throw new AppError('El archivo supera el máximo de 25 MB.', 413);
  }

  let total = 0;
  let excedido = false;
  const limiter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        excedido = true;
        cb(new Error('limite'));
        return;
      }
      cb(null, chunk);
    },
  });
  const body = Readable.toWeb(req.pipe(limiter)) as unknown as ReadableStream;

  let form: FormData;
  try {
    const webReq = new Request('http://localhost/upload', {
      method: 'POST',
      headers: { 'content-type': ctype },
      body,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    form = await webReq.formData();
  } catch {
    if (excedido)
      throw new AppError('El archivo supera el máximo de 25 MB.', 413);
    throw new AppError('No se pudo leer el archivo enviado.', 400);
  }

  const fields: Record<string, string> = {};
  let file: File | null = null;
  form.forEach((value, key) => {
    if (typeof value === 'string') {
      if (value.length <= 200) fields[key] = value;
    } else if (key === 'file' && !file) {
      file = value as File;
    }
  });
  if (!file) throw new AppError('Falta el archivo (campo file).', 400);
  const f = file as File;
  if (f.size === 0) throw new AppError('El archivo está vacío.', 400);
  if (f.size > MAX_FILE_BYTES) {
    throw new AppError('El archivo supera el máximo de 25 MB.', 413);
  }
  const buffer = Buffer.from(await f.arrayBuffer());
  const mimetype = detectarTipoArchivo(buffer);
  if (!mimetype) {
    throw new AppError('Formato no permitido. Use JPG, PNG, HEIC o PDF.', 415);
  }
  const filename =
    String(f.name || 'documento')
      .replace(/[^\w.\- ]/g, '_')
      .slice(0, 120) || 'documento';
  return { file: { buffer, filename, mimetype, size: buffer.length }, fields };
}

// ─── OCR interno ────────────────────────────────────────────────────────────

export interface OcrDocumentoResultado {
  ref: string | null;
  /** 'poliza' = carpeta de la póliza; 'pendiente' = carpeta temporal del OCR. */
  ubicacion: string | null;
  ocr: {
    extraido?: Record<string, unknown>;
    /** 0 | 0.5 | 1 */
    confianza?: number;
    motivo?: string;
    proveedor?: string;
  } | null;
}

export class OcrNoConfiguradoError extends Error {
  constructor() {
    super('OCR_INTERNAL_URL / EXPEDIENTE_INTERNAL_KEY no configurados');
  }
}

/** 400 / 413 / 422 del OCR: el archivo es el problema (se informa al usuario). */
export class OcrRechazoError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function mensajeOcr(body: Record<string, unknown>, fallback: string): string {
  const m = body.message ?? body.error;
  return typeof m === 'string' && m.trim() ? m.trim().slice(0, 200) : fallback;
}

/**
 * POST {OCR_INTERNAL_URL}/api/internal/expedientes/documento
 * multipart: file, tipo, cnpoliza, cnrecibo, documento, empresaId, empresaNombre?
 * header x-expediente-key. Responde { ok, ref, ubicacion, ocr: { extraido, confianza, motivo?, proveedor } }.
 * Errores: 401 / 503 (sin clave) = técnicos; 400 / 413 / 422 = archivo rechazado.
 * La lectura puede tardar decenas de segundos: timeout 90 s.
 */
export async function enviarDocumentoAlOcr(params: {
  file: ArchivoCargado;
  tipo: string;
  cnpoliza: string;
  cnrecibo?: string | null;
  documento?: string | null;
  empresaId: number;
  empresaNombre?: string | null;
}): Promise<OcrDocumentoResultado> {
  const cfg = ocrInternalConfig();
  if (!cfg) throw new OcrNoConfiguradoError();
  const form = new FormData();
  form.append(
    'file',
    new Blob([new Uint8Array(params.file.buffer)], {
      type: params.file.mimetype,
    }),
    params.file.filename,
  );
  form.append('tipo', params.tipo);
  form.append('cnpoliza', params.cnpoliza);
  form.append('cnrecibo', params.cnrecibo ?? '');
  form.append('documento', params.documento ?? '');
  form.append('empresaId', String(params.empresaId));
  if (params.empresaNombre) form.append('empresaNombre', params.empresaNombre);

  const res = await fetch(`${cfg.url}/api/internal/expedientes/documento`, {
    method: 'POST',
    headers: { 'x-expediente-key': cfg.key, Accept: 'application/json' },
    body: form,
    signal: AbortSignal.timeout(90_000),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.status === 413) {
    throw new OcrRechazoError(413, 'El archivo supera el máximo de 25 MB.');
  }
  if (res.status === 400 || res.status === 422) {
    throw new OcrRechazoError(
      res.status,
      mensajeOcr(body, 'El documento no es válido. Intente con otra imagen.'),
    );
  }
  if (!res.ok || body.ok === false) {
    throw new Error(`OCR respondió HTTP ${res.status}`);
  }
  const ocr =
    body.ocr && typeof body.ocr === 'object'
      ? (body.ocr as OcrDocumentoResultado['ocr'])
      : null;
  return {
    ref: typeof body.ref === 'string' ? body.ref : null,
    ubicacion: typeof body.ubicacion === 'string' ? body.ubicacion : null,
    ocr,
  };
}
