import { BadRequestException } from '@nestjs/common';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerReadTools } from './read.tools';
import { ctxFromExtra, assertWrite } from '../mcp-server.factory';

function regSearch(candidates: any) {
  const server = new McpServer({ name: 't', version: '1' });
  registerReadTools(server, { candidates, jobs: {} as any, candidateAi: {} as any } as any);
  return (name: string) => (server as any)._registeredTools[name];
}
const org = { authInfo: { extra: { org: 'o1', role: 'viewer' } } };

describe('read tools + gate helpers', () => {
  it('ctxFromExtra extracts org + role from authInfo', () => {
    const ctx = ctxFromExtra({ authInfo: { extra: { org: 'o1', role: 'viewer', userId: 'u1' } } });
    expect(ctx).toEqual({ org: 'o1', role: 'viewer' });
  });

  it('assertWrite throws for viewer, allows member+', () => {
    expect(() => assertWrite('viewer')).toThrow();
    expect(() => assertWrite('member')).not.toThrow();
    expect(() => assertWrite('admin')).not.toThrow();
    expect(() => assertWrite('owner')).not.toThrow();
  });

  it('search_candidates passes tenantId=org into the service and returns JSON', async () => {
    const candidates = { findAll: jest.fn().mockResolvedValue({ candidates: [{ id: 'c1' }], total: 1 }) };
    const server = new McpServer({ name: 't', version: '1' });
    registerReadTools(server, { candidates, jobs: {} as any, candidateAi: {} as any } as any);
    // Access the registered tool's handler via the server's internal registry.
    // (Installed SDK stores the tool callback under `.handler`, not `.callback`.)
    const tool = (server as any)._registeredTools['search_candidates'];
    const result = await tool.handler({ q: 'eng' }, { authInfo: { extra: { org: 'o9', role: 'viewer' } } });
    expect(candidates.findAll).toHaveBeenCalledWith('o9', 'eng', undefined, undefined, undefined);
    expect(JSON.parse(result.content[0].text).total).toBe(1);
  });

  it('search_candidates schema only accepts the filters the service supports', () => {
    const tool = regSearch({ findAll: jest.fn() })('search_candidates');
    expect(tool.inputSchema.safeParse({ filter: 'all' }).success).toBe(true);
    expect(tool.inputSchema.safeParse({ filter: 'duplicates' }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ filter: 'unassigned' }).success).toBe(false);
  });

  it('search_candidates surfaces nested HttpException messages as a tool error', async () => {
    const findAll = jest
      .fn()
      .mockRejectedValue(
        new BadRequestException({ error: { code: 'INVALID_FILTER', message: "Filter 'x' is not supported." } }),
      );
    const res = await regSearch({ findAll })('search_candidates').handler({}, org);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Filter 'x' is not supported.");
  });

  it('search_candidates caps results at the requested limit and reports paging', async () => {
    const all = Array.from({ length: 30 }, (_, i) => ({ id: `c${i}`, full_name: `N${i}` }));
    const findAll = jest.fn().mockResolvedValue({ candidates: all, total: 30 });
    const res = await regSearch({ findAll })('search_candidates').handler({ limit: 10, offset: 5 }, org);
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.candidates).toHaveLength(10);
    expect(parsed.candidates[0].id).toBe('c5');
    expect(parsed).toMatchObject({ total: 30, returned: 10, offset: 5 });
  });

  it('search_candidates defaults to 25 results', async () => {
    const all = Array.from({ length: 30 }, (_, i) => ({ id: `c${i}` }));
    const findAll = jest.fn().mockResolvedValue({ candidates: all, total: 30 });
    const res = await regSearch({ findAll })('search_candidates').handler({}, org);
    expect(JSON.parse(res.content[0].text).candidates).toHaveLength(25);
  });

  it('search_candidates returns compact records (no ai_summary / stage_summaries)', async () => {
    const fat = {
      id: 'c1',
      full_name: 'Ada',
      ai_score: 88,
      ai_summary: 'a very long generated summary…',
      stage_summaries: { s1: 'notes' },
      salary_expectation_min: 1,
      job_title: 'BE Eng',
      is_duplicate: false,
    };
    const findAll = jest.fn().mockResolvedValue({ candidates: [fat], total: 1 });
    const res = await regSearch({ findAll })('search_candidates').handler({}, org);
    const c = JSON.parse(res.content[0].text).candidates[0];
    expect(c).toMatchObject({ id: 'c1', full_name: 'Ada', ai_score: 88, job_title: 'BE Eng' });
    expect(c.ai_summary).toBeUndefined();
    expect(c.stage_summaries).toBeUndefined();
    expect(c.salary_expectation_min).toBeUndefined();
    expect(c.is_duplicate).toBeUndefined();
  });

  it('get_pipeline uses the same compact pagination', async () => {
    const all = Array.from({ length: 40 }, (_, i) => ({ id: `c${i}`, ai_summary: 'long' }));
    const findAll = jest.fn().mockResolvedValue({ candidates: all, total: 40 });
    const res = await regSearch({ findAll })('get_pipeline').handler(
      { job_id: '11111111-1111-1111-1111-111111111111', limit: 30 },
      org,
    );
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.candidates).toHaveLength(30);
    expect(parsed.candidates[0].ai_summary).toBeUndefined();
    expect(parsed).toMatchObject({ total: 40, returned: 30 });
  });
});
