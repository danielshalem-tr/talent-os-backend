import { BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PmBridgeController } from './pm-bridge.controller';
import { PmBridgeService } from './pm-bridge.service';
import { SessionGuard } from '../auth/session.guard';
import { PmBridgeGuard } from './pm-bridge.guard';

const mockReq: any = { session: { sub: 'user-1', org: 'tenant-1' }, pmBridgeEmail: 'pm@x.com' };
const page = { name: 'Talent Pool', route: '/talent-pool' };

const mockService = {
  converse: jest.fn().mockResolvedValue({ type: 'clarify', questions: [] }),
  commit: jest.fn().mockResolvedValue({ type: 'filed' }),
  listDecisions: jest.fn().mockResolvedValue([]),
  createDecision: jest.fn(),
  updateDecision: jest.fn(),
  getTracker: jest.fn().mockResolvedValue({ tickets: [] }),
  verifyTicket: jest.fn().mockResolvedValue({ status: 'verified' }),
  reopenTicket: jest.fn().mockResolvedValue({ status: 'reopened' }),
};

async function buildController() {
  const module = await Test.createTestingModule({
    controllers: [PmBridgeController],
    providers: [{ provide: PmBridgeService, useValue: mockService }],
  })
    .overrideGuard(SessionGuard).useValue({ canActivate: () => true })
    .overrideGuard(PmBridgeGuard).useValue({ canActivate: () => true })
    .compile();
  return module.get(PmBridgeController);
}

beforeEach(() => jest.clearAllMocks());

describe('PmBridgeController', () => {
  it('converse passes parsed body + tenant/email to the service', async () => {
    const c = await buildController();
    await c.converse({ messages: [{ role: 'pm', content: 'search slow' }], page }, mockReq);
    expect(mockService.converse).toHaveBeenCalledWith(
      { messages: [{ role: 'pm', content: 'search slow' }], page }, 'tenant-1', 'pm@x.com',
    );
  });

  it('converse rejects an invalid body with 400', async () => {
    const c = await buildController();
    await expect(c.converse({ messages: [] }, mockReq)).rejects.toThrow(BadRequestException);
  });

  it('commit forwards a valid brief', async () => {
    const c = await buildController();
    const brief = {
      goal: 'g', problem: 'p', desiredOutcomes: [], constraints: [], affectedArea: page,
      sizeHint: 'tiny', devNotes: [], rawText: 'r', conversationDigest: 'd',
    };
    await c.commit({ brief, page }, mockReq);
    expect(mockService.commit).toHaveBeenCalledWith({ brief, page }, 'tenant-1', 'pm@x.com');
  });

  it('createDecision rejects empty statement', async () => {
    const c = await buildController();
    await expect(c.createDecision({ statement: '' }, mockReq)).rejects.toThrow(BadRequestException);
  });

  it('listDecisions returns service result', async () => {
    const c = await buildController();
    mockService.listDecisions.mockResolvedValue([{ id: '1' }]);
    const result = await c.listDecisions(mockReq);
    expect(result).toEqual([{ id: '1' }]);
  });

  it('updateDecision rejects invalid status value', async () => {
    const c = await buildController();
    await expect(c.updateDecision('id-1', { status: 'deleted' }, mockReq)).rejects.toThrow(BadRequestException);
  });
});

describe('PmBridgeController — tracker', () => {
  it('getTracker passes the tenant', async () => {
    const c = await buildController();
    await c.getTracker(mockReq);
    expect(mockService.getTracker).toHaveBeenCalledWith('tenant-1');
  });

  it('verify passes key, tenant, and email', async () => {
    const c = await buildController();
    const r = await c.verifyTicket('TO-12', mockReq);
    expect(mockService.verifyTicket).toHaveBeenCalledWith('TO-12', 'tenant-1', 'pm@x.com');
    expect(r).toEqual({ status: 'verified' });
  });

  it.each(['to-12', 'TO_12', '12', 'TO-', 'TO-12a'])('verify rejects malformed key %s with 400', async (bad) => {
    const c = await buildController();
    await expect(c.verifyTicket(bad, mockReq)).rejects.toThrow(BadRequestException);
    expect(mockService.verifyTicket).not.toHaveBeenCalled();
  });

  it('reopen passes the trimmed comment through', async () => {
    const c = await buildController();
    await c.reopenTicket('TO-12', { comment: '  missing the export button  ' }, mockReq);
    expect(mockService.reopenTicket).toHaveBeenCalledWith('TO-12', 'missing the export button', 'tenant-1', 'pm@x.com');
  });

  it('reopen rejects a missing comment with 400', async () => {
    const c = await buildController();
    await expect(c.reopenTicket('TO-12', {}, mockReq)).rejects.toThrow(BadRequestException);
  });

  it('reopen rejects a too-short comment with 400', async () => {
    const c = await buildController();
    await expect(c.reopenTicket('TO-12', { comment: 'ab' }, mockReq)).rejects.toThrow(BadRequestException);
    expect(mockService.reopenTicket).not.toHaveBeenCalled();
  });

  it('reopen rejects a malformed key with 400 before validating the body', async () => {
    const c = await buildController();
    await expect(c.reopenTicket('bad-key', { comment: 'long enough' }, mockReq)).rejects.toThrow(BadRequestException);
    expect(mockService.reopenTicket).not.toHaveBeenCalled();
  });
});
