import { PrismaClient } from "@prisma/client";
import * as bcrypt from "bcrypt";

const prisma = new PrismaClient();

async function main() {
  console.log("🚀 Iniciando Seed de Pruebas Masivas...");

  // 1. Limpiar datos existentes (Opcional, pero recomendado para pruebas limpias)
  // Nota: El orden importa por las llaves foráneas
  await prisma.permission.deleteMany();
  await prisma.usuario.deleteMany();
  await prisma.role.deleteMany();
  await prisma.empresaModulo.deleteMany();
  await prisma.submodulo.deleteMany();
  await prisma.modulo.deleteMany();
  await prisma.empresa.deleteMany();

  console.log("🧹 Base de datos limpia.");

  // 2. Crear Módulos y Submódulos
  const modulos = [
    {
      nombre: "Ventas",
      submodulos: [
        "Cotizaciones",
        "Facturación",
        "Clientes",
        "Reportes de Ventas",
      ],
    },
    {
      nombre: "Inventario",
      submodulos: ["Productos", "Almacenes", "Movimientos", "Stock Mínimo"],
    },
    {
      nombre: "Recursos Humanos",
      submodulos: ["Empleados", "Nómina", "Asistencia", "Vacaciones"],
    },
    {
      nombre: "Contabilidad",
      submodulos: [
        "Libro Mayor",
        "Asientos Contables",
        "Balances",
        "Impuestos",
      ],
    },
  ];

  for (const m of modulos) {
    const createdModulo = await prisma.modulo.create({
      data: {
        nombre: m.nombre,
        activo: true,
        submodulos: {
          create: m.submodulos.map((s) => ({ nombre: s, activo: true })),
        },
      },
    });
    console.log(
      `✅ Módulo '${m.nombre}' creado con ${m.submodulos.length} submódulos.`,
    );
  }

  const allModules = await prisma.modulo.findMany();

  // 3. Crear Empresas de Prueba (Tenants)
  const empresasData = [
    {
      nombre: "Tecnologías Globales S.A.",
      rif: "J-11111111-1",
      tipo: "Enterprise",
    },
    { nombre: "Distribuidora Oriente", rif: "J-22222222-2", tipo: "Retail" },
    { nombre: "Servicios Médicos Nexus", rif: "J-33333333-3", tipo: "Salud" },
  ];

  const hashedPassword = await bcrypt.hash("password123", 10);

  for (const ed of empresasData) {
    const empresa = await prisma.empresa.create({
      data: {
        nombre: ed.nombre,
        rif: ed.rif,
        tipo: ed.tipo,
        activo: true,
      },
    });

    console.log(`🏢 Empresa '${empresa.nombre}' creada.`);

    // 4. Activar Módulos para cada empresa
    for (const m of allModules) {
      const em = await prisma.empresaModulo.create({
        data: {
          empresaId: empresa.id,
          moduloId: m.id,
          token: `tk-${empresa.id}-${m.id}`,
          activo: true,
        },
      });

      // 5. Crear Roles por Empresa
      const adminRole = await prisma.role.create({
        data: {
          nombre: "Admin " + m.nombre,
          empresaId: empresa.id,
          activo: true,
        },
      });

      // 6. Asignar Permisos al Rol
      await prisma.permission.create({
        data: {
          roleId: adminRole.id,
          empresaModuloId: em.id,
          activo: true,
        },
      });

      // 7. Crear Usuarios de Prueba
      const userEmail = `${m.nombre.toLowerCase().replace(" ", "")}@${empresa.id}.com`;
      await prisma.usuario.create({
        data: {
          email: userEmail,
          password: hashedPassword,
          nombre: `User ${m.nombre} - ${empresa.nombre}`,
          empresaId: empresa.id,
          roleId: adminRole.id,
          activo: true,
        },
      });
    }
  }

  // Usuario Global de Prueba para el README (admin@acme.com)
  const acme = await prisma.empresa.create({
    data: {
      nombre: "ACME Corp",
      rif: "J-12345678-9",
      tipo: "SaaS",
      activo: true,
    },
  });

  const ventasMod = allModules.find((m) => m.nombre === "Ventas")!;
  const acmeEM = await prisma.empresaModulo.create({
    data: {
      empresaId: acme.id,
      moduloId: ventasMod.id,
      token: "acme-ventas-token",
      activo: true,
    },
  });

  const acmeRole = await prisma.role.create({
    data: {
      nombre: "SuperAdmin",
      empresaId: acme.id,
      activo: true,
    },
  });

  await prisma.permission.create({
    data: {
      roleId: acmeRole.id,
      empresaModuloId: acmeEM.id,
      activo: true,
    },
  });

  await prisma.usuario.create({
    data: {
      email: "admin@acme.com",
      password: hashedPassword,
      nombre: "Admin ACME",
      empresaId: acme.id,
      roleId: acmeRole.id,
      activo: true,
    },
  });

  console.log("✨ Seed completado con éxito.");
  console.log("👉 Usuario de prueba: admin@acme.com / password123");
}

main()
  .catch((e) => {
    console.error("❌ Error durante el seed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
