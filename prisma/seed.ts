import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

const TENANT_ID = '00000000-0000-0000-0000-000000000001';

// ─── Fixed UUIDs for deterministic, idempotent seeding ──────────────────────

// Jobs
const JOB_DESIGNER = '00000000-0000-0000-0000-000000001001'; // Senior Product UX/UI Designer — pos 100
const JOB_DESIGN_LEAD = '00000000-0000-0000-0000-000000001002'; // Product Design Team Lead — pos 101
const JOB_AM = '00000000-0000-0000-0000-000000001003'; // Account Manager — pos 102
const JOB_SDR = '00000000-0000-0000-0000-000000001004'; // Sales Development Representative — pos 103

// ─── Hiring Stages: 8 per job ────────────────────────────────────────────────
const STAGES_DESIGNER = Array.from(
  { length: 8 },
  (_, i) => `00000000-0000-0000-0000-0000000020${String(i + 1).padStart(2, '0')}`,
);
const STAGES_DESIGN_LEAD = Array.from(
  { length: 8 },
  (_, i) => `00000000-0000-0000-0000-0000000020${String(i + 11).padStart(2, '0')}`,
);
const STAGES_AM = Array.from(
  { length: 8 },
  (_, i) => `00000000-0000-0000-0000-0000000020${String(i + 21).padStart(2, '0')}`,
);
const STAGES_SDR = Array.from(
  { length: 8 },
  (_, i) => `00000000-0000-0000-0000-0000000020${String(i + 31).padStart(2, '0')}`,
);

// Stage index helpers
const S = { APP_REVIEW: 0, SCREENING: 1, INTERVIEW: 2, OFFER: 3, HIRED: 4, REJECTED: 5, PENDING: 6, ON_HOLD: 7 };

// ─── Candidates ──────────────────────────────────────────────────────────────
const C_MAYA = '00000000-0000-0000-0000-000000000101';
const C_NOAM = '00000000-0000-0000-0000-000000000102';
const C_SHIRA = '00000000-0000-0000-0000-000000000103';
const C_AMIT = '00000000-0000-0000-0000-000000000104';
const C_DANA = '00000000-0000-0000-0000-000000000105';
const C_YONATAN = '00000000-0000-0000-0000-000000000106';
const C_NETA = '00000000-0000-0000-0000-000000000107';
const C_ERAN = '00000000-0000-0000-0000-000000000108';
const C_LIHI = '00000000-0000-0000-0000-000000000109';
const C_RON = '00000000-0000-0000-0000-000000000110';

// ─── Applications ─────────────────────────────────────────────────────────────
const APP_BASE = '20000000-0000-0000-0000-0000000000';

// Application IDs (for cross-referencing scores)
const APP_IDS = {
  MAYA: `${APP_BASE}01`,
  NOAM: `${APP_BASE}02`,
  SHIRA: `${APP_BASE}03`,
  AMIT: `${APP_BASE}04`,
  DANA: `${APP_BASE}05`,
  YONATAN: `${APP_BASE}06`,
  NETA: `${APP_BASE}07`,
  ERAN: `${APP_BASE}08`,
  LIHI: `${APP_BASE}09`,
  RON: `${APP_BASE}10`,
};

// ─── Scores ───────────────────────────────────────────────────────────────────
const SCORE_BASE = '30000000-0000-0000-0000-0000000000';

// ─── Stage Summaries ──────────────────────────────────────────────────────────
const SUMMARY_BASE = '40000000-0000-0000-0000-0000000000';

// ─── Default hiring stages template ──────────────────────────────────────────
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
      id: JOB_DESIGNER,
      shortId: '100',
      title: 'Senior Product UX/UI Designer',
      department: 'Design',
      location: 'Tel Aviv, Israel',
      jobType: 'full_time',
      status: 'open',
      description:
        "We're looking for someone with strong UX skills, Figma expertise, and experience working on complex platforms and design systems. You should feel comfortable collaborating with clients, product managers, and developers, and bring a clear, positive communication style to the team.\n\nCome design the future with us.",
      requirements: [
        'Proficient in Figma with experience building scalable design systems',
        'Experience designing complex B2B platforms',
        'Strong UX thinking — research, flow mapping, wireframes, usability',
        'Experience working with clients, PMs, and developers',
        '2–3 years of UI/UX industry experience',
      ],
      salaryRange: null,
      hiringManager: 'Yuval Bar Or',
      roleSummary: 'Design complex B2B digital products end-to-end, from research to high-fidelity delivery.',
      responsibilities:
        'Own end-to-end UX design for client projects, build and maintain design system components, collaborate with developers during implementation, present work to clients, contribute to design critique and team culture.',
      whatWeOffer:
        'Creative and collaborative environment, exposure to diverse clients, design system ownership, professional growth, hybrid work model.',
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
      title: 'Product Design Team Lead / Manager',
      department: 'Design',
      location: 'Tel Aviv, Israel',
      jobType: 'full_time',
      status: 'open',
      description:
        "We're looking for a Product Design Team Leader to join Triolla and lead a talented team of 3–4 designers, driving high-impact projects and shaping exceptional digital experiences.",
      requirements: [
        '4+ years of experience in UX/UI design',
        '1–2 years in a leadership or mentorship role',
        'Proven ability to lead end-to-end product design processes',
        'Hands-on expertise in Figma, design systems, and complex digital platforms',
        'Strong communication skills with PMs, developers, and clients',
      ],
      salaryRange: null,
      hiringManager: 'Yuval Bar Or',
      roleSummary: 'Lead a team of 3–4 designers across multiple client projects and drive design excellence.',
      responsibilities:
        'Manage and mentor a team of product designers, define design processes and standards, lead design reviews, work closely with clients and stakeholders, contribute hands-on to key projects.',
      whatWeOffer:
        'Leadership role with real impact, strong team culture, diverse client portfolio, professional development support, hybrid work model.',
      mustHaveSkills: ['Figma', 'UX/UI Design', 'Design Systems', 'Team Leadership'],
      niceToHaveSkills: ['Design Ops', 'Client Management', 'Agile / Scrum'],
      expYearsMin: 4,
      expYearsMax: 10,
      preferredOrgTypes: ['Agency', 'Corporate / Enterprise'],
      stages: STAGES_DESIGN_LEAD,
    },
    {
      id: JOB_AM,
      shortId: '102',
      title: 'Account Manager',
      department: 'Sales',
      location: 'Tel Aviv, Israel',
      jobType: 'full_time',
      status: 'open',
      description: `Manage and support our customers in the high-tech and startup sectors, primarily in the field of software development. You'll be the go-to person for their needs and concerns, building and nurturing strong, long-term relationships.\n\nYour role will also include identifying opportunities for upselling and cross-selling our services, with a focus on driving growth and increasing overall sales.`,
      requirements: [
        '2+ years of experience in account management or customer success',
        'Preferably in the tech or startup ecosystem',
        'Strong interpersonal skills',
        'Excellent communication skills in Hebrew and English',
        'Ability to identify growth opportunities through upselling and cross-selling',
        'Highly organized, independent, and detail-oriented',
      ],
      salaryRange: null,
      hiringManager: 'Raanan Sucary',
      roleSummary: "Own and grow relationships with high-tech and startup clients across Triolla's service portfolio.",
      responsibilities:
        'Manage a portfolio of client accounts, serve as the primary point of contact, identify upsell and cross-sell opportunities, collaborate with delivery teams to ensure client satisfaction, report on account health and growth.',
      whatWeOffer:
        'Dynamic client-facing role, exposure to exciting tech companies, performance bonuses, collaborative team, career growth path.',
      mustHaveSkills: ['Account Management', 'Client Relations', 'Hebrew', 'English'],
      niceToHaveSkills: ['CRM tools', 'Upselling', 'Tech / SaaS industry knowledge'],
      expYearsMin: 2,
      expYearsMax: 6,
      preferredOrgTypes: ['Agency', 'Startup', 'Corporate / Enterprise'],
      stages: STAGES_AM,
    },
    {
      id: JOB_SDR,
      shortId: '103',
      title: 'Sales Development Representative (SDR)',
      department: 'Sales',
      location: 'Tel Aviv, Israel',
      jobType: 'full_time',
      status: 'open',
      description:
        "We're looking for a motivated SDR to identify, engage, and qualify potential leads, helping drive growth for our sales team in the tech and product design space.",
      requirements: [
        '1–2 years of experience in sales, lead generation, or SDR roles',
        'Preferably in tech or SaaS',
        'Strong communication skills in Hebrew and English',
        'Comfortable with CRM tools, email outreach, and LinkedIn prospecting',
        'Highly organized and self-motivated',
      ],
      salaryRange: null,
      hiringManager: 'Raanan Sucary',
      roleSummary: "Generate and qualify new business leads for Triolla's tech and product design services.",
      responsibilities:
        'Prospect and qualify inbound and outbound leads, conduct initial outreach via email and LinkedIn, schedule discovery calls for account executives, maintain CRM hygiene, report on pipeline metrics.',
      whatWeOffer:
        'Fast-paced sales environment, clear career progression, commission structure, strong team support, training and development.',
      mustHaveSkills: ['Lead Generation', 'LinkedIn Prospecting', 'Hebrew', 'English', 'CRM'],
      niceToHaveSkills: ['Salesforce', 'HubSpot', 'Cold Calling'],
      expYearsMin: 1,
      expYearsMax: 3,
      preferredOrgTypes: ['Agency', 'Startup'],
      stages: STAGES_SDR,
    },
  ];

  for (const j of jobs) {
    // Delete existing job and cascading stages/questions (if re-seeding)
    await prisma.job.deleteMany({ where: { id: j.id } });

    // Create job with nested hiring stages
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
  console.log('✓ Jobs (4 open positions)');

  // ── 3. Candidates ────────────────────────────────────────────────────────────
  //
  // Designer role (pos 100) — 4 candidates spread across pipeline
  // Design Lead role (pos 101) — 2 candidates
  // Account Manager (pos 102) — 2 candidates
  // SDR (pos 103) — 2 candidates

  const candidates = [
    // ── Senior Product UX/UI Designer ──────────────────────────────────────
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
        'Mid-senior UX/UI designer with 3 years of experience at a B2B SaaS startup. Strong Figma skills and a solid portfolio of complex platform design. Good cultural fit — communicative and collaborative. Currently at Interview stage.',
    },
    {
      id: C_NOAM,
      jobId: JOB_DESIGNER,
      stageId: STAGES_DESIGNER[S.SCREENING],
      fullName: 'Noam Ben-David',
      email: 'noam.bd@outlook.com',
      phone: '+972-54-202-3344',
      currentRole: 'UI Designer',
      location: 'Ramat Gan, Israel',
      yearsExperience: 2,
      skills: ['Figma', 'UI Design', 'Component Libraries', 'Zeplin'],
      source: 'direct',
      aiSummary:
        'Junior-to-mid UI designer with 2 years of experience. Strong visual design sense but lighter on UX process and research. Progressing through Screening — worth assessing UX depth.',
    },
    {
      id: C_SHIRA,
      jobId: JOB_DESIGNER,
      stageId: STAGES_DESIGNER[S.OFFER],
      fullName: 'Shira Katz',
      email: 'shira.katz.design@gmail.com',
      phone: '+972-50-900-5577',
      currentRole: 'Senior UX Designer',
      location: 'Tel Aviv, Israel',
      yearsExperience: 4,
      skills: ['Figma', 'UX Design', 'Design Systems', 'User Research', 'B2B Platforms', 'Client Presentations'],
      source: 'referral',
      aiSummary:
        'Strong senior UX designer with 4 years of experience, including agency-side work. Excellent communicator with client-facing experience. Currently at Offer stage — top candidate.',
    },
    {
      id: C_AMIT,
      jobId: JOB_DESIGNER,
      stageId: STAGES_DESIGNER[S.REJECTED],
      fullName: 'Amit Rozenberg',
      email: 'amitrozenberg@gmail.com',
      phone: '+972-53-700-8899',
      currentRole: 'Graphic Designer',
      location: 'Herzliya, Israel',
      yearsExperience: 5,
      skills: ['Adobe XD', 'Photoshop', 'Illustrator', 'UI Design'],
      source: 'direct',
      aiSummary:
        'Experienced graphic designer transitioning into product design. Lacks hands-on Figma and UX platform experience required for this role. Not a fit at this stage — marked Rejected.',
    },

    // ── Product Design Team Lead ─────────────────────────────────────────────
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
    {
      id: C_YONATAN,
      jobId: JOB_DESIGN_LEAD,
      stageId: STAGES_DESIGN_LEAD[S.APP_REVIEW],
      fullName: 'Yonatan Shahar',
      email: 'yonatan.shahar@gmail.com',
      phone: '+972-54-550-6677',
      currentRole: 'Senior UX Designer',
      location: 'Haifa, Israel',
      yearsExperience: 5,
      skills: ['Figma', 'UX Design', 'Design Systems', 'Product Strategy'],
      source: 'direct',
      aiSummary:
        'Senior designer with strong individual contributor experience. Some informal mentorship but no formal leadership role yet. Application under review — needs assessment on leadership readiness.',
    },

    // ── Account Manager ──────────────────────────────────────────────────────
    {
      id: C_NETA,
      jobId: JOB_AM,
      stageId: STAGES_AM[S.INTERVIEW],
      fullName: 'Neta Avraham',
      email: 'neta.avraham@gmail.com',
      phone: '+972-50-123-9988',
      currentRole: 'Customer Success Manager',
      location: 'Tel Aviv, Israel',
      yearsExperience: 3,
      skills: ['Account Management', 'Customer Success', 'CRM', 'Upselling', 'Hebrew', 'English'],
      source: 'linkedin',
      aiSummary:
        'CS Manager with 3 years at a B2B SaaS company in the startup space. Strong relationship-builder with a proven record of expansion revenue. Great fit for the AM role.',
    },
    {
      id: C_ERAN,
      jobId: JOB_AM,
      stageId: STAGES_AM[S.INTERVIEW],
      fullName: 'Eran Mizrahi',
      email: 'eran.mizrahi.biz@gmail.com',
      phone: '+972-52-800-4455',
      currentRole: 'Account Executive',
      location: 'Petah Tikva, Israel',
      yearsExperience: 4,
      skills: ['Sales', 'Account Management', 'Hebrew', 'English', 'HubSpot'],
      source: 'referral',
      aiSummary:
        'Account Executive with a sales-heavy background. Strong closer but less proven in ongoing relationship management. Pending decision — team is evaluating CS vs. AE orientation.',
    },

    // ── SDR ──────────────────────────────────────────────────────────────────
    {
      id: C_LIHI,
      jobId: JOB_SDR,
      stageId: STAGES_SDR[S.SCREENING],
      fullName: 'Lihi Golan',
      email: 'lihi.golan.sales@gmail.com',
      phone: '+972-54-300-7788',
      currentRole: 'Sales Representative',
      location: 'Tel Aviv, Israel',
      yearsExperience: 1,
      skills: ['Lead Generation', 'LinkedIn Sales Navigator', 'CRM', 'Hebrew', 'English', 'Cold Outreach'],
      source: 'linkedin',
      aiSummary:
        'Early-career SDR with 1 year in a SaaS company. Strong outreach metrics and positive attitude. Progressing to screening — promising profile for the role.',
    },
    {
      id: C_RON,
      jobId: JOB_SDR,
      stageId: STAGES_SDR[S.APP_REVIEW],
      fullName: 'Ron Peretz',
      email: 'ron.peretz93@gmail.com',
      phone: '+972-50-444-2211',
      currentRole: 'Marketing Coordinator',
      location: 'Tel Aviv, Israel',
      yearsExperience: 2,
      skills: ['Email Marketing', 'LinkedIn', 'CRM', 'Hebrew', 'English'],
      source: 'direct',
      aiSummary:
        'Marketing background with some lead gen exposure. Interested in transitioning into sales. Application under review — needs evaluation on sales aptitude and motivation.',
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
  console.log('✓ Candidates (10)');

  // ── 4. Applications ──────────────────────────────────────────────────────────
  const applications = [
    // Designer
    {
      idx: '01',
      candidateId: C_MAYA,
      jobId: JOB_DESIGNER,
      stageId: STAGES_DESIGNER[S.INTERVIEW],
      stage: 'interview',
      daysAgo: 14,
    },
    {
      idx: '02',
      candidateId: C_NOAM,
      jobId: JOB_DESIGNER,
      stageId: STAGES_DESIGNER[S.SCREENING],
      stage: 'screening',
      daysAgo: 7,
    },
    {
      idx: '03',
      candidateId: C_SHIRA,
      jobId: JOB_DESIGNER,
      stageId: STAGES_DESIGNER[S.OFFER],
      stage: 'offer',
      daysAgo: 21,
    },
    {
      idx: '04',
      candidateId: C_AMIT,
      jobId: JOB_DESIGNER,
      stageId: STAGES_DESIGNER[S.REJECTED],
      stage: 'rejected',
      daysAgo: 10,
    },
    // Design Lead
    {
      idx: '05',
      candidateId: C_DANA,
      jobId: JOB_DESIGN_LEAD,
      stageId: STAGES_DESIGN_LEAD[S.INTERVIEW],
      stage: 'interview',
      daysAgo: 10,
    },
    {
      idx: '06',
      candidateId: C_YONATAN,
      jobId: JOB_DESIGN_LEAD,
      stageId: STAGES_DESIGN_LEAD[S.APP_REVIEW],
      stage: 'new',
      daysAgo: 2,
    },
    // Account Manager
    { idx: '07', candidateId: C_NETA, jobId: JOB_AM, stageId: STAGES_AM[S.INTERVIEW], stage: 'interview', daysAgo: 8 },
    { idx: '08', candidateId: C_ERAN, jobId: JOB_AM, stageId: STAGES_AM[S.INTERVIEW], stage: 'interview', daysAgo: 15 },
    {
      idx: '09',
      candidateId: C_LIHI,
      jobId: JOB_SDR,
      stageId: STAGES_SDR[S.SCREENING],
      stage: 'screening',
      daysAgo: 5,
    },
    { idx: '10', candidateId: C_RON, jobId: JOB_SDR, stageId: STAGES_SDR[S.APP_REVIEW], stage: 'new', daysAgo: 1 },
  ];

  for (const app of applications) {
    const appliedAt = new Date();
    appliedAt.setDate(appliedAt.getDate() - app.daysAgo);

    await prisma.application.upsert({
      where: { id: `${APP_BASE}${app.idx}` },
      update: {},
      create: {
        id: `${APP_BASE}${app.idx}`,
        tenantId: TENANT_ID,
        candidateId: app.candidateId,
        jobId: app.jobId,
        jobStageId: app.stageId,
        stage: app.stage,
        appliedAt,
      },
    });
  }
  console.log('✓ Applications (10)');

  // ── 5. CandidateJobScores ─────────────────────────────────────────────────────
  const scores = [
    {
      idx: '1',
      appId: APP_IDS.MAYA,
      score: 78,
      reasoning:
        'Mid-senior UX/UI designer with strong Figma and B2B SaaS platform experience. Meets core requirements.',
      strengths: ['Figma', 'UX Research', 'B2B SaaS', 'Design Systems'],
      gaps: ['Limited agency-side experience', 'Prototyping depth unclear'],
    },
    {
      idx: '2',
      appId: APP_IDS.NOAM,
      score: 62,
      reasoning: 'Strong visual UI skills but lighter on UX process and research depth required for this role.',
      strengths: ['Figma', 'UI Design', 'Component Libraries'],
      gaps: ['UX process & research', 'No B2B platform experience'],
    },
    {
      idx: '3',
      appId: APP_IDS.SHIRA,
      score: 88,
      reasoning:
        'Senior UX designer with agency and B2B experience. Excellent communicator. Top candidate for the role.',
      strengths: ['Figma', 'UX Design', 'Design Systems', 'Client Presentations', 'User Research'],
      gaps: ['None significant'],
    },
    {
      idx: '4',
      appId: APP_IDS.AMIT,
      score: 35,
      reasoning:
        'Graphic design background without Figma or UX platform experience. Not a fit for this role at this stage.',
      strengths: ['Visual design', 'Adobe Suite'],
      gaps: ['No Figma', 'No UX process', 'No B2B platforms', 'No design systems'],
    },
    {
      idx: '5',
      appId: APP_IDS.DANA,
      score: 91,
      reasoning:
        'Experienced design lead with 6 years in product design and 2 years managing a team of 3. Excellent leadership profile.',
      strengths: ['Team Leadership', 'Figma', 'Design Systems', 'Client Management', 'Mentorship'],
      gaps: ['None significant'],
    },
    {
      idx: '6',
      appId: APP_IDS.YONATAN,
      score: 72,
      reasoning: 'Strong IC with solid UX skills. Some informal mentorship but no formal leadership role yet.',
      strengths: ['Figma', 'UX Design', 'Design Systems', 'Product Strategy'],
      gaps: ['No formal leadership experience', 'Location in Haifa may affect availability'],
    },
    {
      idx: '7',
      appId: APP_IDS.NETA,
      score: 80,
      reasoning: 'CS Manager with B2B SaaS background and proven expansion revenue track record. Strong AM candidate.',
      strengths: ['Account Management', 'Customer Success', 'CRM', 'Upselling'],
      gaps: ['More CS-oriented than pure AM'],
    },
    {
      idx: '8',
      appId: APP_IDS.ERAN,
      score: 65,
      reasoning: 'Strong AE and closer, but less proven in ongoing relationship management. Mixed signals for AM role.',
      strengths: ['Sales', 'Account Management', 'HubSpot', 'Closing'],
      gaps: ['Ongoing relationship management depth', 'CS orientation vs. AE'],
    },
    {
      idx: '9',
      appId: APP_IDS.LIHI,
      score: 74,
      reasoning: 'Early-career SDR with strong outreach metrics and positive attitude. Promising fit for the role.',
      strengths: ['Lead Generation', 'LinkedIn Sales Navigator', 'CRM', 'Cold Outreach'],
      gaps: ['Only 1 year experience', 'No formal closing experience'],
    },
    {
      idx: '10',
      appId: APP_IDS.RON,
      score: 55,
      reasoning: 'Marketing background with some lead gen exposure. Sales aptitude and motivation need evaluation.',
      strengths: ['Email Marketing', 'LinkedIn', 'CRM'],
      gaps: ['No dedicated SDR experience', 'Unclear sales motivation'],
    },
  ];

  for (const s of scores) {
    await prisma.candidateJobScore.upsert({
      where: { id: `${SCORE_BASE}${s.idx.padStart(2, '0')}` },
      update: {},
      create: {
        id: `${SCORE_BASE}${s.idx.padStart(2, '0')}`,
        tenantId: TENANT_ID,
        applicationId: s.appId,
        score: s.score,
        reasoning: s.reasoning,
        strengths: s.strengths,
        gaps: s.gaps,
        modelUsed: 'claude-sonnet-4-6',
      },
    });
  }
  console.log('✓ CandidateJobScores (10)');

  // ── 6. CandidateStageSummaries ────────────────────────────────────────────────
  // Required for candidates at stage > APP_REVIEW — one summary per preceding stage.
  const stageSummaries = [
    // C_MAYA at Interview — needs APP_REVIEW and SCREENING summaries
    {
      idx: '01',
      candidateId: C_MAYA,
      stageId: STAGES_DESIGNER[S.APP_REVIEW],
      summary:
        'Application reviewed: Strong Figma portfolio and B2B SaaS platform background. Meets core requirements. Advanced to Screening.',
    },
    {
      idx: '02',
      candidateId: C_MAYA,
      stageId: STAGES_DESIGNER[S.SCREENING],
      summary:
        'Phone screen completed: Good communication, clear UX process, comfortable with client collaboration. Advancing to Interview.',
    },
    // C_NOAM at Screening — needs APP_REVIEW summary
    {
      idx: '03',
      candidateId: C_NOAM,
      stageId: STAGES_DESIGNER[S.APP_REVIEW],
      summary:
        'Application reviewed: Solid UI work, lighter on UX process and research. Moved to Screening for deeper evaluation.',
    },
    // C_SHIRA at Offer — needs APP_REVIEW, SCREENING, and INTERVIEW summaries
    {
      idx: '04',
      candidateId: C_SHIRA,
      stageId: STAGES_DESIGNER[S.APP_REVIEW],
      summary:
        'Application reviewed: Senior UX designer with agency and B2B experience. Excellent portfolio. Advanced to Screening.',
    },
    {
      idx: '05',
      candidateId: C_SHIRA,
      stageId: STAGES_DESIGNER[S.SCREENING],
      summary:
        'Phone screen: Outstanding communicator with a clear, structured design process. Strong client-facing presence. Moving to Interview.',
    },
    {
      idx: '06',
      candidateId: C_SHIRA,
      stageId: STAGES_DESIGNER[S.INTERVIEW],
      summary:
        'Interview completed: Exceptional design system expertise and client presentation skills. Unanimously recommended for offer.',
    },
    // C_AMIT at Rejected — needs APP_REVIEW summary (rejected at review stage)
    {
      idx: '07',
      candidateId: C_AMIT,
      stageId: STAGES_DESIGNER[S.APP_REVIEW],
      summary:
        'Application reviewed: Graphic design background without Figma or UX platform experience. Does not meet core requirements. Marked as rejected.',
    },
    // C_DANA at Interview — needs APP_REVIEW and SCREENING summaries
    {
      idx: '08',
      candidateId: C_DANA,
      stageId: STAGES_DESIGN_LEAD[S.APP_REVIEW],
      summary:
        'Application reviewed: Experienced design lead with team management history. Strong portfolio and leadership credentials. Advanced to Screening.',
    },
    {
      idx: '09',
      candidateId: C_DANA,
      stageId: STAGES_DESIGN_LEAD[S.SCREENING],
      summary:
        'Phone screen: Clear leadership philosophy, strong mentorship examples, confident with client communication. Advancing to Interview.',
    },
    // C_NETA at Interview — needs APP_REVIEW and SCREENING summaries
    {
      idx: '10',
      candidateId: C_NETA,
      stageId: STAGES_AM[S.APP_REVIEW],
      summary:
        'Application reviewed: CS Manager with B2B SaaS background and proven expansion revenue. Matches AM requirements well. Advanced to Screening.',
    },
    {
      idx: '11',
      candidateId: C_NETA,
      stageId: STAGES_AM[S.SCREENING],
      summary:
        'Phone screen: Strong relationship-building instincts, clear understanding of account growth dynamics. Advancing to Interview.',
    },
    // C_ERAN at Pending — needs APP_REVIEW and SCREENING summaries
    {
      idx: '12',
      candidateId: C_ERAN,
      stageId: STAGES_AM[S.APP_REVIEW],
      summary:
        'Application reviewed: AE with solid closing track record. Some uncertainty on ongoing relationship management depth. Moving to Screening.',
    },
    {
      idx: '13',
      candidateId: C_ERAN,
      stageId: STAGES_AM[S.SCREENING],
      summary:
        'Phone screen: Strong sales orientation, less clarity on CS-style relationship work. Team needs more time to evaluate fit — moving to Pending Decision.',
    },
    // C_LIHI at Screening — needs APP_REVIEW summary
    {
      idx: '14',
      candidateId: C_LIHI,
      stageId: STAGES_SDR[S.APP_REVIEW],
      summary:
        'Application reviewed: Early-career SDR with promising outreach metrics and positive attitude. Matches SDR profile. Moving to Screening.',
    },
  ];

  for (const ss of stageSummaries) {
    await prisma.candidateStageSummary.upsert({
      where: { idx_cand_stage_summary: { candidateId: ss.candidateId, jobStageId: ss.stageId } },
      update: {},
      create: {
        id: `${SUMMARY_BASE}${ss.idx}`,
        tenantId: TENANT_ID,
        candidateId: ss.candidateId,
        jobStageId: ss.stageId,
        summary: ss.summary,
      },
    });
  }
  console.log('✓ CandidateStageSummaries (14)');

  console.log('\n✅ Seed complete!\n');
  console.log('Summary:');
  console.log('  Jobs:');
  console.log('    100 — Senior Product UX/UI Designer  (4 candidates: Offer, Interview, Screening, Rejected)');
  console.log('    101 — Product Design Team Lead        (2 candidates: Interview, Application Review)');
  console.log('    102 — Account Manager                 (2 candidates: Interview, Pending Decision)');
  console.log('    103 — Sales Development Representative(2 candidates: Screening, Application Review)');
  console.log('  Candidates:        10 total');
  console.log('  Applications:      10 total');
  console.log('  CandidateScores:   10 total');
  console.log('  StageSummaries:    14 total');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
