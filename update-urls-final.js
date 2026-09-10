const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const submodulos = await prisma.submodulo.findMany();
  for (const sub of submodulos) {
    const nombre = sub.nombre.toLowerCase();
    
    // OCR = 5181
    if (nombre.includes('ocr')) {
      await prisma.submodulo.update({
        where: { id: sub.id },
        data: { url: 'http://192.168.8.120:5181' },
      });
      console.log('✅ ' + sub.nombre + ' -> actualizado a puerto 5181');
    }
    
    // FORMULARIO = 5182
    if (nombre.includes('formulario')) {
      await prisma.submodulo.update({
        where: { id: sub.id },
        data: { url: 'http://192.168.8.120:5182' },
      });
      console.log('✅ ' + sub.nombre + ' -> actualizado a puerto 5182');
    }
    
    // EMISION = 5183
    if (nombre.includes('emision') || nombre.includes('emisión')) {
      await prisma.submodulo.update({
        where: { id: sub.id },
        data: { url: 'http://192.168.8.120:5183' },
      });
      console.log('✅ ' + sub.nombre + ' -> actualizado a puerto 5183');
    }
    
    // PAGOS = 5184
    if (nombre.includes('pago')) {
      await prisma.submodulo.update({
        where: { id: sub.id },
        data: { url: 'http://192.168.8.120:5184' },
      });
      console.log('✅ ' + sub.nombre + ' -> actualizado a puerto 5184');
    }
  }
}

main().finally(() => prisma.$disconnect());
