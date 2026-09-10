import { PrismaClient } from '@prisma/client';
import * as dotenv from 'dotenv';
dotenv.config();

import { generateTenantToken } from './src/utils/tenant-token';

const prisma = new PrismaClient();

async function main() {
  console.log('Obteniendo registros de EmpresaSubmodulo...');
  const records = await (prisma as any).empresaSubmodulo.findMany();
  console.log(`Encontrados ${records.length} registros.`);

  for (const record of records) {
    const newToken = generateTenantToken(record.empresaId, record.submoduloId);
    console.log(
      `🔄 Regenerando token para empresaId=${record.empresaId}, submoduloId=${record.submoduloId}`,
    );
    await (prisma as any).empresaSubmodulo.update({
      where: { id: record.id },
      data: { tenantToken: newToken },
    });
  }

  console.log('¡Regeneración de tokens completada con éxito!');
}

main()
  .catch(console.error)
  .finally(async () => {
    await prisma.$disconnect();
  });
