/**
 * Reenlazar por huella (monitor de expedientes, 24-nov-2026).
 *
 * Busca filas cuyo archivo actual ya no tiene la huella analizada y cuyo original exacto existe en
 * otra ruta de la carpeta de uploads del OCR; copia (sin sobrescribir) a la carpeta de la póliza o a
 * su pendiente/ y actualiza ref/analisisRef. Nunca borra ni mueve. Sin correos ni IA.
 *
 *   Vista previa (por defecto, no escribe nada):
 *     npx tsx scripts/reenlazar-por-huella.ts <carpeta-uploads-del-OCR>
 *   Aplicar:
 *     npx tsx scripts/reenlazar-por-huella.ts <carpeta-uploads-del-OCR> --aplicar
 *
 * <carpeta-uploads-del-OCR> es el EXPEDIENTES_ROOT del OCR (ruta por argumento, nunca por .env).
 */
import prisma from '../src/config/prisma';
import { reenlazarPorHuella } from '../src/modules/marketplace-expedientes/expedientes.reenlazar';
import { expedientesService } from '../src/modules/marketplace-expedientes/expedientes.service';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const aplicar = args.includes('--aplicar');
  const root = args.find((a) => !a.startsWith('--'));
  if (!root) {
    console.error(
      'Uso: npx tsx scripts/reenlazar-por-huella.ts <carpeta-uploads-del-OCR> [--aplicar]',
    );
    process.exitCode = 2;
    return;
  }
  const r = await reenlazarPorHuella({
    root,
    aplicar,
    actor: 'script:reenlazar-por-huella',
    contextoDe: (e) => expedientesService.contextoDe(e as never),
  });
  const { detalle, ...cifras } = r;
  console.log(JSON.stringify(cifras, null, 2));
  console.log(
    aplicar
      ? 'Aplicado. Detalle por fila (sin datos personales):'
      : 'VISTA PREVIA: no se copió ni se escribió nada. Detalle por fila:',
  );
  for (const d of detalle)
    console.log(
      `req=${d.requisitoId} exp=${d.expedienteId} tipo=${d.tipo} huella=${d.hash8} -> ${d.accion}${d.destino ? ` ${d.destino}` : ''}`,
    );
}

main()
  .catch((err) => {
    console.error('Error:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
