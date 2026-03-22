import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // Upsert the single dev tenant (hardcoded ID per D-04)
  const tenant = await prisma.tenant.upsert({
    where: { id: '00000000-0000-0000-0000-000000000001' },
    update: {},
    create: {
      id: '00000000-0000-0000-0000-000000000001',
      name: 'Triolla',
    },
  });
  console.log('Upserted tenant:', tenant.id);

  // Upsert 1 active job for the dev tenant
  const job = await prisma.job.upsert({
    where: {
      id: '00000000-0000-0000-0000-000000000002',
    },
    update: {},
    create: {
      id: '00000000-0000-0000-0000-000000000002',
      tenantId: '00000000-0000-0000-0000-000000000001',
      title: 'Software Engineer',
      jobType: 'full_time',
      status: 'active',
    },
  });
  console.log('Upserted job:', job.id);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
