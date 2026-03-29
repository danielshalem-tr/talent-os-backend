import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

const TENANT_ID = '00000000-0000-0000-0000-000000000001';

// ─── Fixed UUIDs for deterministic, idempotent seeding ──────────────────────

// Jobs
const JOB_SE = '00000000-0000-0000-0000-000000001001'; // Senior Software Engineer — open
const JOB_PM = '00000000-0000-0000-0000-000000001002'; // Product Manager — open
const JOB_DS = '00000000-0000-0000-0000-000000001003'; // Data Scientist — open
const JOB_UX = '00000000-0000-0000-0000-000000001004'; // UX Designer — draft
const JOB_QA = '00000000-0000-0000-0000-000000001005'; // QA Lead — closed

// Hiring stages — each job gets its own set with fixed IDs
// SE stages
const SE_REVIEW = '10000000-0000-0000-0001-000000000001';
const SE_SCREEN = '10000000-0000-0000-0001-000000000002';
const SE_INTERVIEW = '10000000-0000-0000-0001-000000000003';
const SE_OFFER = '10000000-0000-0000-0001-000000000004';
const SE_HIRED = '10000000-0000-0000-0001-000000000005';
const SE_REJECTED = '10000000-0000-0000-0001-000000000006';
const SE_PENDING = '10000000-0000-0000-0001-000000000007';
const SE_ONHOLD = '10000000-0000-0000-0001-000000000008';

// PM stages
const PM_REVIEW = '10000000-0000-0000-0002-000000000001';
const PM_SCREEN = '10000000-0000-0000-0002-000000000002';
const PM_INTERVIEW = '10000000-0000-0000-0002-000000000003';
const PM_OFFER = '10000000-0000-0000-0002-000000000004';
const PM_HIRED = '10000000-0000-0000-0002-000000000005';
const PM_REJECTED = '10000000-0000-0000-0002-000000000006';
const PM_PENDING = '10000000-0000-0000-0002-000000000007';
const PM_ONHOLD = '10000000-0000-0000-0002-000000000008';

// DS stages
const DS_REVIEW = '10000000-0000-0000-0003-000000000001';
const DS_SCREEN = '10000000-0000-0000-0003-000000000002';
const DS_INTERVIEW = '10000000-0000-0000-0003-000000000003';
const DS_OFFER = '10000000-0000-0000-0003-000000000004';
const DS_HIRED = '10000000-0000-0000-0003-000000000005';
const DS_REJECTED = '10000000-0000-0000-0003-000000000006';
const DS_PENDING = '10000000-0000-0000-0003-000000000007';
const DS_ONHOLD = '10000000-0000-0000-0003-000000000008';

// UX stages
const UX_REVIEW = '10000000-0000-0000-0004-000000000001';
const UX_SCREEN = '10000000-0000-0000-0004-000000000002';
const UX_INTERVIEW = '10000000-0000-0000-0004-000000000003';
const UX_OFFER = '10000000-0000-0000-0004-000000000004';
const UX_HIRED = '10000000-0000-0000-0004-000000000005';
const UX_REJECTED = '10000000-0000-0000-0004-000000000006';
const UX_PENDING = '10000000-0000-0000-0004-000000000007';
const UX_ONHOLD = '10000000-0000-0000-0004-000000000008';

// QA stages
const QA_REVIEW = '10000000-0000-0000-0005-000000000001';
const QA_SCREEN = '10000000-0000-0000-0005-000000000002';
const QA_INTERVIEW = '10000000-0000-0000-0005-000000000003';
const QA_OFFER = '10000000-0000-0000-0005-000000000004';
const QA_HIRED = '10000000-0000-0000-0005-000000000005';
const QA_REJECTED = '10000000-0000-0000-0005-000000000006';
const QA_PENDING = '10000000-0000-0000-0005-000000000007';
const QA_ONHOLD = '10000000-0000-0000-0005-000000000008';

// Candidates
const C_YAEL = '00000000-0000-0000-0000-000000000101';
const C_NOAM = '00000000-0000-0000-0000-000000000102';
const C_DANA = '00000000-0000-0000-0000-000000000103';
const C_OMER = '00000000-0000-0000-0000-000000000104';
const C_TALI = '00000000-0000-0000-0000-000000000105';
const C_IDAN = '00000000-0000-0000-0000-000000000106';
const C_SHIRA = '00000000-0000-0000-0000-000000000107';
const C_AMIT = '00000000-0000-0000-0000-000000000108';
const C_RON = '00000000-0000-0000-0000-000000000109';
const C_MAYA = '00000000-0000-0000-0000-000000000110';
const C_EYAL = '00000000-0000-0000-0000-000000000111';
const SCORE_EYAL = '30000000-0000-0000-0000-000000000011';
const C_LIORA = '00000000-0000-0000-0000-000000000112';

// Applications
const APP_YAEL = '20000000-0000-0000-0000-000000000001';
const APP_NOAM = '20000000-0000-0000-0000-000000000002';
const APP_DANA = '20000000-0000-0000-0000-000000000003';
const APP_OMER = '20000000-0000-0000-0000-000000000004';
const APP_TALI = '20000000-0000-0000-0000-000000000005';
const APP_IDAN = '20000000-0000-0000-0000-000000000006';
const APP_SHIRA = '20000000-0000-0000-0000-000000000007';
const APP_AMIT = '20000000-0000-0000-0000-000000000008';
const APP_RON = '20000000-0000-0000-0000-000000000009';
const APP_MAYA = '20000000-0000-0000-0000-000000000010';
const APP_EYAL = '20000000-0000-0000-0000-000000000011';
const APP_LIORA = '20000000-0000-0000-0000-000000000012';

// Scores
const SCORE_YAEL = '30000000-0000-0000-0000-000000000001';
const SCORE_NOAM = '30000000-0000-0000-0000-000000000002';
const SCORE_DANA = '30000000-0000-0000-0000-000000000003';
const SCORE_OMER = '30000000-0000-0000-0000-000000000004';
const SCORE_TALI = '30000000-0000-0000-0000-000000000005';
const SCORE_IDAN = '30000000-0000-0000-0000-000000000006';
const SCORE_SHIRA = '30000000-0000-0000-0000-000000000007';
const SCORE_AMIT = '30000000-0000-0000-0000-000000000008';
const SCORE_RON = '30000000-0000-0000-0000-000000000009';
const SCORE_MAYA = '30000000-0000-0000-0000-000000000010';

// Duplicate flags
const DUP_1 = '40000000-0000-0000-0000-000000000001';

// ─── Stage template ─────────────────────────────────────────────────────────

function buildStages(jobId: string, stageIds: string[]) {
  const templates = [
    { name: 'Application Review', order: 1, isCustom: false, color: 'bg-zinc-400', isEnabled: true },
    { name: 'Screening', order: 2, isCustom: false, color: 'bg-blue-500', isEnabled: true },
    { name: 'Interview', order: 3, isCustom: false, color: 'bg-indigo-400', isEnabled: true },
    { name: 'Offer', order: 4, isCustom: false, color: 'bg-emerald-500', isEnabled: true },
    { name: 'Hired', order: 5, isCustom: false, color: 'bg-green-600', isEnabled: false },
    { name: 'Rejected', order: 6, isCustom: false, color: 'bg-red-500', isEnabled: false },
    { name: 'Pending Decision', order: 7, isCustom: false, color: 'bg-yellow-400', isEnabled: false },
    { name: 'On Hold', order: 8, isCustom: false, color: 'bg-gray-500', isEnabled: false },
  ];
  return templates.map((t, i) => ({
    id: stageIds[i],
    tenantId: TENANT_ID,
    jobId,
    ...t,
  }));
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const isTenantOnly = process.argv.includes('--tenant-only');
  console.log(`🌱 Seeding database${isTenantOnly ? ' (Tenant only)' : ''}...\n`);

  // ── 1. Tenant ─────────────────────────────────────────────────────────
  await prisma.tenant.upsert({
    where: { id: TENANT_ID },
    update: {},
    create: { id: TENANT_ID, name: 'Triolla' },
  });
  console.log('✓ Tenant');

  if (isTenantOnly) {
    console.log('\n✅ Initial setup complete!');
    return;
  }

  // ── 2. Jobs ───────────────────────────────────────────────────────────
  const jobs = [
    {
      id: JOB_SE,
      title: 'Senior Software Engineer',
      department: 'Engineering',
      location: 'Tel Aviv, Israel',
      status: 'open',
      hiringManager: 'Jane Smith',
      description:
        'We are looking for a Senior Software Engineer to join our core platform team and help build the next generation of our product.',
      mustHaveSkills: ['TypeScript', 'Node.js', 'PostgreSQL'],
      niceToHaveSkills: ['Docker', 'Kubernetes', 'AWS'],
      expYearsMin: 5,
      expYearsMax: 10,
    },
    {
      id: JOB_PM,
      title: 'Product Manager',
      department: 'Product',
      location: 'Tel Aviv, Israel',
      status: 'open',
      hiringManager: 'Admin Cohen',
      description:
        'Join our Product team to define roadmap, work with engineering, and drive user engagement across our B2B SaaS platform.',
      mustHaveSkills: ['Product Strategy', 'SQL', 'User Research'],
      niceToHaveSkills: ['Figma', 'Data Analysis'],
      expYearsMin: 3,
      expYearsMax: 7,
    },
    {
      id: JOB_DS,
      title: 'Data Scientist',
      department: 'Engineering',
      location: 'Haifa, Israel',
      status: 'open',
      hiringManager: 'Jane Smith',
      description: 'Build ML models and data pipelines to power our AI-driven candidate matching and scoring features.',
      mustHaveSkills: ['Python', 'Machine Learning', 'SQL'],
      niceToHaveSkills: ['PyTorch', 'Spark', 'dbt'],
      expYearsMin: 2,
      expYearsMax: 6,
    },
    {
      id: JOB_UX,
      title: 'UX Designer',
      department: 'Design',
      location: 'Remote',
      status: 'draft',
      hiringManager: 'Admin Cohen',
      description: 'Design intuitive experiences for our hiring platform — from Kanban boards to candidate profiles.',
      mustHaveSkills: ['Figma', 'User Research', 'Design Systems'],
      niceToHaveSkills: ['Prototyping', 'Motion Design'],
      expYearsMin: 3,
      expYearsMax: 8,
    },
    {
      id: JOB_QA,
      title: 'QA Lead',
      department: 'Engineering',
      location: 'Tel Aviv, Israel',
      status: 'closed',
      hiringManager: 'Jane Smith',
      description: 'Lead our QA efforts across the platform — this position has been filled.',
      mustHaveSkills: ['Test Automation', 'Selenium', 'CI/CD'],
      niceToHaveSkills: ['Playwright', 'k6'],
      expYearsMin: 4,
      expYearsMax: 8,
    },
  ];

  for (const j of jobs) {
    await prisma.job.upsert({
      where: { id: j.id },
      update: {},
      create: {
        id: j.id,
        tenantId: TENANT_ID,
        title: j.title,
        department: j.department,
        location: j.location,
        status: j.status,
        hiringManager: j.hiringManager,
        description: j.description,
        mustHaveSkills: j.mustHaveSkills,
        niceToHaveSkills: j.niceToHaveSkills,
        expYearsMin: j.expYearsMin,
        expYearsMax: j.expYearsMax,
      },
    });
  }
  console.log('✓ Jobs (5 — 3 open, 1 draft, 1 closed)');

  // ── 3. Hiring stages ──────────────────────────────────────────────────
  const allStages = [
    ...buildStages(JOB_SE, [
      SE_REVIEW,
      SE_SCREEN,
      SE_INTERVIEW,
      SE_OFFER,
      SE_HIRED,
      SE_REJECTED,
      SE_PENDING,
      SE_ONHOLD,
    ]),
    ...buildStages(JOB_PM, [
      PM_REVIEW,
      PM_SCREEN,
      PM_INTERVIEW,
      PM_OFFER,
      PM_HIRED,
      PM_REJECTED,
      PM_PENDING,
      PM_ONHOLD,
    ]),
    ...buildStages(JOB_DS, [
      DS_REVIEW,
      DS_SCREEN,
      DS_INTERVIEW,
      DS_OFFER,
      DS_HIRED,
      DS_REJECTED,
      DS_PENDING,
      DS_ONHOLD,
    ]),
    ...buildStages(JOB_UX, [
      UX_REVIEW,
      UX_SCREEN,
      UX_INTERVIEW,
      UX_OFFER,
      UX_HIRED,
      UX_REJECTED,
      UX_PENDING,
      UX_ONHOLD,
    ]),
    ...buildStages(JOB_QA, [
      QA_REVIEW,
      QA_SCREEN,
      QA_INTERVIEW,
      QA_OFFER,
      QA_HIRED,
      QA_REJECTED,
      QA_PENDING,
      QA_ONHOLD,
    ]),
  ];

  for (const s of allStages) {
    await prisma.jobStage.upsert({
      where: { id: s.id },
      update: {},
      create: s,
    });
  }
  console.log('✓ Hiring stages (8 × 5 jobs = 40)');

  // ── 4. Candidates ─────────────────────────────────────────────────────
  // Spread across jobs and stages to demonstrate the Kanban board
  const candidates = [
    // ── SE job: 5 candidates across different stages ──
    {
      id: C_YAEL,
      jobId: JOB_SE,
      hiringStageId: SE_INTERVIEW,
      fullName: 'Yael Cohen',
      email: 'yael.cohen@example.com',
      phone: '+972-50-111-2222',
      currentRole: 'Senior Software Engineer',
      location: 'Tel Aviv, Israel',
      yearsExperience: 7,
      skills: ['TypeScript', 'Node.js', 'React', 'PostgreSQL', 'Docker'],
      source: 'direct',
      aiSummary:
        'Senior fullstack engineer with 7 years experience. Strong TypeScript and React skills with production PostgreSQL experience.',
    },
    {
      id: C_DANA,
      jobId: JOB_SE,
      hiringStageId: SE_REVIEW,
      fullName: 'Dana Avital',
      email: 'dana.avital@example.com',
      phone: '+972-54-222-3333',
      currentRole: 'Backend Developer',
      location: 'Herzliya, Israel',
      yearsExperience: 4,
      skills: ['Node.js', 'Python', 'PostgreSQL', 'Redis'],
      source: 'linkedin',
      aiSummary:
        'Mid-level backend developer focused on Node.js microservices. Growing into senior role, solid database skills.',
    },
    {
      id: C_OMER,
      jobId: JOB_SE,
      hiringStageId: SE_SCREEN,
      fullName: 'Omer Shapira',
      email: 'omer.shapira@example.com',
      phone: '+972-52-444-5555',
      currentRole: 'Full Stack Developer',
      location: 'Ramat Gan, Israel',
      yearsExperience: 6,
      skills: ['TypeScript', 'React', 'Node.js', 'AWS', 'Terraform'],
      source: 'referral',
      aiSummary:
        'Experienced fullstack developer with strong DevOps background. AWS certified. Great culture fit based on referral notes.',
    },
    {
      id: C_RON,
      jobId: JOB_SE,
      hiringStageId: SE_OFFER,
      fullName: 'Ron Mizrahi',
      email: 'ron.mizrahi@example.com',
      phone: '+972-50-888-9999',
      currentRole: 'Staff Engineer',
      location: 'Tel Aviv, Israel',
      yearsExperience: 9,
      skills: ['TypeScript', 'Go', 'Kubernetes', 'PostgreSQL', 'System Design'],
      source: 'agency',
      sourceAgency: 'TechTalent IL',
      aiSummary:
        'Highly experienced staff engineer with system design expertise. Strong leadership skills, previously led a team of 8.',
    },
    {
      id: C_EYAL,
      jobId: JOB_SE,
      hiringStageId: SE_REVIEW,
      fullName: 'Eyal Katz',
      email: 'eyal.katz@example.com',
      phone: '+972-54-000-1111',
      currentRole: 'Junior Developer',
      location: 'Netanya, Israel',
      yearsExperience: 1,
      skills: ['JavaScript', 'React', 'Node.js'],
      source: 'website',
      aiSummary: 'Junior developer with bootcamp background. Enthusiastic but under-qualified for senior role.',
    },

    // ── PM job: 3 candidates ──
    {
      id: C_NOAM,
      jobId: JOB_PM,
      hiringStageId: PM_INTERVIEW,
      fullName: 'Noam Levy',
      email: 'noam.levy@example.com',
      phone: '+972-52-333-4444',
      currentRole: 'Product Manager',
      location: 'Haifa, Israel',
      yearsExperience: 4,
      skills: ['Product Strategy', 'Roadmapping', 'SQL', 'Figma', 'A/B Testing'],
      source: 'direct',
      aiSummary: 'Strong PM with 4 years in B2B SaaS. Data-driven approach, great stakeholder communication.',
    },
    {
      id: C_TALI,
      jobId: JOB_PM,
      hiringStageId: PM_REVIEW,
      fullName: 'Tali Ben-Ari',
      email: 'tali.benari@example.com',
      phone: '+972-50-555-6666',
      currentRole: 'Associate PM',
      location: 'Tel Aviv, Israel',
      yearsExperience: 2,
      skills: ['User Research', 'Jira', 'Roadmapping', 'SQL'],
      source: 'linkedin',
      aiSummary: 'Early-career PM moving from associate role. Good user research skills, needs mentoring on strategy.',
    },
    {
      id: C_LIORA,
      jobId: JOB_PM,
      hiringStageId: PM_SCREEN,
      fullName: 'Liora Golan',
      email: 'liora.golan@example.com',
      phone: '+972-53-222-4444',
      currentRole: 'Product Analyst',
      location: 'Raanana, Israel',
      yearsExperience: 3,
      skills: ['Data Analysis', 'SQL', 'Product Analytics', 'Mixpanel'],
      source: 'referral',
      aiSummary: 'Transitioning from analytics to PM. Strong data skills, needs more product ownership experience.',
    },

    // ── DS job: 3 candidates ──
    {
      id: C_IDAN,
      jobId: JOB_DS,
      hiringStageId: DS_REVIEW,
      fullName: 'Idan Peretz',
      email: 'idan.peretz@example.com',
      phone: '+972-50-666-7777',
      currentRole: 'Data Analyst',
      location: 'Beer Sheva, Israel',
      yearsExperience: 3,
      skills: ['Python', 'SQL', 'Pandas', 'Scikit-learn', 'Tableau'],
      source: 'linkedin',
      aiSummary: 'Transitioning from data analyst to data scientist. Strong Python and SQL, building ML portfolio.',
    },
    {
      id: C_SHIRA,
      jobId: JOB_DS,
      hiringStageId: DS_INTERVIEW,
      fullName: 'Shira Alon',
      email: 'shira.alon@example.com',
      phone: '+972-52-777-8888',
      currentRole: 'ML Engineer',
      location: 'Tel Aviv, Israel',
      yearsExperience: 5,
      skills: ['Python', 'PyTorch', 'NLP', 'Docker', 'MLOps'],
      source: 'agency',
      sourceAgency: 'DataHire',
      aiSummary: 'Experienced ML engineer with NLP specialization. Published research, strong engineering practices.',
    },
    {
      id: C_AMIT,
      jobId: JOB_DS,
      hiringStageId: DS_SCREEN,
      fullName: 'Amit Rosenberg',
      email: 'amit.rosenberg@example.com',
      phone: '+972-54-888-9999',
      currentRole: 'Research Scientist',
      location: 'Rehovot, Israel',
      yearsExperience: 4,
      skills: ['Python', 'TensorFlow', 'Statistics', 'R', 'Spark'],
      source: 'direct',
      aiSummary:
        'Academic background transitioning to industry. Strong theoretical foundations, adjusting to production ML.',
    },

    // ── UX job (draft): 1 candidate to show draft jobs can still have candidates ──
    {
      id: C_MAYA,
      jobId: JOB_UX,
      hiringStageId: UX_REVIEW,
      fullName: 'Maya Friedman',
      email: 'maya.friedman@example.com',
      phone: '+972-50-999-0000',
      currentRole: 'UX/UI Designer',
      location: 'Tel Aviv, Israel',
      yearsExperience: 5,
      skills: ['Figma', 'Design Systems', 'User Research', 'Prototyping', 'Accessibility'],
      source: 'website',
      aiSummary: 'Well-rounded UX designer with design systems experience. Portfolio shows strong B2B work.',
    },
  ];

  for (const c of candidates) {
    await prisma.candidate.upsert({
      where: { id: c.id },
      update: { hiringStageId: c.hiringStageId },
      create: {
        id: c.id,
        tenantId: TENANT_ID,
        jobId: c.jobId,
        hiringStageId: c.hiringStageId,
        fullName: c.fullName,
        email: c.email,
        phone: c.phone,
        currentRole: c.currentRole,
        location: c.location,
        yearsExperience: c.yearsExperience,
        skills: c.skills,
        source: c.source,
        sourceAgency: (c as any).sourceAgency ?? null,
        aiSummary: c.aiSummary,
      },
    });
  }
  console.log('✓ Candidates (12 — spread across jobs & stages)');

  // ── 5. Applications (one per candidate-job pair) ──────────────────────
  const applications = [
    // SE
    { id: APP_YAEL, candidateId: C_YAEL, jobId: JOB_SE, jobStageId: SE_INTERVIEW },
    { id: APP_DANA, candidateId: C_DANA, jobId: JOB_SE, jobStageId: SE_REVIEW },
    { id: APP_OMER, candidateId: C_OMER, jobId: JOB_SE, jobStageId: SE_SCREEN },
    { id: APP_RON, candidateId: C_RON, jobId: JOB_SE, jobStageId: SE_OFFER },
    { id: APP_EYAL, candidateId: C_EYAL, jobId: JOB_SE, jobStageId: SE_REVIEW },
    // PM
    { id: APP_NOAM, candidateId: C_NOAM, jobId: JOB_PM, jobStageId: PM_INTERVIEW },
    { id: APP_TALI, candidateId: C_TALI, jobId: JOB_PM, jobStageId: PM_REVIEW },
    { id: APP_LIORA, candidateId: C_LIORA, jobId: JOB_PM, jobStageId: PM_SCREEN },
    // DS
    { id: APP_IDAN, candidateId: C_IDAN, jobId: JOB_DS, jobStageId: DS_REVIEW },
    { id: APP_SHIRA, candidateId: C_SHIRA, jobId: JOB_DS, jobStageId: DS_INTERVIEW },
    { id: APP_AMIT, candidateId: C_AMIT, jobId: JOB_DS, jobStageId: DS_SCREEN },
    // UX
    { id: APP_MAYA, candidateId: C_MAYA, jobId: JOB_UX, jobStageId: UX_REVIEW },
  ];

  for (const a of applications) {
    await prisma.application.upsert({
      where: { id: a.id },
      update: { jobStageId: a.jobStageId },
      create: {
        id: a.id,
        tenantId: TENANT_ID,
        candidateId: a.candidateId,
        jobId: a.jobId,
        stage: 'new',
        jobStageId: a.jobStageId,
        appliedAt: new Date(),
      },
    });
  }
  console.log('✓ Applications (12 — synced with candidate stages)');

  // ── 6. AI Scores (most candidates get a score) ────────────────────────
  const scores = [
    {
      id: SCORE_YAEL,
      applicationId: APP_YAEL,
      score: 88,
      reasoning:
        'Excellent TypeScript/React match. 7 years aligns with senior requirement. PostgreSQL production experience is a strong plus.',
      strengths: ['TypeScript expert', 'React production experience', 'PostgreSQL'],
      gaps: ['No Kubernetes experience'],
    },
    {
      id: SCORE_DANA,
      applicationId: APP_DANA,
      score: 62,
      reasoning:
        'Solid backend skills but only 4 years experience. Missing React/frontend depth required for this senior fullstack role.',
      strengths: ['Node.js', 'PostgreSQL'],
      gaps: ['Under-experienced for senior role', 'No React'],
    },
    {
      id: SCORE_OMER,
      applicationId: APP_OMER,
      score: 82,
      reasoning:
        'Strong fullstack profile with DevOps bonus. Referral adds confidence. 6 years experience fits the range well.',
      strengths: ['Fullstack TypeScript', 'AWS certified', 'Referral'],
      gaps: ['No PostgreSQL mentioned'],
    },
    {
      id: SCORE_RON,
      applicationId: APP_RON,
      score: 95,
      reasoning:
        'Outstanding candidate. Staff-level experience, system design skills, team leadership. Top of the pipeline.',
      strengths: ['System Design', 'Team leadership', 'Go + TypeScript'],
      gaps: [],
    },
    {
      id: SCORE_EYAL,
      applicationId: APP_EYAL,
      score: 28,
      reasoning: 'Junior developer with 1 year experience. Significantly under-qualified for senior role.',
      strengths: ['Enthusiasm', 'React basics'],
      gaps: ['Only 1 year experience', 'No TypeScript', 'No backend depth'],
    },
    {
      id: SCORE_NOAM,
      applicationId: APP_NOAM,
      score: 85,
      reasoning: 'Strong PM profile with B2B SaaS focus. 4 years experience with data-driven approach and A/B testing.',
      strengths: ['B2B SaaS experience', 'SQL proficiency', 'A/B testing'],
      gaps: ['No enterprise segment experience'],
    },
    {
      id: SCORE_TALI,
      applicationId: APP_TALI,
      score: 58,
      reasoning: 'Early-career PM with good potential. Needs mentoring, may not be ready for mid-level PM role yet.',
      strengths: ['User research', 'Jira workflow'],
      gaps: ['Only 2 years experience', 'No strategy ownership'],
    },
    {
      id: SCORE_SHIRA,
      applicationId: APP_SHIRA,
      score: 91,
      reasoning: 'Excellent ML engineer with NLP specialty. Published research and production MLOps experience.',
      strengths: ['PyTorch expert', 'NLP research', 'MLOps'],
      gaps: ['No Spark experience'],
    },
    {
      id: SCORE_AMIT,
      applicationId: APP_AMIT,
      score: 74,
      reasoning:
        'Strong theoretical foundation from academia. Adjusting to production environment but has solid Python skills.',
      strengths: ['Statistics', 'TensorFlow', 'Research background'],
      gaps: ['Limited industry experience', 'No MLOps'],
    },
    {
      id: SCORE_MAYA,
      applicationId: APP_MAYA,
      score: 83,
      reasoning: 'Well-rounded UX designer with design systems experience. B2B portfolio matches our product domain.',
      strengths: ['Design Systems', 'B2B experience', 'Accessibility'],
      gaps: ['No motion design'],
    },
  ];

  for (const s of scores) {
    await prisma.candidateJobScore.upsert({
      where: { id: s.id },
      update: {},
      create: {
        id: s.id,
        tenantId: TENANT_ID,
        applicationId: s.applicationId,
        score: s.score,
        reasoning: s.reasoning,
        strengths: s.strengths,
        gaps: s.gaps,
        modelUsed: 'claude-sonnet-4-20250514',
        scoredAt: new Date(),
      },
    });
  }
  console.log('✓ AI Scores (10 — shows high-score filter with scores 28–95)');

  // ── 7. Duplicate flag ─────────────────────────────────────────────────
  // Dana and Eyal have similar emails from the same domain — flag as potential dup
  await prisma.duplicateFlag.upsert({
    where: { id: DUP_1 },
    update: {},
    create: {
      id: DUP_1,
      tenantId: TENANT_ID,
      candidateId: C_DANA,
      matchedCandidateId: C_EYAL,
      confidence: 0.72,
      matchFields: ['location', 'skills'],
      reviewed: false,
    },
  });
  console.log('✓ Duplicate flag (1 — Dana ↔ Eyal, unreviewed)');

  console.log('\n✅ Seed complete!');
  console.log('');
  console.log('Summary:');
  console.log('  Jobs table:    5 jobs (filter by open/draft/closed)');
  console.log('  Talent pool:   12 candidates (try high-score, duplicates, referred filters)');
  console.log('  Kanban board:  Select "Senior Software Engineer" → 5 candidates across 4 stages');
  console.log('                 Select "Product Manager" → 3 candidates across 3 stages');
  console.log('                 Select "Data Scientist" → 3 candidates across 3 stages');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
