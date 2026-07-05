import { HttpException, HttpStatus } from '@nestjs/common';
import { JiraGatewayService } from './jira-gateway.service';

const BASE_URL = 'https://example.atlassian.net';
const EMAIL = 'user@example.com';
const TOKEN = 'secret-token';
const PROJECT_KEY = 'TP';
const EXPECTED_AUTH = `Basic ${Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64')}`;

function makeService(overrides: Record<string, string | number | undefined> = {}) {
  const config = {
    get: jest.fn((key: string) => {
      // Numeric env (JIRA_BOARD_ID/JIRA_SPRINT_ID) is coerced to a number by zod in production,
      // so the fake config returns numbers for those to mirror ConfigService faithfully.
      const vals: Record<string, string | number | undefined> = {
        JIRA_BASE_URL: BASE_URL,
        JIRA_EMAIL: EMAIL,
        JIRA_API_TOKEN: TOKEN,
        JIRA_PROJECT_KEY: PROJECT_KEY,
        ...overrides,
      };
      return vals[key];
    }),
  };
  return new JiraGatewayService(config as any);
}

function okJson(body: unknown) {
  return { ok: true, json: async () => body, text: async () => '' } as any;
}

describe('JiraGatewayService.readBoard', () => {
  let fetchMock: jest.SpyInstance;
  beforeEach(() => {
    fetchMock = jest.spyOn(global, 'fetch');
  });
  afterEach(() => fetchMock.mockRestore());

  it('uses correct Basic auth header', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ issues: [] }) } as any);
    await makeService().readBoard();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: EXPECTED_AUTH }) }),
    );
  });

  it('builds JQL with configured project key', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ issues: [] }) } as any);
    await makeService().readBoard();
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.jql).toContain(PROJECT_KEY);
    expect(body.jql).toContain('statusCategory != "Done"');
  });

  it('throws a 502 HttpException with JIRA_ERROR envelope on non-2xx response', async () => {
    expect.assertions(3);
    fetchMock.mockResolvedValue({ ok: false, status: 401, text: async () => 'Unauthorized' } as any);
    try {
      await makeService().readBoard();
    } catch (e) {
      expect(e).toBeInstanceOf(HttpException);
      expect((e as HttpException).getStatus()).toBe(HttpStatus.BAD_GATEWAY);
      expect((e as HttpException).getResponse()).toEqual({
        error: { code: 'JIRA_ERROR', message: expect.stringContaining('401') },
      });
    }
  });
});

afterEach(() => jest.restoreAllMocks());

describe('JiraGatewayService.createIssueTree', () => {
  it('creates Epic → child → subtask, assigns each, and links parents', async () => {
    const gw = makeService({ JIRA_DEFAULT_ASSIGNEE_ACCOUNT_ID: 'acc-daniel' });
    const keys = ['TO-10', 'TO-11', 'TO-12'];
    const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(() => Promise.resolve(okJson({ key: keys.shift() })));

    const result = await gw.createIssueTree({
      issueType: 'Epic', summary: 'Referral program', description: 'd', acceptanceCriteria: [], subtasks: [],
      children: [{ issueType: 'Story', summary: 'Invite flow', description: 'd', acceptanceCriteria: ['works'], subtasks: [{ summary: 'API', description: 'd' }] }],
    });

    expect(result.keys).toEqual(['TO-10', 'TO-11', 'TO-12']);
    const bodies = fetchMock.mock.calls.map((c) => JSON.parse((c[1] as any).body));
    // every issue assigned to Daniel
    expect(bodies.every((b) => b.fields.assignee?.accountId === 'acc-daniel')).toBe(true);
    // child parented to epic, subtask parented to child
    expect(bodies[1].fields.parent).toEqual({ key: 'TO-10' });
    expect(bodies[2].fields.parent).toEqual({ key: 'TO-11' });
    expect(bodies[2].fields.issuetype).toEqual({ name: 'Subtask' });
  });
});

describe('JiraGatewayService.createIssueTree — reporter', () => {
  afterEach(() => jest.restoreAllMocks());

  it('sets the reporter to the resolved accountId of the filer email', async () => {
    const gw = makeService({ JIRA_DEFAULT_ASSIGNEE_ACCOUNT_ID: 'acc-daniel' });
    jest.spyOn(global, 'fetch').mockImplementation((url: any) => {
      const u = String(url);
      if (u.includes('/user/search')) return Promise.resolve(okJson([{ accountId: 'acc-yuval' }]));
      return Promise.resolve(okJson({ key: 'TO-20' }));
    });

    await gw.createIssueTree(
      { issueType: 'Task', summary: 'S', description: 'd', acceptanceCriteria: [], subtasks: [], children: [] },
      'yuval@triolla.io',
    );

    const fetchMock = global.fetch as unknown as jest.SpyInstance;
    // The user-search call carries the filer's email
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('query=yuval%40triolla.io'))).toBe(true);
    // The created issue reports the resolved filer, not the token owner
    const createBody = JSON.parse(
      (fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/rest/api/3/issue'))![1] as any).body,
    );
    expect(createBody.fields.reporter).toEqual({ accountId: 'acc-yuval' });
    // Assignee stays the configured default (the dev who does the work)
    expect(createBody.fields.assignee).toEqual({ accountId: 'acc-daniel' });
  });

  it('omits the reporter when no filer email is given', async () => {
    const gw = makeService({ JIRA_DEFAULT_ASSIGNEE_ACCOUNT_ID: 'acc-daniel' });
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(okJson({ key: 'TO-21' }));
    await gw.createIssueTree({ issueType: 'Task', summary: 'S', description: 'd', acceptanceCriteria: [], subtasks: [], children: [] });
    const createBody = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
    expect(createBody.fields.reporter).toBeUndefined();
  });

  it('refiles without the reporter when Jira rejects the reporter field, still creating the issue', async () => {
    const gw = makeService({ JIRA_DEFAULT_ASSIGNEE_ACCOUNT_ID: 'acc-daniel' });
    let createAttempts = 0;
    jest.spyOn(global, 'fetch').mockImplementation((url: any) => {
      const u = String(url);
      if (u.includes('/user/search')) return Promise.resolve(okJson([{ accountId: 'acc-yuval' }]));
      createAttempts += 1;
      if (createAttempts === 1) {
        return Promise.resolve({
          ok: false,
          status: 400,
          text: async () => '{"errors":{"reporter":"Field \'reporter\' cannot be set."}}',
        } as any);
      }
      return Promise.resolve(okJson({ key: 'TO-22' }));
    });

    const res = await gw.createIssueTree(
      { issueType: 'Task', summary: 'S', description: 'd', acceptanceCriteria: [], subtasks: [], children: [] },
      'yuval@triolla.io',
    );

    expect(res.keys).toEqual(['TO-22']);
    expect(createAttempts).toBe(2);
    const fetchMock = global.fetch as unknown as jest.SpyInstance;
    const retryBody = JSON.parse(
      (fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/rest/api/3/issue'))[1][1] as any).body,
    );
    expect(retryBody.fields.reporter).toBeUndefined();
  });
});

describe('JiraGatewayService.createIssueTree — sprint', () => {
  afterEach(() => jest.restoreAllMocks());

  it('resolves the active sprint from JIRA_BOARD_ID and sets it on non-subtask issues only', async () => {
    const gw = makeService({ JIRA_DEFAULT_ASSIGNEE_ACCOUNT_ID: 'acc', JIRA_BOARD_ID: 137 });
    const keys = ['TO-30', 'TO-31'];
    jest.spyOn(global, 'fetch').mockImplementation((url: any) => {
      const u = String(url);
      if (u.includes('/board/137/sprint')) return Promise.resolve(okJson({ values: [{ id: 447 }] }));
      return Promise.resolve(okJson({ key: keys.shift() }));
    });

    await gw.createIssueTree({
      issueType: 'Task', summary: 'S', description: 'd', acceptanceCriteria: [],
      children: [], subtasks: [{ summary: 'sub', description: 'd' }],
    });

    const fetchMock = global.fetch as unknown as jest.SpyInstance;
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/board/137/sprint?state=active'))).toBe(true);
    const createBodies = fetchMock.mock.calls
      .filter((c) => String(c[0]).endsWith('/rest/api/3/issue'))
      .map((c) => JSON.parse((c[1] as any).body));
    // parent Task carries the sprint; the Subtask does not (it inherits the parent's sprint)
    expect(createBodies[0].fields.customfield_10020).toBe(447);
    expect(createBodies[1].fields.issuetype).toEqual({ name: 'Subtask' });
    expect(createBodies[1].fields.customfield_10020).toBeUndefined();
  });

  it('an explicit JIRA_SPRINT_ID overrides the board lookup (no agile call)', async () => {
    const gw = makeService({ JIRA_DEFAULT_ASSIGNEE_ACCOUNT_ID: 'acc', JIRA_BOARD_ID: 137, JIRA_SPRINT_ID: 999 });
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(okJson({ key: 'TO-40' }));
    await gw.createIssueTree({ issueType: 'Task', summary: 'S', description: 'd', acceptanceCriteria: [], subtasks: [], children: [] });
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/sprint'))).toBe(false);
    const createBody = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
    expect(createBody.fields.customfield_10020).toBe(999);
  });
});

describe('JiraGatewayService.addComment', () => {
  it('POSTs an ADF comment body', async () => {
    const gw = makeService({ JIRA_DEFAULT_ASSIGNEE_ACCOUNT_ID: 'acc' });
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(okJson({}));
    await gw.addComment('TO-5', 'PM follow-up: make it faster');
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain('/rest/api/3/issue/TO-5/comment');
    expect(JSON.parse((opts as any).body).body.type).toBe('doc');
  });
});

describe('JiraGatewayService.readDoneSince', () => {
  let fetchMock: jest.SpyInstance;
  beforeEach(() => {
    fetchMock = jest.spyOn(global, 'fetch');
  });
  afterEach(() => fetchMock.mockRestore());

  it('POSTs a Done-window JQL with the right fields and maxResults', async () => {
    fetchMock.mockResolvedValue(okJson({ issues: [] }));
    await makeService().readDoneSince(14);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE_URL}/rest/api/3/search/jql`);
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.jql).toBe(
      `project = "${PROJECT_KEY}" AND statusCategory = Done AND statusCategoryChangedDate >= -14d ORDER BY statusCategoryChangedDate DESC`,
    );
    expect(body.fields).toEqual(['issuetype', 'summary', 'status', 'statuscategorychangedate']);
    expect(body.maxResults).toBe(200);
  });

  it('maps issues to DoneTickets with a browse url and ISO doneAt', async () => {
    fetchMock.mockResolvedValue(
      okJson({
        issues: [
          {
            key: 'TP-7',
            fields: {
              issuetype: { name: 'Story' },
              summary: 'Faster search',
              status: { name: 'Done' },
              statuscategorychangedate: '2026-07-03T10:22:33.000+0300',
            },
          },
        ],
      }),
    );
    const tickets = await makeService().readDoneSince(14);
    expect(tickets).toEqual([
      {
        key: 'TP-7',
        type: 'Story',
        summary: 'Faster search',
        doneAt: '2026-07-03T10:22:33.000+0300',
        url: `${BASE_URL}/browse/TP-7`,
      },
    ]);
  });

  it('throws a 502 JIRA_ERROR envelope on non-2xx', async () => {
    expect.assertions(3);
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' } as any);
    try {
      await makeService().readDoneSince(14);
    } catch (e) {
      expect(e).toBeInstanceOf(HttpException);
      expect((e as HttpException).getStatus()).toBe(HttpStatus.BAD_GATEWAY);
      expect((e as HttpException).getResponse()).toMatchObject({ error: { code: 'JIRA_ERROR' } });
    }
  });
});
