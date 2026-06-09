const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const modulos = await prisma.modulo.findMany({ include: { submodulos: true } });
  
  for (const modulo of modulos) {
    const isFunerario = modulo.nombre.toLowerCase().includes('funerario');
    
    for (const sub of modulo.submodulos) {
      let baseUrl = sub.url;
      if (!baseUrl) continue;
      
      // Limpiar '?product=funerario' si ya lo tuviera para no duplicarlo
      baseUrl = baseUrl.split('?')[0];

      // Si el módulo padre es Funerario, le inyectamos el query param a todas sus URLs
      if (isFunerario) {
        baseUrl = baseUrl + '?product=funerario';
      }
      
      await prisma.submodulo.update({
        where: { id: sub.id },
        data: { url: baseUrl }
      });
      console.log(`✅ [${modulo.nombre}] ${sub.nombre} -> ${baseUrl}`);
    }
  }
}

main().finally(() => prisma.$disconnect());
