import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

const TENANT_ID = '00000000-0000-0000-0000-000000000001';

// ─── Fixed UUIDs ─────────────────────────────────────────────────────────────
const JOB_DESIGNER = '00000000-0000-0000-0000-000000001001';
const JOB_DESIGN_LEAD = '00000000-0000-0000-0000-000000001002';

const STAGES_DESIGNER = Array.from(
  { length: 8 },
  (_, i) => `00000000-0000-0000-0000-0000000020${String(i + 1).padStart(2, '0')}`,
);
const STAGES_DESIGN_LEAD = Array.from(
  { length: 8 },
  (_, i) => `00000000-0000-0000-0000-0000000020${String(i + 11).padStart(2, '0')}`,
);

const S = { APP_REVIEW: 0, SCREENING: 1, INTERVIEW: 2, OFFER: 3, HIRED: 4, REJECTED: 5, PENDING: 6, ON_HOLD: 7 };

const C_MAYA = '00000000-0000-0000-0000-000000000101';
const C_DANA = '00000000-0000-0000-0000-000000000102';

const APP_MAYA = '20000000-0000-0000-0000-000000000001';
const APP_DANA = '20000000-0000-0000-0000-000000000002';

const DEFAULT_HIRING_STAGES = [
  { name: 'Application Review', order: 1, isCustom: false, color: 'bg-zinc-400', isEnabled: true },
  { name: 'Screening', order: 2, isCustom: false, color: 'bg-blue-500', isEnabled: true },
  { name: 'Interview', order: 3, isCustom: false, color: 'bg-indigo-400', isEnabled: true },
  { name: 'Offer', order: 4, isCustom: false, color: 'bg-emerald-500', isEnabled: true },
  { name: 'Hired', order: 5, isCustom: false, color: 'bg-green-600', isEnabled: false },
  { name: 'Rejected', order: 6, isCustom: false, color: 'bg-red-500', isEnabled: false },
  { name: 'Pending Decision', order: 7, isCustom: false, color: 'bg-yellow-400', isEnabled: false },
  { name: 'On Hold', order: 8, isCustom: false, color: 'bg-gray-500', isEnabled: false },
];

async function main() {
  console.log('🌱 Seeding database...\n');

  // ── 1. Organization ──────────────────────────────────────────────────────────
  await prisma.organization.upsert({
    where: { id: TENANT_ID },
    update: {},
    create: { id: TENANT_ID, name: 'Triolla', shortId: 'triol-01' },
  });
  console.log('✓ Organization');

  // ── 2. Jobs ──────────────────────────────────────────────────────────────────
  const jobs = [
    {
      id: JOB_DESIGNER,
      shortId: '100',
      title: 'Senior Product UX/UI Designer',
      department: 'Design',
      location: 'Tel Aviv, Israel',
      jobType: 'full_time',
      status: 'open',
      description:
        "We're looking for a senior UX/UI designer with strong Figma skills and experience on complex B2B platforms. You'll collaborate with clients, PMs, and developers end-to-end.",
      requirements: [
        'Proficient in Figma with experience building scalable design systems',
        'Experience designing complex B2B platforms',
        'Strong UX thinking — research, flow mapping, wireframes, usability',
        '2–3 years of UI/UX industry experience',
      ],
      salaryRange: null,
      hiringManager: 'Yuval Bar Or',
      roleSummary: 'Design complex B2B digital products end-to-end, from research to high-fidelity delivery.',
      responsibilities:
        'Own end-to-end UX design for client projects, build and maintain design system components, collaborate with developers during implementation, present work to clients.',
      whatWeOffer:
        'Creative and collaborative environment, design system ownership, professional growth, hybrid work model.',
      mustHaveSkills: ['Figma', 'UX Design', 'Design Systems', 'B2B Platforms'],
      niceToHaveSkills: ['Prototyping', 'User Research', 'Interaction Design'],
      expYearsMin: 2,
      expYearsMax: 5,
      preferredOrgTypes: ['Agency', 'Startup'],
      stages: STAGES_DESIGNER,
    },
    {
      id: JOB_DESIGN_LEAD,
      shortId: '101',
      title: 'Product Design Team Lead',
      department: 'Design',
      location: 'Tel Aviv, Israel',
      jobType: 'full_time',
      status: 'open',
      description:
        "We're looking for a Product Design Team Leader to lead a talented team of 3–4 designers, driving high-impact projects and shaping exceptional digital experiences.",
      requirements: [
        '4+ years of experience in UX/UI design',
        '1–2 years in a leadership or mentorship role',
        'Hands-on expertise in Figma, design systems, and complex digital platforms',
        'Strong communication skills with PMs, developers, and clients',
      ],
      salaryRange: null,
      hiringManager: 'Yuval Bar Or',
      roleSummary: 'Lead a team of 3–4 designers across multiple client projects and drive design excellence.',
      responsibilities:
        'Manage and mentor product designers, define design processes and standards, lead design reviews, work closely with clients and stakeholders.',
      whatWeOffer:
        'Leadership role with real impact, diverse client portfolio, professional development support, hybrid work model.',
      mustHaveSkills: ['Figma', 'UX/UI Design', 'Design Systems', 'Team Leadership'],
      niceToHaveSkills: ['Design Ops', 'Client Management', 'Agile / Scrum'],
      expYearsMin: 4,
      expYearsMax: 10,
      preferredOrgTypes: ['Agency', 'Corporate / Enterprise'],
      stages: STAGES_DESIGN_LEAD,
    },
  ];

  for (const j of jobs) {
    await prisma.job.deleteMany({ where: { id: j.id } });
    await prisma.job.create({
      data: {
        id: j.id,
        tenantId: TENANT_ID,
        title: j.title,
        shortId: j.shortId,
        department: j.department,
        location: j.location,
        jobType: j.jobType,
        status: j.status,
        description: j.description,
        requirements: j.requirements,
        salaryRange: j.salaryRange,
        hiringManager: j.hiringManager,
        roleSummary: j.roleSummary,
        responsibilities: j.responsibilities,
        whatWeOffer: j.whatWeOffer,
        mustHaveSkills: j.mustHaveSkills,
        niceToHaveSkills: j.niceToHaveSkills,
        expYearsMin: j.expYearsMin,
        expYearsMax: j.expYearsMax,
        preferredOrgTypes: j.preferredOrgTypes,
        hiringStages: {
          create: DEFAULT_HIRING_STAGES.map((s, idx) => ({
            id: j.stages[idx],
            tenantId: TENANT_ID,
            name: s.name,
            order: s.order,
            isCustom: s.isCustom,
            color: s.color,
            isEnabled: s.isEnabled,
          })),
        },
      },
    });
  }
  console.log('✓ Jobs (2 open positions)');

  // ── 3. Candidates ─────────────────────────────────────────────────────────────
  const candidates = [
    {
      id: C_MAYA,
      jobId: JOB_DESIGNER,
      stageId: STAGES_DESIGNER[S.INTERVIEW],
      fullName: 'Maya Friedman',
      email: 'maya.friedman@gmail.com',
      phone: '+972-52-301-1111',
      currentRole: 'UX/UI Designer',
      location: 'Tel Aviv, Israel',
      yearsExperience: 3,
      skills: ['Figma', 'UX Research', 'Design Systems', 'Prototyping', 'B2B SaaS'],
      source: 'linkedin',
      aiSummary:
        'Mid-senior UX/UI designer with 3 years at a B2B SaaS startup. Strong Figma skills and a solid portfolio of complex platform design. Good cultural fit — communicative and collaborative. Currently at Interview stage.',
    },
    {
      id: C_DANA,
      jobId: JOB_DESIGN_LEAD,
      stageId: STAGES_DESIGN_LEAD[S.INTERVIEW],
      fullName: 'Dana Levi',
      email: 'dana.levi.design@gmail.com',
      phone: '+972-52-400-1234',
      currentRole: 'Design Lead',
      location: 'Tel Aviv, Israel',
      yearsExperience: 6,
      skills: ['Figma', 'Team Leadership', 'Design Systems', 'UX Strategy', 'Client Management', 'Mentorship'],
      source: 'linkedin',
      aiSummary:
        'Experienced design lead with 6 years in product design and 2 years managing a team of 3. Strong track record in agency and B2B environments. Excellent candidate for the Lead role.',
    },
  ];

  for (const c of candidates) {
    await prisma.candidate.upsert({
      where: { id: c.id },
      update: { jobId: c.jobId, hiringStageId: c.stageId },
      create: {
        id: c.id,
        tenantId: TENANT_ID,
        jobId: c.jobId,
        hiringStageId: c.stageId,
        fullName: c.fullName,
        email: c.email,
        phone: c.phone,
        currentRole: c.currentRole,
        location: c.location,
        yearsExperience: c.yearsExperience,
        skills: c.skills,
        source: c.source,
        aiSummary: c.aiSummary,
      },
    });
  }
  console.log('✓ Candidates (2)');

  // ── 4. Applications ───────────────────────────────────────────────────────────
  const applications = [
    {
      id: APP_MAYA,
      candidateId: C_MAYA,
      jobId: JOB_DESIGNER,
      stageId: STAGES_DESIGNER[S.INTERVIEW],
      stage: 'interview',
      daysAgo: 14,
    },
    {
      id: APP_DANA,
      candidateId: C_DANA,
      jobId: JOB_DESIGN_LEAD,
      stageId: STAGES_DESIGN_LEAD[S.INTERVIEW],
      stage: 'interview',
      daysAgo: 10,
    },
  ];

  for (const app of applications) {
    const appliedAt = new Date();
    appliedAt.setDate(appliedAt.getDate() - app.daysAgo);
    await prisma.application.upsert({
      where: { id: app.id },
      update: {},
      create: {
        id: app.id,
        tenantId: TENANT_ID,
        candidateId: app.candidateId,
        jobId: app.jobId,
        jobStageId: app.stageId,
        stage: app.stage,
        appliedAt,
      },
    });
  }
  console.log('✓ Applications (2)');

  // ── 5. CandidateJobScores ─────────────────────────────────────────────────────
  const scores = [
    {
      id: '30000000-0000-0000-0000-000000000001',
      appId: APP_MAYA,
      score: 78,
      reasoning:
        'Mid-senior UX/UI designer with strong Figma and B2B SaaS platform experience. Meets core requirements but limited agency-side exposure.',
      strengths: ['Figma', 'UX Research', 'B2B SaaS', 'Design Systems'],
      gaps: ['Limited agency-side experience', 'Prototyping depth unclear'],
    },
    {
      id: '30000000-0000-0000-0000-000000000002',
      appId: APP_DANA,
      score: 91,
      reasoning:
        'Experienced design lead with 6 years in product design and 2 years managing a team. Excellent leadership profile — top candidate.',
      strengths: ['Team Leadership', 'Figma', 'Design Systems', 'Client Management', 'Mentorship'],
      gaps: ['None significant'],
    },
  ];

  for (const s of scores) {
    await prisma.candidateJobScore.upsert({
      where: { id: s.id },
      update: {},
      create: {
        id: s.id,
        tenantId: TENANT_ID,
        applicationId: s.appId,
        score: s.score,
        reasoning: s.reasoning,
        strengths: s.strengths,
        gaps: s.gaps,
        modelUsed: 'openai/gpt-4o-mini',
      },
    });
  }
  console.log('✓ CandidateJobScores (2)');

  // ── 6. CandidateStageSummaries ────────────────────────────────────────────────
  // Both candidates at Interview — need APP_REVIEW + SCREENING summaries each
  const stageSummaries = [
    {
      id: '40000000-0000-0000-0000-000000000001',
      candidateId: C_MAYA,
      stageId: STAGES_DESIGNER[S.APP_REVIEW],
      summary:
        'Application reviewed: Strong Figma portfolio and B2B SaaS platform background. Meets core requirements. Advanced to Screening.',
    },
    {
      id: '40000000-0000-0000-0000-000000000002',
      candidateId: C_MAYA,
      stageId: STAGES_DESIGNER[S.SCREENING],
      summary:
        'Phone screen completed: Good communication, clear UX process, comfortable with client collaboration. Advancing to Interview.',
    },
    {
      id: '40000000-0000-0000-0000-000000000003',
      candidateId: C_DANA,
      stageId: STAGES_DESIGN_LEAD[S.APP_REVIEW],
      summary:
        'Application reviewed: Experienced design lead with team management history. Strong portfolio and leadership credentials. Advanced to Screening.',
    },
    {
      id: '40000000-0000-0000-0000-000000000004',
      candidateId: C_DANA,
      stageId: STAGES_DESIGN_LEAD[S.SCREENING],
      summary:
        'Phone screen: Clear leadership philosophy, strong mentorship examples, confident with client communication. Advancing to Interview.',
    },
  ];

  for (const ss of stageSummaries) {
    await prisma.candidateStageSummary.upsert({
      where: { idx_cand_stage_summary: { candidateId: ss.candidateId, jobStageId: ss.stageId } },
      update: {},
      create: {
        id: ss.id,
        tenantId: TENANT_ID,
        candidateId: ss.candidateId,
        jobStageId: ss.stageId,
        summary: ss.summary,
      },
    });
  }
  console.log('✓ CandidateStageSummaries (4)');

  console.log('\n✅ Seed complete!\n');
  console.log('Summary:');
  console.log('  100 — Senior Product UX/UI Designer  → Maya Friedman (Interview, score 78)');
  console.log('  101 — Product Design Team Lead        → Dana Levi     (Interview, score 91)');
  console.log('  Candidates: 2 | Applications: 2 | Scores: 2 | StageSummaries: 4');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
