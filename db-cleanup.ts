import { PrismaClient } from '@prisma/client';
import * as dotenv from 'dotenv';
dotenv.config();

console.log(
  'DATABASE_URL configurado:',
  process.env.DATABASE_URL?.replace(/:([^:@]+)@/, ':****@'),
);

const prisma = new PrismaClient();

async function main() {
  console.log('Obteniendo módulos actuales de la base de datos...');
  const modulos = await prisma.modulo.findMany();
  console.log('Módulos encontrados:', modulos.map((m) => m.nombre).join(', '));

  for (const mod of modulos) {
    const nombreLower = mod.nombre.toLowerCase();

    // 1. Corregir "autocasa" o "auto-casa" a "Auto-Casco"
    if (
      nombreLower.includes('auto-casa') ||
      nombreLower.includes('autocasa') ||
      nombreLower === 'auto casco'
    ) {
      await prisma.modulo.update({
        where: { id: mod.id },
        data: { nombre: 'Auto-Casco' },
      });
      console.log(`✏️ Renombrado: "${mod.nombre}" -> "Auto-Casco"`);
    }
    // 2. Mantener RCV, Funerario y el recién renombrado Auto-Casco
    else if (
      nombreLower.includes('rcv') ||
      nombreLower.includes('funerar') ||
      nombreLower.includes('auto-casco')
    ) {
      console.log(`✅ Mantenido: "${mod.nombre}"`);
    }
    // 3. Eliminar todo lo demás (Ventas, Inventario, etc.)
    else {
      console.log(
        `🗑️ Eliminando módulo: "${mod.nombre}" y sus dependencias...`,
      );

      // Eliminar submódulos
      await prisma.submodulo.deleteMany({ where: { moduloId: mod.id } });

      // Eliminar permisos asociados a este módulo en cada empresa
      const empresaModulos = await prisma.empresaModulo.findMany({
        where: { moduloId: mod.id },
      });
      for (const em of empresaModulos) {
        await prisma.permission.deleteMany({
          where: { empresaModuloId: em.id },
        });
      }

      // Eliminar empresaModulo
      await prisma.empresaModulo.deleteMany({ where: { moduloId: mod.id } });

      // Eliminar el módulo en sí
      await prisma.modulo.delete({ where: { id: mod.id } });
    }
  }

  console.log('\n¡Limpieza completada! Base de datos actualizada.');
}

main()
  .catch(console.error)
  .finally(async () => {
    await prisma.$disconnect();
  });
