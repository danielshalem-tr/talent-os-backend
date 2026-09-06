import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ctxFromExtra, toolJson, toolError, errorMessage, type McpServices } from '../mcp-server.factory';

const readOnly = { readOnlyHint: true, openWorldHint: false } as const;

const paging = {
  limit: z.number().int().min(1).max(100).optional().describe('Page size (default 25, max 100).'),
  offset: z.number().int().min(0).optional().describe('Results to skip, for paging (default 0).'),
};

// List results are compact on purpose: no ai_summary / stage_summaries / salary fields.
// Fetch the full record with get_candidate. Keeps a 25-row page small for the model.
const COMPACT_CANDIDATE_FIELDS = [
  'id',
  'full_name',
  'email',
  'phone',
  'current_role',
  'location',
  'years_experience',
  'skills',
  'ai_score',
  'status',
  'is_rejected',
  'job_id',
  'job_title',
  'hiring_stage_id',
  'hiring_stage_name',
  'created_at',
  'cv_readable',
] as const;

function candidatePage(
  res: { candidates: unknown[]; total: number },
  args: { limit?: number; offset?: number },
): { candidates: Record<string, unknown>[]; total: number; returned: number; offset: number } {
  const offset = args.offset ?? 0;
  const page = res.candidates.slice(offset, offset + (args.limit ?? 25)).map((raw) => {
    const c = raw as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of COMPACT_CANDIDATE_FIELDS) if (k in c) out[k] = c[k];
    return out;
  });
  return { candidates: page, total: res.total, returned: page.length, offset };
}

export function registerReadTools(server: McpServer, s: McpServices): void {
  server.registerTool(
    'search_candidates',
    {
      title: 'Search candidates',
      description:
        "Search candidates in the caller's organization, newest first. Optional keyword `q`, `job_id`, `unassigned`, and `limit`/`offset` paging (default 25 per page). Returns compact records plus the total match count — use get_candidate for the full record (AI summary, salary, stage notes). Does NOT return CV text — use get_candidate_cv for a CV link.",
      inputSchema: {
        q: z.string().optional().describe('Keyword across name/role/email.'),
        filter: z.enum(['all']).optional().describe('Only "all" is supported. For unassigned candidates use the `unassigned` flag.'),
        job_id: z.string().uuid().optional().describe('Restrict to one job (its pipeline).'),
        unassigned: z.boolean().optional().describe('Only candidates with no assigned job.'),
        ...paging,
      },
      annotations: readOnly,
    },
    async (args, extra) => {
      const { org } = ctxFromExtra(extra);
      try {
        const res = await s.candidates.findAll(org, args.q, args.filter, args.job_id, args.unassigned);
        return toolJson(candidatePage(res, args));
      } catch (e) {
        return toolError(errorMessage(e, 'Failed to search candidates.'));
      }
    },
  );

  server.registerTool(
    'get_candidate',
    {
      title: 'Get candidate',
      description:
        "Fetch one candidate by id (scoped to the caller's organization). Returns the full candidate record (no CV text).",
      inputSchema: { candidate_id: z.string().uuid().describe('Candidate UUID.') },
      annotations: readOnly,
    },
    async (args, extra) => {
      const { org } = ctxFromExtra(extra);
      try {
        return toolJson(await s.candidates.findOne(args.candidate_id, org));
      } catch {
        return toolError(`Candidate ${args.candidate_id} not found. Use search_candidates to find valid ids.`);
      }
    },
  );

  server.registerTool(
    'get_candidate_cv',
    {
      title: 'Get candidate CV link',
      description:
        "Return a short-lived presigned URL to download the candidate's original CV file. Raw CV text is never returned.",
      inputSchema: { candidate_id: z.string().uuid().describe('Candidate UUID.') },
      annotations: { ...readOnly, openWorldHint: true },
    },
    async (args, extra) => {
      const { org } = ctxFromExtra(extra);
      try {
        return toolJson(await s.candidates.getCvPresignedUrl(args.candidate_id, org));
      } catch {
        return toolError(`No CV available for candidate ${args.candidate_id}.`);
      }
    },
  );

  server.registerTool(
    'list_jobs',
    {
      title: 'List jobs',
      description:
        'List jobs in the organization. Optional `status` filter (e.g. active, draft). Returns jobs + total.',
      inputSchema: { status: z.string().optional().describe('Filter by status.') },
      annotations: readOnly,
    },
    async (args, extra) => {
      const { org } = ctxFromExtra(extra);
      try {
        return toolJson(await s.jobs.findAll(org, args.status));
      } catch (e) {
        return toolError(errorMessage(e, 'Failed to list jobs.'));
      }
    },
  );

  server.registerTool(
    'get_job',
    {
      title: 'Get job',
      description: 'Fetch one job by id (scoped to the organization).',
      inputSchema: { job_id: z.string().uuid().describe('Job UUID.') },
      annotations: readOnly,
    },
    async (args, extra) => {
      const { org } = ctxFromExtra(extra);
      try {
        return toolJson(await s.jobs.findOne(args.job_id, org));
      } catch {
        return toolError(`Job ${args.job_id} not found. Use list_jobs to find valid ids.`);
      }
    },
  );

  server.registerTool(
    'get_pipeline',
    {
      title: 'Get job pipeline',
      description:
        "Return the candidates in a job's hiring pipeline (compact records with hiring_stage_name for Kanban grouping; `limit`/`offset` paging, default 25).",
      inputSchema: {
        job_id: z.string().uuid().describe('Job UUID whose pipeline to return.'),
        ...paging,
      },
      annotations: readOnly,
    },
    async (args, extra) => {
      const { org } = ctxFromExtra(extra);
      try {
        const res = await s.candidates.findAll(org, undefined, undefined, args.job_id, undefined);
        return toolJson(candidatePage(res, args));
      } catch (e) {
        return toolError(errorMessage(e, 'Failed to load the pipeline.'));
      }
    },
  );

  server.registerTool(
    'dashboard_counts',
    {
      title: 'Dashboard counts',
      description:
        'Return summary counts for the organization: total, duplicates (always 0 — duplicate flags are no longer produced), unassigned.',
      inputSchema: {},
      annotations: readOnly,
    },
    async (_args, extra) => {
      const { org } = ctxFromExtra(extra);
      try {
        return toolJson(await s.candidates.getCounts(org));
      } catch (e) {
        return toolError(errorMessage(e, 'Failed to load dashboard counts.'));
      }
    },
  );
}
