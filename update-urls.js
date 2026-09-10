/* eslint-disable */
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  console.log('Actualizando URLs de submódulos...');

  // URL de los frontends (ajusta los puertos si son distintos)
  const ocrUrl = 'http://192.168.8.120:5181';
  const formUrl = 'http://192.168.8.120:5180';
  // Por si acaso quieres pagos después
  const pagosUrl = 'http://192.168.8.120:5182';

  // Buscar todos los submódulos y actualizar si el nombre coincide con "ocr", "formulario" o "pagos"
  const submodulos = await prisma.submodulo.findMany();

  for (const sub of submodulos) {
    const nombreLower = sub.nombre.toLowerCase();
    let targetUrl = null;

    if (nombreLower.includes('ocr')) {
      targetUrl = ocrUrl;
    } else if (nombreLower.includes('formulario')) {
      targetUrl = formUrl;
    } else if (nombreLower.includes('pagos')) {
      targetUrl = pagosUrl;
    }

    if (targetUrl) {
      await prisma.submodulo.update({
        where: { id: sub.id },
        data: { url: targetUrl },
      });
      console.log(`✅ Actualizado submódulo [${sub.nombre}] -> ${targetUrl}`);
    }
  }

  console.log('¡URLs configuradas en la base de datos!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
