import { NotFoundException } from '@nestjs/common';
import { PmBridgeService } from './pm-bridge.service';

const brief = {
  goal: 'Make search fast', problem: 'slow', desiredOutcomes: [], constraints: [],
  affectedArea: { name: 'Talent Pool', route: '/talent-pool' }, sizeHint: 'medium' as const,
  devNotes: [], rawText: 'search slow', conversationDigest: 'faster search',
};
const page = brief.affectedArea;

function make(overrides: any = {}) {
  const prisma = {
    pmProductDecision: { findMany: jest.fn().mockResolvedValue([]) },
    pmHeldRequest: {
      create: jest.fn().mockResolvedValue({ id: 'hold-1' }),
      findUnique: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
    },
    pmTicketReview: {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({}),
    },
  };
  const jira = {
    readBoard: jest.fn().mockResolvedValue([]),
    createIssueTree: jest.fn().mockResolvedValue({ keys: ['TO-1', 'TO-2'] }),
    addComment: jest.fn().mockResolvedValue(undefined),
    readDoneSince: jest.fn().mockResolvedValue([]),
    transitionToTodo: jest.fn().mockResolvedValue(undefined),
  };
  const ai = {
    clarify: jest.fn(),
    validate: jest.fn(),
    decompose: jest.fn().mockResolvedValue({ size: 'medium', root: { issueType: 'Story', summary: 'S', description: 'd', acceptanceCriteria: [], children: [], subtasks: [] } }),
  };
  const notify = { notifyHeld: jest.fn().mockResolvedValue(undefined) };
  Object.assign(ai, overrides.ai);
  return { svc: new PmBridgeService(prisma as any, jira as any, ai as any, notify as any), prisma, jira, ai, notify };
}

describe('PmBridgeService.converse', () => {
  it('passes through a clarify result', async () => {
    const { svc, ai } = make();
    ai.clarify.mockResolvedValue({ type: 'clarify', questions: [{ id: 'q1', prompt: 'slow or wrong?', chips: [], allowFreeText: true }], goal: '', brief: null });
    const r = await svc.converse({ messages: [{ role: 'pm', content: 'bad search' }], page }, 'tenant-1', 'pm@x.com');
    expect(r).toEqual({ type: 'clarify', questions: [{ id: 'q1', prompt: 'slow or wrong?', chips: [], allowFreeText: true }] });
  });

  it('returns ready + brief when the AI is satisfied', async () => {
    const { svc, ai } = make();
    ai.clarify.mockResolvedValue({ type: 'ready', questions: [], goal: 'Make search fast', brief });
    const r = await svc.converse({ messages: [{ role: 'pm', content: 'x' }], page }, 'tenant-1', 'pm@x.com');
    expect(r).toEqual({ type: 'ready', goal: 'Make search fast', brief });
  });

  it('holds for Daniel when still unclear after the max rounds', async () => {
    const { svc, ai, prisma, notify } = make();
    ai.clarify.mockResolvedValue({ type: 'clarify', questions: [{ id: 'q', prompt: '?', chips: [], allowFreeText: true }], goal: '', brief: null });
    // 3 assistant turns already used → cap reached
    const messages = [
      { role: 'pm', content: 'a' }, { role: 'assistant', content: 'q1' },
      { role: 'pm', content: 'b' }, { role: 'assistant', content: 'q2' },
      { role: 'pm', content: 'c' }, { role: 'assistant', content: 'q3' },
      { role: 'pm', content: 'd' },
    ];
    const r = await svc.converse({ messages, page } as any, 'tenant-1', 'pm@x.com');
    expect(r).toEqual({ type: 'held' });
    expect(prisma.pmHeldRequest.create).toHaveBeenCalled();
    expect(notify.notifyHeld).toHaveBeenCalled();
  });
});

describe('PmBridgeService.commit', () => {
  it('clean → builds the tree and files, reporting the filer', async () => {
    const { svc, ai, jira } = make();
    ai.validate.mockResolvedValue({ status: 'clean', duplicateOfKey: null, reasonPlain: '', related: [], conflictingDecisionIds: [] });
    const r = await svc.commit({ brief, page }, 'tenant-1', 'yuval@triolla.io');
    // second arg is the reporter email so Jira attributes the issue to the PM who filed it
    expect(jira.createIssueTree).toHaveBeenCalledWith(expect.anything(), 'yuval@triolla.io');
    expect(r).toEqual({ type: 'filed' });
  });

  it('duplicate → folds a comment, files nothing', async () => {
    const { svc, ai, jira } = make();
    ai.validate.mockResolvedValue({ status: 'duplicate', duplicateOfKey: 'TO-9', reasonPlain: 'same', related: [], conflictingDecisionIds: [] });
    const r = await svc.commit({ brief, page }, 'tenant-1', 'pm@x.com');
    expect(jira.addComment).toHaveBeenCalledWith('TO-9', expect.stringContaining('Make search fast'));
    expect(jira.createIssueTree).not.toHaveBeenCalled();
    expect(r).toEqual({ type: 'merged' });
  });

  it('conflict → holds + notifies, files nothing', async () => {
    const { svc, ai, jira, prisma, notify } = make();
    ai.validate.mockResolvedValue({ status: 'conflict', duplicateOfKey: null, reasonPlain: 'breaks rule', related: [], conflictingDecisionIds: ['d1'] });
    const r = await svc.commit({ brief, page }, 'tenant-1', 'pm@x.com');
    expect(prisma.pmHeldRequest.create).toHaveBeenCalled();
    expect(notify.notifyHeld).toHaveBeenCalledWith(expect.objectContaining({ holdId: 'hold-1', reasonPlain: 'breaks rule' }));
    expect(jira.createIssueTree).not.toHaveBeenCalled();
    expect(r).toEqual({ type: 'held' });
  });
});

describe('PmBridgeService.approveHold / rejectHold', () => {
  it('approve builds the stored brief and marks approved, reporting the original filer', async () => {
    const { svc, prisma, jira } = make();
    prisma.pmHeldRequest.findUnique.mockResolvedValue({ id: 'hold-1', status: 'pending', brief, createdBy: 'yuval@triolla.io' });
    const r = await svc.approveHold('hold-1');
    // reporter = who originally filed the hold, not whoever clicks approve
    expect(jira.createIssueTree).toHaveBeenCalledWith(expect.anything(), 'yuval@triolla.io');
    expect(prisma.pmHeldRequest.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'approved' }) }));
    expect(r.status).toBe('approved');
  });

  it('approve on an already-resolved hold is a no-op', async () => {
    const { svc, prisma, jira } = make();
    prisma.pmHeldRequest.findUnique.mockResolvedValue({ id: 'hold-1', status: 'approved', brief });
    const r = await svc.approveHold('hold-1');
    expect(r.status).toBe('already_resolved');
    expect(jira.createIssueTree).not.toHaveBeenCalled();
  });

  it('approve on a missing hold throws 404', async () => {
    const { svc, prisma } = make();
    prisma.pmHeldRequest.findUnique.mockResolvedValue(null);
    await expect(svc.approveHold('nope')).rejects.toThrow(NotFoundException);
  });

  it('reject marks rejected without touching Jira', async () => {
    const { svc, prisma, jira } = make();
    prisma.pmHeldRequest.findUnique.mockResolvedValue({ id: 'hold-1', status: 'pending', brief });
    const r = await svc.rejectHold('hold-1');
    expect(r.status).toBe('rejected');
    expect(jira.createIssueTree).not.toHaveBeenCalled();
  });
});

describe('PmBridgeService.getTracker', () => {
  const ticket = (key: string, doneAt: string) => ({
    key, type: 'Story', summary: `s-${key}`, doneAt, url: `https://x.atlassian.net/browse/${key}`,
  });
  const review = (jiraKey: string, action: string, createdAt: string) => ({
    id: 'r', tenantId: 'tenant-1', jiraKey, action, comment: null, createdBy: 'pm@x.com',
    createdAt: new Date(createdAt),
  });

  it('reads a 14-day window and queries reviews only for the returned keys', async () => {
    const { svc, jira, prisma } = make();
    jira.readDoneSince.mockResolvedValue([ticket('TO-1', '2026-07-01T10:00:00.000+0000')]);
    await svc.getTracker('tenant-1');
    expect(jira.readDoneSince).toHaveBeenCalledWith(14);
    expect(prisma.pmTicketReview.findMany).toHaveBeenCalledWith({
      where: { tenantId: 'tenant-1', jiraKey: { in: ['TO-1'] } },
      orderBy: { createdAt: 'desc' },
    });
  });

  it('shows an unreviewed ticket', async () => {
    const { svc, jira } = make();
    jira.readDoneSince.mockResolvedValue([ticket('TO-1', '2026-07-01T10:00:00.000+0000')]);
    const r = await svc.getTracker('tenant-1');
    expect(r.tickets.map((t: any) => t.key)).toEqual(['TO-1']);
  });

  it('hides a ticket verified after its Done transition', async () => {
    const { svc, jira, prisma } = make();
    jira.readDoneSince.mockResolvedValue([ticket('TO-1', '2026-07-01T10:00:00.000+0000')]);
    prisma.pmTicketReview.findMany.mockResolvedValue([review('TO-1', 'verified', '2026-07-02T10:00:00.000Z')]);
    const r = await svc.getTracker('tenant-1');
    expect(r.tickets).toEqual([]);
  });

  it('re-shows a redone ticket (verify older than the latest Done transition)', async () => {
    const { svc, jira, prisma } = make();
    jira.readDoneSince.mockResolvedValue([ticket('TO-1', '2026-07-03T10:00:00.000+0000')]);
    prisma.pmTicketReview.findMany.mockResolvedValue([review('TO-1', 'verified', '2026-07-02T10:00:00.000Z')]);
    const r = await svc.getTracker('tenant-1');
    expect(r.tickets.map((t: any) => t.key)).toEqual(['TO-1']);
  });

  it('latest row wins — a fresh verify hides even if an older reopen exists', async () => {
    const { svc, jira, prisma } = make();
    jira.readDoneSince.mockResolvedValue([ticket('TO-1', '2026-07-01T10:00:00.000+0000')]);
    // findMany returns createdAt DESC — newest first
    prisma.pmTicketReview.findMany.mockResolvedValue([
      review('TO-1', 'verified', '2026-07-04T10:00:00.000Z'),
      review('TO-1', 'reopened', '2026-07-02T10:00:00.000Z'),
    ]);
    const r = await svc.getTracker('tenant-1');
    expect(r.tickets).toEqual([]);
  });

  it('shows a ticket whose latest review is reopened', async () => {
    const { svc, jira, prisma } = make();
    jira.readDoneSince.mockResolvedValue([ticket('TO-1', '2026-07-01T10:00:00.000+0000')]);
    prisma.pmTicketReview.findMany.mockResolvedValue([
      review('TO-1', 'reopened', '2026-07-04T10:00:00.000Z'),
      review('TO-1', 'verified', '2026-07-02T10:00:00.000Z'),
    ]);
    const r = await svc.getTracker('tenant-1');
    expect(r.tickets.map((t: any) => t.key)).toEqual(['TO-1']);
  });

  it('skips the review query entirely when Jira returns nothing', async () => {
    const { svc, prisma } = make();
    const r = await svc.getTracker('tenant-1');
    expect(r).toEqual({ tickets: [] });
    expect(prisma.pmTicketReview.findMany).not.toHaveBeenCalled();
  });
});

describe('PmBridgeService.verifyTicket', () => {
  it('appends a verified row and never touches Jira', async () => {
    const { svc, prisma, jira } = make();
    const r = await svc.verifyTicket('TO-1', 'tenant-1', 'pm@x.com');
    expect(r).toEqual({ status: 'verified' });
    expect(prisma.pmTicketReview.create).toHaveBeenCalledWith({
      data: { tenantId: 'tenant-1', jiraKey: 'TO-1', action: 'verified', createdBy: 'pm@x.com' },
    });
    expect(jira.addComment).not.toHaveBeenCalled();
    expect(jira.transitionToTodo).not.toHaveBeenCalled();
  });
});

describe('PmBridgeService.reopenTicket', () => {
  it('comments first, then transitions, then records the verdict', async () => {
    const { svc, prisma, jira } = make();
    const r = await svc.reopenTicket('TO-1', 'export button missing', 'tenant-1', 'pm@x.com');
    expect(r).toEqual({ status: 'reopened' });
    expect(jira.addComment).toHaveBeenCalledWith(
      'TO-1',
      'Reopened via PM Bridge by pm@x.com:\n\nexport button missing',
    );
    // comment must land BEFORE the transition so the bounce always carries its reason
    expect(jira.addComment.mock.invocationCallOrder[0]).toBeLessThan(
      jira.transitionToTodo.mock.invocationCallOrder[0],
    );
    expect(prisma.pmTicketReview.create).toHaveBeenCalledWith({
      data: { tenantId: 'tenant-1', jiraKey: 'TO-1', action: 'reopened', comment: 'export button missing', createdBy: 'pm@x.com' },
    });
  });

  it('partial failure: transition fails → verdict row still written, 502 with the manual-move message', async () => {
    expect.assertions(4);
    const { svc, prisma, jira } = make();
    jira.transitionToTodo.mockRejectedValue(new Error('jira down'));
    try {
      await svc.reopenTicket('TO-1', 'not really done', 'tenant-1', 'pm@x.com');
    } catch (e: any) {
      expect(e.getStatus()).toBe(502);
      expect(e.getResponse()).toEqual({
        error: {
          code: 'JIRA_ERROR',
          message: 'Comment posted, but moving the ticket back failed — move it in Jira manually.',
        },
      });
    }
    expect(prisma.pmTicketReview.create).toHaveBeenCalledWith({
      data: { tenantId: 'tenant-1', jiraKey: 'TO-1', action: 'reopened', comment: 'not really done', createdBy: 'pm@x.com' },
    });
    expect(jira.addComment).toHaveBeenCalled();
  });

  it('comment failure: nothing else happens and the gateway error propagates', async () => {
    const { svc, prisma, jira } = make();
    jira.addComment.mockRejectedValue(new Error('502'));
    await expect(svc.reopenTicket('TO-1', 'reason here', 'tenant-1', 'pm@x.com')).rejects.toThrow();
    expect(jira.transitionToTodo).not.toHaveBeenCalled();
    expect(prisma.pmTicketReview.create).not.toHaveBeenCalled();
  });
});
