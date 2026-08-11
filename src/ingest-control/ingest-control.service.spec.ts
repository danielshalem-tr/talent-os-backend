import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { IngestControlService } from './ingest-control.service';
import { IngestControlController } from './ingest-control.controller';
import { JwtPayload } from '../auth/jwt.service';

const admin: JwtPayload = { sub: 'u1', org: 'org-1', role: 'admin' };
const viewer: JwtPayload = { sub: 'u2', org: 'org-1', role: 'viewer' };

describe('IngestControlService', () => {
  let prisma: any;
  let queue: { add: jest.Mock };
  let service: IngestControlService;

  beforeEach(() => {
    prisma = {
      organization: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({ aiIngestEnabled: true }),
        update: jest.fn().mockResolvedValue({ aiIngestEnabled: false }),
      },
      emailIntakeLog: {
        count: jest.fn().mockResolvedValue(2),
        findMany: jest.fn().mockResolvedValue([
          { id: 'i1', fromEmail: 'a@b.co', subject: 'CV', receivedAt: new Date('2026-08-11T10:00:00Z'), messageId: 'm1' },
        ]),
        updateMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
      $transaction: jest.fn().mockImplementation(async (cb: any) => cb(prisma)),
    };
    queue = { add: jest.fn().mockResolvedValue({}) };
    service = new IngestControlService(prisma, queue as any);
  });

  it('getStatus returns flag and held count', async () => {
    await expect(service.getStatus(viewer)).resolves.toEqual({ ai_ingest_enabled: true, held_count: 2 });
    expect(prisma.emailIntakeLog.count).toHaveBeenCalledWith({
      where: { tenantId: 'org-1', processingStatus: 'held' },
    });
  });

  it('setEnabled updates the tenant flag (admin)', async () => {
    const res = await service.setEnabled(admin, false);
    expect(prisma.organization.update).toHaveBeenCalledWith({
      where: { id: 'org-1' },
      data: { aiIngestEnabled: false },
      select: { aiIngestEnabled: true },
    });
    expect(res.ai_ingest_enabled).toBe(false);
  });

  it('setEnabled rejects non-admin roles', async () => {
    await expect(service.setEnabled(viewer, false)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('listHeld returns snake_case rows newest first', async () => {
    const res = await service.listHeld(viewer);
    expect(prisma.emailIntakeLog.findMany).toHaveBeenCalledWith({
      where: { tenantId: 'org-1', processingStatus: 'held' },
      orderBy: { receivedAt: 'desc' },
      select: { id: true, fromEmail: true, subject: true, receivedAt: true, messageId: true },
    });
    expect(res.held[0]).toEqual({ id: 'i1', from_email: 'a@b.co', subject: 'CV', received_at: '2026-08-11T10:00:00.000Z' });
  });

  it('replay claims each row individually (held→pending) and enqueues with a fresh jobId', async () => {
    prisma.emailIntakeLog.findMany.mockResolvedValue([
      { id: 'i1', fromEmail: 'a@b.co', subject: 'CV', receivedAt: new Date(), messageId: 'm1' },
      { id: 'i2', fromEmail: 'c@d.co', subject: 'CV2', receivedAt: new Date(), messageId: 'm2' },
    ]);
    prisma.emailIntakeLog.updateMany.mockResolvedValue({ count: 1 });
    const res = await service.replayHeld(admin);
    expect(res).toEqual({ replayed: 2 });
    expect(prisma.emailIntakeLog.updateMany).toHaveBeenCalledWith({
      where: { id: 'i1', tenantId: 'org-1', processingStatus: 'held' },
      data: { processingStatus: 'pending' },
    });
    expect(queue.add).toHaveBeenCalledTimes(2);
    const [name, data, opts] = queue.add.mock.calls[0];
    expect(name).toBe('ingest-email');
    expect(data).toEqual({ tenantId: 'org-1', messageId: 'm1' });
    expect(opts.jobId).toMatch(/^m1:replay:\d+$/);
    expect(opts.attempts).toBe(3);
  });

  it('replay skips rows another concurrent replay already claimed (count 0 → no enqueue)', async () => {
    prisma.emailIntakeLog.findMany.mockResolvedValue([
      { id: 'i1', fromEmail: 'a@b.co', subject: 'CV', receivedAt: new Date(), messageId: 'm1' },
    ]);
    prisma.emailIntakeLog.updateMany.mockResolvedValue({ count: 0 });
    const res = await service.replayHeld(admin);
    expect(res).toEqual({ replayed: 0 });
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('replay reverts a row to held when its enqueue fails, so re-running replay recovers it', async () => {
    prisma.emailIntakeLog.findMany.mockResolvedValue([
      { id: 'i1', fromEmail: 'a@b.co', subject: 'CV', receivedAt: new Date(), messageId: 'm1' },
    ]);
    prisma.emailIntakeLog.updateMany.mockResolvedValue({ count: 1 });
    queue.add.mockRejectedValue(new Error('redis down'));
    await expect(service.replayHeld(admin)).rejects.toThrow('redis down');
    expect(prisma.emailIntakeLog.updateMany).toHaveBeenLastCalledWith({
      where: { id: 'i1', tenantId: 'org-1' },
      data: { processingStatus: 'held' },
    });
  });

  it('replay rejects non-admin roles', async () => {
    await expect(service.replayHeld(viewer)).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('IngestControlController', () => {
  it('PATCH rejects a missing or non-boolean body flag before touching the service', () => {
    const service = { setEnabled: jest.fn() };
    const controller = new IngestControlController(service as any);
    const req = { session: admin } as any;

    expect(() => controller.setEnabled(req, undefined)).toThrow(BadRequestException);
    expect(() => controller.setEnabled(req, 'true')).toThrow(BadRequestException);
    expect(service.setEnabled).not.toHaveBeenCalled();
  });
});
