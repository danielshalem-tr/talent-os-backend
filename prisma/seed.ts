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

// Hiring Stages: 8 per job, 24 total
// JOB_SE stages: 00000000-0000-0000-0000-000000002001 to 00000000-0000-0000-0000-000000002008
// JOB_PM stages: 00000000-0000-0000-0000-000000002009 to 00000000-0000-0000-0000-000000002016
// JOB_DS stages: 00000000-0000-0000-0000-000000002017 to 00000000-0000-0000-0000-000000002024
const STAGES_SE = [
  '00000000-0000-0000-0000-000000002001',
  '00000000-0000-0000-0000-000000002002',
  '00000000-0000-0000-0000-000000002003',
  '00000000-0000-0000-0000-000000002004',
  '00000000-0000-0000-0000-000000002005',
  '00000000-0000-0000-0000-000000002006',
  '00000000-0000-0000-0000-000000002007',
  '00000000-0000-0000-0000-000000002008',
];

const STAGES_PM = [
  '00000000-0000-0000-0000-000000002009',
  '00000000-0000-0000-0000-000000002010',
  '00000000-0000-0000-0000-000000002011',
  '00000000-0000-0000-0000-000000002012',
  '00000000-0000-0000-0000-000000002013',
  '00000000-0000-0000-0000-000000002014',
  '00000000-0000-0000-0000-000000002015',
  '00000000-0000-0000-0000-000000002016',
];

const STAGES_DS = [
  '00000000-0000-0000-0000-000000002017',
  '00000000-0000-0000-0000-000000002018',
  '00000000-0000-0000-0000-000000002019',
  '00000000-0000-0000-0000-000000002020',
  '00000000-0000-0000-0000-000000002021',
  '00000000-0000-0000-0000-000000002022',
  '00000000-0000-0000-0000-000000002023',
  '00000000-0000-0000-0000-000000002024',
];

// First hiring stage for JOB_SE (Application Review)
const FIRST_STAGE_SE = STAGES_SE[0];

// Candidate
const C_YAEL = '00000000-0000-0000-0000-000000000101';

// Application
const APP_YAEL = '20000000-0000-0000-0000-000000000001';

// ─── Default hiring stages template ────────────────────────────────────────
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

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('🌱 Seeding database...\n');

  // ── 1. Tenant ─────────────────────────────────────────────────────────
  await prisma.tenant.upsert({
    where: { id: TENANT_ID },
    update: {},
    create: { id: TENANT_ID, name: 'Triolla' },
  });
  console.log('✓ Tenant');

  // ── 2. Jobs ───────────────────────────────────────────────────────────
  const jobs = [
    {
      id: JOB_SE,
      title: 'Senior Software Engineer',
      department: 'Engineering',
      location: 'Tel Aviv, Israel',
      jobType: 'full_time',
      status: 'open',
      description:
        'We are looking for a Senior Software Engineer to join our core platform team and help build the next generation of our product. You will work on scalable backend systems, design APIs, and mentor junior developers.',
      requirements: ['5+ years backend experience', 'PostgreSQL', 'TypeScript'],
      salaryRange: '150,000 - 200,000 ILS/month',
      hiringManager: 'Jane Smith',
      roleSummary: 'Lead engineer for platform infrastructure and backend systems.',
      responsibilities:
        'Design and implement backend services, conduct code reviews, mentor team members, collaborate with product and design teams.',
      whatWeOffer:
        'Competitive salary, health insurance, remote flexibility, professional development budget, stock options.',
      mustHaveSkills: ['TypeScript', 'Node.js', 'PostgreSQL'],
      niceToHaveSkills: ['Docker', 'Kubernetes', 'AWS'],
      expYearsMin: 5,
      expYearsMax: 10,
      preferredOrgTypes: ['Agency', 'Startup', 'Corporate / Enterprise'],
    },
    {
      id: JOB_PM,
      title: 'Product Manager',
      department: 'Product',
      location: 'Tel Aviv, Israel',
      jobType: 'full_time',
      status: 'open',
      description:
        'Join our Product team to define roadmap, work with engineering, and drive user engagement across our B2B SaaS platform. You will own the hiring experience and work closely with our core team.',
      requirements: ['3+ years PM experience', 'B2B SaaS', 'User research'],
      salaryRange: '120,000 - 160,000 ILS/month',
      hiringManager: 'Admin Cohen',
      roleSummary: 'Drive product strategy and roadmap for recruiting platform.',
      responsibilities:
        'Define product vision and roadmap, conduct user interviews, prioritize features, work with engineering and design, analyze metrics.',
      whatWeOffer: 'Competitive salary, health insurance, equity, professional development, flexible hours.',
      mustHaveSkills: ['Product Strategy', 'SQL', 'User Research'],
      niceToHaveSkills: ['Figma', 'Data Analysis'],
      expYearsMin: 3,
      expYearsMax: 7,
      preferredOrgTypes: ['Startup', 'Corporate / Enterprise'],
    },
    {
      id: JOB_DS,
      title: 'Data Scientist',
      department: 'Engineering',
      location: 'Haifa, Israel',
      jobType: 'full_time',
      status: 'open',
      description:
        'Build ML models and data pipelines to power our AI-driven candidate matching and scoring features. Work with our platform team to integrate models into production systems.',
      requirements: ['2+ years ML experience', 'Python', 'Machine learning models'],
      salaryRange: '130,000 - 180,000 ILS/month',
      hiringManager: 'Jane Smith',
      roleSummary: 'Build ML models for intelligent candidate-job matching.',
      responsibilities:
        'Develop ML models for scoring and matching, design data pipelines, evaluate model performance, experiment with new approaches, document findings.',
      whatWeOffer:
        'Competitive salary, health insurance, remote flexibility, GPU access for experiments, research time.',
      mustHaveSkills: ['Python', 'Machine Learning', 'SQL'],
      niceToHaveSkills: ['PyTorch', 'Spark', 'dbt'],
      expYearsMin: 2,
      expYearsMax: 6,
      preferredOrgTypes: ['Corporate / Enterprise', 'Non-profit'],
    },
  ];

  // Determine stage IDs for each job
  const stagesByJobId: Record<string, string[]> = {
    [JOB_SE]: STAGES_SE,
    [JOB_PM]: STAGES_PM,
    [JOB_DS]: STAGES_DS,
  };

  for (const j of jobs) {
    const stageIds = stagesByJobId[j.id];

    // Delete existing job and cascading stages/questions (if re-seeding)
    await prisma.job.deleteMany({
      where: { id: j.id },
    });

    // Create job with nested hiring stages
    await prisma.job.create({
      data: {
        id: j.id,
        tenantId: TENANT_ID,
        title: j.title,
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
            id: stageIds[idx],
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
  console.log('✓ Jobs (3 open)');

  // ── 3. Candidate ──────────────────────────────────────────────────────
  await prisma.candidate.upsert({
    where: { id: C_YAEL },
    update: {
      jobId: JOB_SE,
      hiringStageId: FIRST_STAGE_SE,
    },
    create: {
      id: C_YAEL,
      tenantId: TENANT_ID,
      jobId: JOB_SE,
      hiringStageId: FIRST_STAGE_SE,
      fullName: 'Yael Cohen',
      email: 'yael.cohen@example.com',
      phone: '+972-50-111-2222',
      currentRole: 'Senior Software Engineer',
      location: 'Tel Aviv, Israel',
      yearsExperience: 7,
      skills: ['TypeScript', 'Node.js', 'React', 'PostgreSQL', 'Docker'],
      source: 'direct',
      aiSummary:
        'Senior fullstack engineer with 7 years experience. Strong TypeScript and React skills with production PostgreSQL experience. Excellent fit for senior role.',
    },
  });
  console.log('✓ Candidate (1)');

  // ── 4. Application ────────────────────────────────────────────────────
  await prisma.application.upsert({
    where: { id: APP_YAEL },
    update: {},
    create: {
      id: APP_YAEL,
      tenantId: TENANT_ID,
      candidateId: C_YAEL,
      jobId: JOB_SE,
      jobStageId: FIRST_STAGE_SE,
      stage: 'new',
      appliedAt: new Date(),
    },
  });
  console.log('✓ Application (1)');

  console.log('\n✅ Seed complete!');
  console.log('');
  console.log('Summary:');
  console.log('  Jobs:        3 open positions (SE, PM, DS)');
  console.log('  Candidate:   Yael Cohen (Senior Software Engineer)');
  console.log('  Application: Yael → Senior Software Engineer job');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
