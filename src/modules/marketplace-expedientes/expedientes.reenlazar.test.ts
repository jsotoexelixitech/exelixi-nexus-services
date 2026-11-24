/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Reenlazar por huella: copia sin pisar el original exacto a la carpeta de la póliza o su pendiente/
 * y actualiza ref/analisisRef. Vista previa por defecto; solo si la lectura es de la póliza.
 */
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/prisma', async () => {
  const { createFakePrisma } = await import('./test-utils/fake-prisma');
  return { default: createFakePrisma() };
});
vi.mock('../../utils/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import prisma from '../../config/prisma';
import { reenlazarPorHuella } from './expedientes.reenlazar';

const db = prisma as any;
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const ORIGINAL = Buffer.from('cedula-original-de-ramon');
const OTRO = Buffer.from('archivo-de-otra-persona');
const H = sha(ORIGINAL);

let root: string;
const escribir = (rel: string, b: Buffer) => {
  const abs = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, b);
};
const listar = (dir = root): string[] =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory()
        ? listar(path.join(dir, e.name))
        : [path.relative(root, path.join(dir, e.name)).split(path.sep).join('/')],
    )
    .sort();

const LECTURA_RAMON = {
  documentoTipo: 'cedula',
  tipoDoc: 'V',
  identificacion: '17671805',
  nombre: 'RAMON',
};

async function fila(
  id: number,
  ref: string,
  lectura: Record<string, unknown> = LECTURA_RAMON,
  documento = '17671805',
) {
  await db.mktExpediente.create({
    data: {
      id,
      empresaId: 7,
      cnpoliza: `P-${id}`,
      producto: 'personas',
      aseguradoTipoDoc: 'V',
      aseguradoDocumento: documento,
      snapshot: { asegurado: { tipoDoc: 'V', documento, nombre: 'RAMON' } },
      emitidaEn: new Date(),
    },
  });
  return db.mktExpedienteRequisito.create({
    data: {
      expedienteId: id,
      tipo: 'cedula',
      estado: 'validado',
      decision: 'ia',
      ref,
      analisisRef: ref,
      archivoHash: H,
      ocrDatos: lectura,
      diagnostico: { resultado: 'coincide' },
    },
  });
}
const req = (id: number) =>
  db.mktExpedienteRequisito._rows().find((r: any) => r.expedienteId === id);

beforeEach(() => {
  db.$reset();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'reenlazar-'));
  // Archivo actual = de otra persona; original exacto en otra ruta.
  escribir('LM/17671805/pendiente/cedula.pdf', OTRO);
  escribir('LM/99999999/pendiente/cedula.pdf', ORIGINAL);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('reenlazar por huella', () => {
  it('vista previa: no copia ni escribe nada', async () => {
    await fila(1, '/files/LM/17671805/pendiente/cedula.pdf');
    const antes = listar();
    const r = await reenlazarPorHuella({ root, aplicar: false });
    expect(r.candidatas).toBe(1);
    expect(r.conOriginal).toBe(1);
    expect(r.reenlazadas).toBe(0);
    expect(listar()).toEqual(antes);
    expect(req(1).ref).toBe('/files/LM/17671805/pendiente/cedula.pdf');
    expect(db.mktExpedienteEvento._rows()).toHaveLength(0);
  });

  it('aplica: copia sin pisar a su pendiente/, actualiza ref/analisisRef y deja evento', async () => {
    await fila(1, 'https://h.test/ocr/files/LM/17671805/pendiente/cedula.pdf');
    const r = await reenlazarPorHuella({ root, aplicar: true });
    expect(r.reenlazadas).toBe(1);
    const nuevo = req(1).ref as string;
    expect(nuevo.startsWith('LM/17671805/pendiente/cedula-')).toBe(true);
    expect(req(1).analisisRef).toBe(nuevo);
    expect(sha(fs.readFileSync(path.join(root, ...nuevo.split('/'))))).toBe(H);
    // Nunca borra ni mueve ni pisa: el archivo ajeno y el original siguen.
    expect(fs.readFileSync(path.join(root, 'LM/17671805/pendiente/cedula.pdf'))).toEqual(OTRO);
    expect(fs.readFileSync(path.join(root, 'LM/99999999/pendiente/cedula.pdf'))).toEqual(ORIGINAL);
    expect(req(1).estado).toBe('validado');
    expect(db.mktExpedienteEvento._rows()[0].tipo).toBe('documento_reenlazado');
    // Idempotente: otra pasada no tiene nada que hacer.
    const r2 = await reenlazarPorHuella({ root, aplicar: true });
    expect(r2.candidatas).toBe(0);
  });

  it('usa la carpeta de la póliza si existe', async () => {
    escribir('LM/17671805/2321234-26-11-1100015737/licencia.pdf', Buffer.from('x'));
    await fila(1, 'LM/17671805/pendiente/cedula.pdf');
    await db.mktExpediente.update({
      where: { id: 1 },
      data: { carpetaExpediente: 'LM/17671805/2321234-26-11-1100015737' },
    });
    const r = await reenlazarPorHuella({ root, aplicar: true });
    expect(r.reenlazadas).toBe(1);
    expect(req(1).ref.startsWith('LM/17671805/2321234-26-11-1100015737/cedula-')).toBe(true);
  });

  it('si la lectura propia no es de la póliza, no reenlaza', async () => {
    await fila(1, 'LM/17671805/pendiente/cedula.pdf', {
      ...LECTURA_RAMON,
      identificacion: '11111111',
    });
    const r = await reenlazarPorHuella({ root, aplicar: true });
    expect(r.lecturaNoEsDeLaPoliza).toBe(1);
    expect(r.reenlazadas).toBe(0);
    expect(listar()).toHaveLength(2);
  });

  it('sin original en el disco: no hace nada', async () => {
    fs.rmSync(path.join(root, 'LM/99999999'), { recursive: true });
    await fila(1, 'LM/17671805/pendiente/cedula.pdf');
    const r = await reenlazarPorHuella({ root, aplicar: true });
    expect(r.sinOriginal).toBe(1);
    expect(req(1).ref).toBe('LM/17671805/pendiente/cedula.pdf');
  });

  it('si el archivo actual ya tiene la huella analizada, no es candidata', async () => {
    escribir('LM/17671805/pendiente/cedula.pdf', ORIGINAL);
    await fila(1, 'LM/17671805/pendiente/cedula.pdf');
    const r = await reenlazarPorHuella({ root, aplicar: true });
    expect(r.archivoCoincide).toBe(1);
    expect(r.candidatas).toBe(0);
  });
});
