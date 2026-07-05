import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { toAdf } from './adf.util';
import type { DecomposedRoot } from './dto/ai-output.dto';

export interface CondensedTicket {
  key: string;
  type: string;
  summary: string;
  status: string;
}

export interface JiraIssueResult {
  key: string;
  url: string;
}

export interface DoneTicket {
  key: string;
  type: string;
  summary: string;
  doneAt: string; // ISO — when the issue's status category last changed (to Done)
  url: string;
}

interface JiraSearchResponse {
  issues: Array<{
    key: string;
    fields: {
      issuetype: { name: string };
      summary: string;
      status: { name: string };
    };
  }>;
}

interface JiraDoneSearchResponse {
  issues: Array<{
    key: string;
    fields: {
      issuetype: { name: string };
      summary: string;
      statuscategorychangedate: string;
    };
  }>;
}

interface JiraCreateResponse {
  key: string;
}

// Re-check the board's active sprint at most this often. A long-running API would otherwise
// pin the sprint resolved at boot and keep filing into a sprint that has since closed.
const ACTIVE_SPRINT_TTL_MS = 5 * 60 * 1000;

// The per-issue context resolved once per createIssueTree and applied to every issue in the tree.
interface IssueContext {
  assignee: { accountId: string } | null;
  reporter: { accountId: string } | null;
  sprintId: number | undefined;
}

@Injectable()
export class JiraGatewayService {
  private readonly logger = new Logger(JiraGatewayService.name);
  private readonly baseUrl: string;
  private readonly projectKey: string;
  private readonly authHeader: string;
  private readonly sprintId: number | undefined;
  private readonly boardId: number | undefined;
  // undefined = not yet resolved; null = no assignee configured/found
  private assigneeCache: { accountId: string } | null | undefined = undefined;
  // email (lowercased) → resolved reporter, cached so repeat filers skip the user-search call.
  private readonly reporterCache = new Map<string, { accountId: string } | null>();
  private activeSprintCache: { id: number | undefined; at: number } | undefined;

  constructor(private readonly config: ConfigService) {
    this.baseUrl = config.get<string>('JIRA_BASE_URL')!.replace(/\/$/, '');
    this.projectKey = config.get<string>('JIRA_PROJECT_KEY') ?? 'TO';
    // Never log: Jira auth header contains the API token
    const email = config.get<string>('JIRA_EMAIL')!;
    const token = config.get<string>('JIRA_API_TOKEN')!;
    this.authHeader = `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;
    this.sprintId = config.get<number>('JIRA_SPRINT_ID');
    this.boardId = config.get<number>('JIRA_BOARD_ID');
  }

  async readBoard(): Promise<CondensedTicket[]> {
    const jql = `project = "${this.projectKey}" AND statusCategory != "Done" ORDER BY updated DESC`;
    const res = await fetch(`${this.baseUrl}/rest/api/3/search/jql`, {
      method: 'POST',
      headers: {
        Authorization: this.authHeader,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        jql,
        fields: ['issuetype', 'summary', 'status'],
        maxResults: 200,
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      this.logger.error(`Jira readBoard failed: ${res.status} — ${text}`);
      throw this.jiraError(`Failed to read Jira board: ${res.status}`, text);
    }

    const data = (await res.json()) as JiraSearchResponse;
    // Scale note: MVP sends all non-Done issues to Claude because the TO board is small.
    // If the board grows, pre-filter by keyword/JQL before the AI call.
    this.logger.log(`Jira board read: ${data.issues.length} non-Done issues`);

    return data.issues.map((issue) => ({
      key: issue.key,
      type: issue.fields.issuetype.name,
      summary: issue.fields.summary,
      status: issue.fields.status.name,
    }));
  }

  async readDoneSince(days: number): Promise<DoneTicket[]> {
    const jql = `project = "${this.projectKey}" AND statusCategory = Done AND statusCategoryChangedDate >= -${days}d ORDER BY statusCategoryChangedDate DESC`;
    const res = await fetch(`${this.baseUrl}/rest/api/3/search/jql`, {
      method: 'POST',
      headers: {
        Authorization: this.authHeader,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        jql,
        fields: ['issuetype', 'summary', 'status', 'statuscategorychangedate'],
        maxResults: 200,
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      this.logger.error(`Jira readDoneSince failed: ${res.status} — ${text}`);
      throw this.jiraError(`Failed to read Done tickets: ${res.status}`, text);
    }

    const data = (await res.json()) as JiraDoneSearchResponse;
    this.logger.log(`Jira Done read: ${data.issues.length} issues in the last ${days}d`);

    return data.issues.map((issue) => ({
      key: issue.key,
      type: issue.fields.issuetype.name,
      summary: issue.fields.summary,
      doneAt: issue.fields.statuscategorychangedate,
      url: `${this.baseUrl}/browse/${issue.key}`,
    }));
  }

  async resolveAssignee(): Promise<{ accountId: string } | null> {
    if (this.assigneeCache !== undefined) return this.assigneeCache;

    const configured = this.config.get<string>('JIRA_DEFAULT_ASSIGNEE_ACCOUNT_ID');
    if (configured) {
      this.assigneeCache = { accountId: configured };
      return this.assigneeCache;
    }

    const email = this.config.get<string>('JIRA_DEFAULT_ASSIGNEE_EMAIL');
    if (!email) {
      this.logger.warn('No JIRA assignee configured — issues will be created unassigned');
      this.assigneeCache = null;
      return null;
    }

    const accountId = await this.lookupAccountIdByEmail(email);
    this.assigneeCache = accountId ? { accountId } : null;
    return this.assigneeCache;
  }

  // The reporter is the PM who actually filed the request (their app-login email), NOT the Jira
  // API-token owner. Left unset, Jira stamps the token owner (daniel.s) as reporter on every
  // issue, misattributing work filed by other allowlisted PMs (e.g. Yuval). Returns null when no
  // email is provided or the user can't be resolved, in which case Jira falls back to the default.
  async resolveReporter(email?: string): Promise<{ accountId: string } | null> {
    if (!email) return null;
    const key = email.toLowerCase();
    const cached = this.reporterCache.get(key);
    if (cached !== undefined) return cached;

    const accountId = await this.lookupAccountIdByEmail(email);
    if (!accountId) {
      this.logger.warn(`No Jira user found for reporter ${email} — leaving reporter as the API token owner`);
    }
    const result = accountId ? { accountId } : null;
    this.reporterCache.set(key, result);
    return result;
  }

  // Route new issues into the board's *currently active* sprint, resolved live so it keeps
  // working across sprint rollovers with no config change. An explicit JIRA_SPRINT_ID overrides
  // the lookup (escape hatch); without a board configured, issues fall to the backlog as before.
  async resolveActiveSprintId(): Promise<number | undefined> {
    if (this.sprintId) return this.sprintId;
    if (!this.boardId) return undefined;

    const now = Date.now();
    if (this.activeSprintCache && now - this.activeSprintCache.at < ACTIVE_SPRINT_TTL_MS) {
      return this.activeSprintCache.id;
    }

    const res = await fetch(`${this.baseUrl}/rest/agile/1.0/board/${this.boardId}/sprint?state=active`, {
      method: 'GET',
      headers: { Authorization: this.authHeader, Accept: 'application/json' },
    });
    if (!res.ok) {
      this.logger.error(`Jira active-sprint lookup failed for board ${this.boardId}: ${res.status}`);
      // Don't cache a failure — retry on the next filing rather than backlog for the whole TTL.
      return undefined;
    }
    const data = (await res.json()) as { values?: Array<{ id: number }> };
    const id = data.values?.[0]?.id;
    if (!id) this.logger.warn(`No active sprint on board ${this.boardId} — new issues will land in the backlog`);
    this.activeSprintCache = { id, at: now };
    return id;
  }

  private async lookupAccountIdByEmail(email: string): Promise<string | null> {
    const res = await fetch(`${this.baseUrl}/rest/api/3/user/search?query=${encodeURIComponent(email)}`, {
      method: 'GET',
      headers: { Authorization: this.authHeader, Accept: 'application/json' },
    });
    if (!res.ok) {
      this.logger.error(`Jira user search failed for ${email}: ${res.status}`);
      return null;
    }
    const users = (await res.json()) as Array<{ accountId: string }>;
    return users.length ? users[0].accountId : null;
  }

  private async createOne(
    input: {
      issueType: string;
      summary: string;
      description: string;
      acceptanceCriteria: string[];
      parentKey?: string;
    },
    ctx: IssueContext,
  ): Promise<JiraIssueResult> {
    const fields: Record<string, unknown> = {
      project: { key: this.projectKey },
      issuetype: { name: input.issueType },
      summary: input.summary,
      description: toAdf(input.description, input.acceptanceCriteria),
    };
    if (input.parentKey) fields.parent = { key: input.parentKey };
    if (ctx.assignee) fields.assignee = ctx.assignee;
    if (ctx.reporter) fields.reporter = ctx.reporter;
    // Sub-tasks inherit the parent's sprint; only set sprint on standalone/standard issues.
    if (ctx.sprintId && input.issueType !== 'Subtask') fields.customfield_10020 = ctx.sprintId;

    const key = await this.postIssue(fields, input.issueType);
    return { key, url: `${this.baseUrl}/browse/${key}` };
  }

  private async postIssue(fields: Record<string, unknown>, issueType: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}/rest/api/3/issue`, {
      method: 'POST',
      headers: { Authorization: this.authHeader, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ fields }),
    });
    if (res.ok) {
      const data = (await res.json()) as JiraCreateResponse;
      return data.key;
    }

    const text = await res.text().catch(() => '');
    // Best-effort reporter: if the API token lacks the "Modify Reporter" project permission, Jira
    // rejects the reporter field. Rather than lose the ticket, refile once without it (still filed,
    // just reported as the token owner) and warn loudly so the permission can be granted.
    if (fields.reporter && text.includes('reporter')) {
      this.logger.warn(
        `Jira rejected the reporter field (${res.status}) — refiling ${issueType} without it. ` +
          `Grant "Modify Reporter" in project ${this.projectKey} to attribute PM Bridge issues to the filer.`,
      );
      const { reporter: _reporter, ...withoutReporter } = fields;
      return this.postIssue(withoutReporter, issueType);
    }

    this.logger.error(`Jira createIssue (${issueType}) failed: ${res.status} — ${text}`);
    throw this.jiraError(`Failed to create Jira issue: ${res.status}`, text);
  }

  async createIssueTree(root: DecomposedRoot, reporterEmail?: string): Promise<{ keys: string[] }> {
    // Resolve assignee, reporter, and the active sprint once per tree; every issue reuses them.
    const [assignee, reporter, sprintId] = await Promise.all([
      this.resolveAssignee(),
      this.resolveReporter(reporterEmail),
      this.resolveActiveSprintId(),
    ]);
    const ctx: IssueContext = { assignee, reporter, sprintId };

    const keys: string[] = [];
    const rootRes = await this.createOne(
      {
        issueType: root.issueType,
        summary: root.summary,
        description: root.description,
        acceptanceCriteria: root.acceptanceCriteria,
      },
      ctx,
    );
    keys.push(rootRes.key);

    if (root.issueType === 'Epic') {
      for (const child of root.children) {
        const childRes = await this.createOne(
          {
            issueType: child.issueType,
            summary: child.summary,
            description: child.description,
            acceptanceCriteria: child.acceptanceCriteria,
            parentKey: rootRes.key,
          },
          ctx,
        );
        keys.push(childRes.key);
        for (const st of child.subtasks) {
          const stRes = await this.createOne(
            {
              issueType: 'Subtask',
              summary: st.summary,
              description: st.description,
              acceptanceCriteria: [],
              parentKey: childRes.key,
            },
            ctx,
          );
          keys.push(stRes.key);
        }
      }
    } else {
      for (const st of root.subtasks) {
        const stRes = await this.createOne(
          {
            issueType: 'Subtask',
            summary: st.summary,
            description: st.description,
            acceptanceCriteria: [],
            parentKey: rootRes.key,
          },
          ctx,
        );
        keys.push(stRes.key);
      }
    }

    this.logger.log(`Jira issue tree created: ${keys.join(', ')}`);
    return { keys };
  }

  async addComment(key: string, text: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/rest/api/3/issue/${key}/comment`, {
      method: 'POST',
      headers: { Authorization: this.authHeader, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ body: toAdf(text, []) }),
    });
    if (!res.ok) {
      const text2 = await res.text().catch(() => '');
      this.logger.error(`Jira addComment ${key} failed: ${res.status} — ${text2}`);
      throw this.jiraError(`Failed to comment on Jira issue ${key}: ${res.status}`, text2);
    }
  }

  // Moves an issue back to the To Do status category ('new'). Jira transition ids are
  // workflow-specific, so we list the available transitions and pick the first whose
  // target category is 'new' rather than hardcoding an id.
  async transitionToTodo(key: string): Promise<void> {
    const listRes = await fetch(`${this.baseUrl}/rest/api/3/issue/${key}/transitions`, {
      method: 'GET',
      headers: { Authorization: this.authHeader, Accept: 'application/json' },
    });
    if (!listRes.ok) {
      const text = await listRes.text().catch(() => '');
      this.logger.error(`Jira list transitions ${key} failed: ${listRes.status} — ${text}`);
      throw this.jiraError(`Failed to read transitions for ${key}: ${listRes.status}`, text);
    }

    const data = (await listRes.json()) as {
      transitions?: Array<{ id: string; to?: { statusCategory?: { key?: string } } }>;
    };
    const target = data.transitions?.find((t) => t.to?.statusCategory?.key === 'new');
    if (!target) {
      this.logger.error(`Jira issue ${key} has no transition to the To Do category`);
      throw this.jiraError(`No To Do transition available for ${key}`, '');
    }

    const postRes = await fetch(`${this.baseUrl}/rest/api/3/issue/${key}/transitions`, {
      method: 'POST',
      headers: { Authorization: this.authHeader, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ transition: { id: target.id } }),
    });
    if (!postRes.ok) {
      const text = await postRes.text().catch(() => '');
      this.logger.error(`Jira transition ${key} failed: ${postRes.status} — ${text}`);
      throw this.jiraError(`Failed to move ${key} back to To Do: ${postRes.status}`, text);
    }
    this.logger.log(`Jira ${key} transitioned back to To Do`);
  }

  private jiraError(message: string, _detail: string): HttpException {
    // 502 Bad Gateway — the failure originates upstream (Jira), not in the caller's request.
    // Use the same { error: { code, message } } envelope as the rest of the API so the
    // client gets a consistent shape and the intended status code (a plain Error would
    // surface as a generic 500 — there is no global exception filter to honor a custom field).
    return new HttpException({ error: { code: 'JIRA_ERROR', message } }, HttpStatus.BAD_GATEWAY);
  }
}
