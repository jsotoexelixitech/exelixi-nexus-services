const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const modulos = await prisma.modulo.findMany({ include: { submodulos: true } });
  console.dir(modulos, { depth: null });
}

main().finally(() => prisma.$disconnect());
