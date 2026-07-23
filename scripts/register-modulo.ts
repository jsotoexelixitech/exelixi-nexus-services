/**
 * Alta idempotente de módulo + submódulo en BD Nexus (sin pasar por Admin UI).
 *
 * Uso:
 *   npm run register-modulo -- --modulo "Mi Módulo" --submodulo "Web" --url "https://..."
 *
 * Requiere DATABASE_URL en .env (mismo entorno que nexus-api).
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = argv[i + 1];
      if (val && !val.startsWith('--')) {
        out[key] = val;
        i++;
      }
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const moduloNombre = args.modulo?.trim();
  const submoduloNombre = args.submodulo?.trim();
  const submoduloUrl = args.url?.trim() || null;

  if (!moduloNombre || !submoduloNombre) {
    console.error(
      'Uso: npm run register-modulo -- --modulo "Nombre" --submodulo "Sub" [--url "https://..."]',
    );
    process.exit(1);
  }

  let modulo = await prisma.modulo.findFirst({
    where: { nombre: moduloNombre },
  });

  if (!modulo) {
    modulo = await prisma.modulo.create({
      data: { nombre: moduloNombre, activo: true },
    });
    console.log(`Módulo creado id=${modulo.id} nombre="${modulo.nombre}"`);
  } else {
    console.log(`Módulo existente id=${modulo.id} nombre="${modulo.nombre}"`);
  }

  let submodulo = await prisma.submodulo.findFirst({
    where: { moduloId: modulo.id, nombre: submoduloNombre },
  });

  if (!submodulo) {
    submodulo = await prisma.submodulo.create({
      data: {
        nombre: submoduloNombre,
        url: submoduloUrl,
        activo: true,
        moduloId: modulo.id,
      },
    });
    console.log(
      `Submódulo creado id=${submodulo.id} url=${submodulo.url ?? '(null)'}`,
    );
  } else {
    if (submoduloUrl && submodulo.url !== submoduloUrl) {
      submodulo = await prisma.submodulo.update({
        where: { id: submodulo.id },
        data: { url: submoduloUrl },
      });
      console.log(`Submódulo id=${submodulo.id} URL actualizada`);
    } else {
      console.log(`Submódulo existente id=${submodulo.id}`);
    }
  }

  console.log('\n--- Datos para integración ---');
  console.log(`NEXUS_EXPECTED_SUBMODULO_IDS=${submodulo.id}`);
  console.log(`Submódulo: ${submodulo.nombre} (módulo "${modulo.nombre}")`);
  if (submodulo.url) console.log(`URL: ${submodulo.url}`);
  console.log('Siguiente: Empresas → activar módulo/submódulo por tenant.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
