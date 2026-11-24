/**
 * Alta de intermediarios (maproduc) en el login Nexus del portal.
 * Lee el JSON exportado de DBeaver. No copia la clave de seusuariosweb.
 *
 *   npx tsx scripts/import-intermediarios-portal.ts --json "C:\ruta\archivo.json" --empresa 1 --rol 2
 *   npx tsx scripts/import-intermediarios-portal.ts --json "C:\ruta\archivo.json" --empresa 1 --rol 2 --apply
 *
 * Clave inicial de los nuevos: variable IMPORT_PASSWORD (obligatoria con --apply).
 * Quien ya existe conserva su clave y se actualiza el perfil de canal.
 */
import { readFileSync } from 'fs';
import * as bcrypt from 'bcrypt';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

type Row = Record<string, unknown>;

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const val = argv[i + 1];
    if (val && !val.startsWith('--')) {
      out[key] = val;
      i++;
    } else {
      out[key] = 'true';
    }
  }
  return out;
}

function text(row: Row, key: string): string {
  const v = row[key];
  if (v == null) return '';
  return String(v).replace(/\s+/g, ' ').trim();
}

function emailOf(row: Row): string {
  return (text(row, 'xcorreo_web') || text(row, 'xcorreo_gestor') || text(row, 'xcorreo'))
    .toLowerCase();
}

function loadRows(path: string): Row[] {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (Array.isArray(raw)) return raw as Row[];
  if (raw && typeof raw === 'object') {
    const first = Object.values(raw as Record<string, unknown>)[0];
    if (Array.isArray(first)) return first as Row[];
  }
  throw new Error('El JSON no trae la lista de intermediarios.');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apply = args.apply === 'true';
  const jsonPath = args.json;
  if (!jsonPath) throw new Error('Falta --json con la ruta del archivo.');

  const empresaId = Number(args.empresa);
  const roleId = Number(args.rol);
  if (!empresaId || !roleId) {
    const empresas = await prisma.empresa.findMany({
      select: { id: true, nombre: true, activo: true },
      orderBy: { id: 'asc' },
    });
    const roles = await prisma.role.findMany({
      select: { id: true, nombre: true, empresaId: true, activo: true },
      orderBy: { id: 'asc' },
    });
    console.log(JSON.stringify({ empresas, roles }, null, 2));
    throw new Error('Indica --empresa y --rol de la lista de arriba.');
  }

  const role = await prisma.role.findFirst({
    where: { id: roleId, empresaId, activo: true },
  });
  if (!role) throw new Error('El rol no pertenece a esa empresa o está inactivo.');

  const password = process.env.IMPORT_PASSWORD?.trim() ?? '';
  if (apply && password.length < 8) {
    throw new Error('Con --apply define IMPORT_PASSWORD de al menos 8 caracteres.');
  }

  const rows = loadRows(jsonPath);
  const seen = new Set<string>();
  let sinCorreo = 0;
  let duplicado = 0;
  let creados = 0;
  let actualizados = 0;

  for (const row of rows) {
    const cproductor = text(row, 'cproductor');
    const email = emailOf(row);
    if (!cproductor || !email || !email.includes('@')) {
      sinCorreo += 1;
      continue;
    }
    if (seen.has(email)) {
      duplicado += 1;
      continue;
    }
    seen.add(email);

    const nombre = text(row, 'xproductor') || `Productor ${cproductor}`;
    const cusuarioWeb = text(row, 'cusuario');
    const perfil = {
      resolverGestorPorEmail: false,
      centidad: 'P',
      citem: cproductor,
      cproductor,
      cusuario: cusuarioWeb || null,
      cgestor: text(row, 'cgestor') || cproductor,
      ccanalaltIn: null,
      cscanalaltIn: null,
    };

    const existing = await prisma.usuario.findUnique({ where: { email } });
    if (!apply) continue;

    const user = existing
      ? await prisma.usuario.update({
          where: { id: existing.id },
          data: { nombre: nombre.slice(0, 250), activo: true, roleId, empresaId },
        })
      : await prisma.usuario.create({
          data: {
            email,
            nombre: nombre.slice(0, 250),
            password: await bcrypt.hash(password, 10),
            empresaId,
            roleId,
            activo: true,
          },
        });

    await prisma.usuarioPortalPerfil.upsert({
      where: { usuarioId: user.id },
      create: { usuarioId: user.id, ...perfil },
      update: perfil,
    });

    if (existing) actualizados += 1;
    else creados += 1;
  }

  const listos = seen.size;
  console.log(
    JSON.stringify(
      {
        modo: apply ? 'apply' : 'vista_previa',
        filas: rows.length,
        conCorreo: listos,
        sinCorreo,
        correoRepetido: duplicado,
        creados,
        actualizados,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
