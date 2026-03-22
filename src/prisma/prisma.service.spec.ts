import { PrismaService } from './prisma.service';

describe('PrismaService', () => {
  it('has PrismaClient methods ($connect, $disconnect, $transaction)', () => {
    const service = new PrismaService();
    expect(typeof service.$connect).toBe('function');
    expect(typeof service.$disconnect).toBe('function');
    expect(typeof service.$transaction).toBe('function');
  });

  it('has onModuleInit method', () => {
    const service = new PrismaService();
    expect(typeof service.onModuleInit).toBe('function');
  });

  it('has onModuleDestroy method', () => {
    const service = new PrismaService();
    expect(typeof service.onModuleDestroy).toBe('function');
  });
});
