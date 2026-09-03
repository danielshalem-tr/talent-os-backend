/**
 * Scoring regression harness. Runs the REAL ScoringAgentService over a local fixture set of
 * real CVs and compares against the expected range per candidate.
 *
 * Fixtures are PII and live OUTSIDE the repo (pass --fixtures / --out). This script must never
 * write them anywhere inside the repo.
 *
 * Needs OPENROUTER_API_KEY in the environment (there is no dotenv in this repo):
 *
 *   export OPENROUTER_API_KEY=sk-or-...
 *   npm run scoring:eval -- --models=anthropic/claude-sonnet-5 --runs=2 --fixtures=/path/to/fixtures.json --out=/path/to/results.md
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { ScoringAgentService } from '../src/scoring/scoring.service';
import type { ScoringJob } from '../src/scoring/scoring-job-context';

interface FixtureCandidate {
  id: string;
  cvFile: string;
  currentRole: string | null;
  yearsExperience: number | null;
  skills: string[];
  prodScore: number | null;
  expected: [number, number];
  checks: string[];
}
interface Fixtures {
  job: ScoringJob;
  candidates: FixtureCandidate[];
}

function arg(name: string, def: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
}

function spearman(a: number[], b: number[]): number {
  const rank = (xs: number[]) => {
    const sorted = [...xs].map((v, i) => ({ v, i })).sort((p, q) => p.v - q.v);
    const r = new Array<number>(xs.length);
    sorted.forEach((s, idx) => (r[s.i] = idx + 1));
    return r;
  };
  const ra = rank(a);
  const rb = rank(b);
  const n = a.length;
  const d2 = ra.reduce((s, r, i) => s + (r - rb[i]) ** 2, 0);
  return 1 - (6 * d2) / (n * (n * n - 1));
}

async function main() {
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY is not set — export it before running the eval.');
  }
  const fixturesPath = resolve(process.cwd(), arg('fixtures', '../docs/superpowers/scoring-eval/fixtures.json'));
  const fixtures = JSON.parse(readFileSync(fixturesPath, 'utf8')) as Fixtures;
  const models = arg('models', 'anthropic/claude-sonnet-5').split(',');
  const runs = Number(arg('runs', '2'));
  const out = arg('out', '');
  // Full evaluations (per-requirement status/evidence) for diagnosis — written next to --out as .json.
  const dump: Record<string, unknown[]> = {};

  const lines: string[] = [`# Scoring eval — ${new Date().toISOString().slice(0, 10)}`, ''];
  for (const model of models) {
    const config = { get: (key: string) => process.env[key] } as unknown as ConfigService;
    const service = new ScoringAgentService(config);

    lines.push(
      `## ${model}`,
      '',
      '| candidate | expected | prod | ' +
        Array.from({ length: runs }, (_, i) => `run${i + 1}`).join(' | ') +
        ' | in range | caps / flags | Δ runs |',
      '|---|---|---|' + '---|'.repeat(runs) + '---|---|---|',
    );
    const mids: number[] = [];
    const firsts: number[] = [];
    let inRange = 0;
    let maxDelta = 0;
    let sumDist = 0;

    for (const c of fixtures.candidates) {
      const cvText = readFileSync(resolve(dirname(fixturesPath), c.cvFile), 'utf8');
      const scores: number[] = [];
      let lastCaps = '';
      for (let r = 0; r < runs; r++) {
        const res = await service.score(
          {
            cvText,
            candidateFields: { currentRole: c.currentRole, yearsExperience: c.yearsExperience, skills: c.skills },
            job: fixtures.job,
          },
          { model },
        );
        scores.push(res.score);
        (dump[`${model}/${c.id}`] ??= []).push({ score: res.score, ...res.breakdown, reasoning: res.reasoning });
        lastCaps = [...res.breakdown.caps_applied.map((x) => x.label), ...res.breakdown.flags].join(', ') || '—';
      }
      const [lo, hi] = c.expected;
      const first = scores[0];
      const ok = first >= lo && first <= hi;
      if (ok) inRange++;
      sumDist += ok ? 0 : Math.min(Math.abs(first - lo), Math.abs(first - hi));
      const delta = Math.max(...scores) - Math.min(...scores);
      maxDelta = Math.max(maxDelta, delta);
      mids.push((lo + hi) / 2);
      firsts.push(first);
      lines.push(
        `| ${c.id} | ${lo}–${hi} | ${c.prodScore ?? '—'} | ${scores.join(' | ')} | ${ok ? '✅' : '❌'} | ${lastCaps} | ${delta} |`,
      );
      process.stderr.write(`${model} ${c.id} → ${scores.join('/')} ${ok ? 'OK' : 'MISS'}\n`);
    }
    lines.push(
      '',
      `- In range: **${inRange}/${fixtures.candidates.length}**`,
      `- Mean distance outside range: **${(sumDist / fixtures.candidates.length).toFixed(1)}**`,
      `- Spearman vs expected midpoint: **${spearman(firsts, mids).toFixed(3)}**`,
      `- Max delta between identical runs: **${maxDelta}**`,
      '',
    );
  }
  const report = lines.join('\n');
  if (out) {
    writeFileSync(resolve(process.cwd(), out), report);
    writeFileSync(resolve(process.cwd(), out.replace(/\.md$/, '') + '.json'), JSON.stringify(dump, null, 2));
  }
  console.log(report);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
