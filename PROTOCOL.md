# Talent OS - API Protocol (MVP)

This document is the single source of truth for all API endpoints supported by the Talent OS backend.

## General Configuration

- **Base URL**: `http://localhost:3000/api` (or as configured via `VITE_API_URL`)
- **Required Headers** (for all endpoints except webhooks):
  - `Content-Type: application/json`
  - `x-tenant-id`: `phase1-default-tenant` (Targeting multi-tenancy foundation)

---

## 1. Candidates API

### `GET /candidates`

Fetch candidates with optional search and filtering.

**Query Parameters:**

- `q` (optional): Search query matching name, role, or email (case-insensitive substring match)
- `filter` (optional): Filter type
  - `all` — all candidates (default)
  - `high-score` — candidates with AI score ≥ 70
  - `available` — candidates with no hired/rejected applications
  - `referred` — candidates sourced from referral
  - `duplicates` — candidates with unreviewed duplicate flags
- `job_id` (optional): Filter candidates by job UUID (used for Kanban view)
- `unassigned` (optional): `'true'` — filters candidates not yet assigned to any job

**Response:** `200 OK`

```json
{
  "candidates": [
    {
      "id": "uuid",
      "full_name": "John Doe",
      "email": "john@example.com",
      "phone": "+1 555-0100",
      "current_role": "Software Engineer",
      "location": "Tel Aviv",
      "cv_file_url": "https://...",
      "source": "linkedin",
      "source_agency": null,
      "created_at": "ISO8601",
      "ai_score": 85,
      "is_duplicate": false,
      "skills": ["React", "TypeScript"],
      "status": "active",
      "is_rejected": false,
      "stage_summaries": { "uuid": "Summary text for this stage" },
      "job_id": "uuid",
      "hiring_stage_id": "uuid",
      "hiring_stage_name": "Screening",
      "job_title": "Senior Frontend Developer",
      "ai_summary": "Experienced engineer with strong React skills. Recommended for senior roles.",
      "years_experience": 5
    }
  ],
  "total": 1
}
```

### `GET /candidates/:id`

Fetch a single candidate by ID.

**Path Parameters:**

- `id`: Candidate UUID

**Response:** `200 OK`

```json
{
  "id": "uuid",
  "full_name": "User Cohen",
  "email": "test@email.com",
  "phone": "+972-52-000-0000",
  "current_role": "Software Developer",
  "location": "Israel",
  "cv_file_url": "cvs/00000000-0000-0000-0000-000000000001/00000000-0000-0000-0000-000000000000.pdf",
  "source": "direct",
  "source_agency": null,
  "created_at": "2026-03-29T14:24:39.233Z",
  "ai_score": null,
  "is_duplicate": false,
  "skills": [
    "c#",
    "javascript",
    "typescript",
    "node.js",
    "python",
    "java",
    "c++",
    "mongodb",
    "sql",
    "docker",
    "aws",
    "linux",
    "rest apis",
    "kubernetes"
  ],
  "status": "active",
  "is_rejected": false,
  "stage_summaries": {},
  "job_id": "uuid",
  "hiring_stage_id": "uuid",
  "hiring_stage_name": "Screening",
  "job_title": "Senior Frontend Developer",
  "ai_summary": "Experienced engineer with strong React skills. Recommended for senior roles.",
  "years_experience": 5
}
```

**Errors:**

- `404 Not Found` — candidate not found or does not belong to tenant

### `POST /candidates`

Create a new candidate profile, optionally with a CV file upload.

**Content-Type:** `multipart/form-data`

**Form Fields:**

- `cv_file` (optional): CV file (binary upload)
- All other candidate fields as form data (mirroring the body fields below)

**Request Body (JSON fields as form parts):**

```json
{
  "full_name": "John Doe",
  "email": "john@example.com",
  "phone": "+1 555-0100",
  "current_role": "Software Engineer",
  "location": "Tel Aviv",
  "years_experience": 5,
  "skills": ["React", "TypeScript"],
  "ai_summary": null,
  "cv_file_url": null,
  "source": "linkedin",
  "source_agency": null,
  "job_id": "uuid"
}
```

**Notes:**

- `full_name` and `source` are required
- `email`, `phone`, `current_role`, `location`, `years_experience`, `ai_summary`, `source_agency` are nullable
- `job_id` is required — links the candidate to a specific job opening
- `source` must be one of: `linkedin`, `website`, `agency`, `referral`, `direct`, `manual`
- `source_agency` is only relevant when `source = agency`
- `cv_file` upload is binary; the server saves it and manages the `cv_file_url`
- `skills` can be passed as an array, a comma-separated string, or a JSON string

**Response:** `201 Created` (returns full candidate object, same structure as GET /candidates item)

**Errors:**

- `400 Bad Request` — validation failed
- `500 Internal Server Error` — server error

### `GET /candidates/:id/cv-url`

Fetch a presigned S3 URL for a candidate's CV (valid for 1 hour).

**Response:** `200 OK`

```json
{
  "url": "https://..."
}
```

### `PATCH /candidates/:id`

Update candidate profile fields and/or assign to a job pipeline.

**Request Body:** All fields optional

```json
{
  "job_id": "uuid",
  "full_name": "Jane Smith",
  "email": "jane@example.com",
  "phone": "+1 555-0101",
  "current_role": "Product Manager",
  "location": "San Francisco",
  "years_experience": 7
}
```

**Behavior:**

- If `job_id` is provided and candidate has no job: atomically creates Application and sets `hiringStageId` to first enabled stage.
- If `job_id` matches existing assignment: no-op for that field.
- If `job_id` differs from existing assignment: throws 400 ALREADY_ASSIGNED.
- All other fields are optional and updated independently.

**Response:** `200 OK` (returns full CandidateResponse)

**Errors:**

- `400 Bad Request` — validation failed or ALREADY_ASSIGNED
- `400 No Stages` — job has no enabled hiring stages
- `404 Not Found` — candidate not found

### `POST /candidates/:id/reject`

Reject a candidate — sets `candidate.status = 'rejected'` and updates their Application stage to 'rejected'. Idempotent: safe to call multiple times.

**Request Body:** Empty object

```json
{}
```

**Response:** `200 OK` (returns full CandidateResponse with `is_rejected: true`)

**Errors:**

- `404 Not Found` — candidate not found

### `POST /candidates/:id/stages/:stage_id/summary`

Save or update a free-text summary for a specific hiring stage the candidate has gone through. Upserts the CandidateStageSummary record for the `(candidateId, stageId)` pair.

**Path Parameters:**

- `id`: Candidate UUID
- `stage_id`: Hiring stage UUID (must belong to candidate's assigned job)

**Request Body:**

```json
{
  "summary": "Candidate showed strong technical skills and good communication. Recommended for next round."
}
```

**Response:** `200 OK`

```json
{
  "success": true
}
```

**Errors:**

- `404 Not Found` — candidate not found
- `400 Bad Request` — candidate not assigned to a job, or stage does not belong to candidate's job

### `POST /candidates/:id/stages/:stage_id/advance`

Composite action: saves the summary for the current stage AND advances the candidate to the next enabled hiring stage. Stages are ordered by `order` asc; the next stage after `current_stage_id` is selected.

**Path Parameters:**

- `id`: Candidate UUID
- `stage_id`: Current hiring stage UUID

**Request Body:**

```json
{
  "summary": "Ready to move to interview round."
}
```

**Response:** `200 OK`

```json
{
  "success": true,
  "hiring_stage_id": "uuid"
}
```

**Errors:**

- `404 Not Found` — candidate not found
- `400 Bad Request` — candidate not assigned to a job, current stage not found, or candidate already at last stage

### `PATCH /candidates/:id/stage`

Update a candidate's hiring stage (used for Kanban board drag-and-drop).

**Request Body:**

```json
{
  "hiring_stage_id": "uuid"
}
```

**Response:** `200 OK`

```json
{
  "success": true
}
```

### `DELETE /candidates/:id`

Hard-delete a candidate and all related data (applications, scores, flags).

**Response:** `204 No Content`

---

## 2. Jobs API

### `GET /jobs`

Fetch all job openings with hiring stages and screening questions.

**Query Parameters:**

- `status` (optional): Filter by job status — `draft`, `open`, or `closed`. If omitted, all statuses are returned.

**Response:** `200 OK`

```json
{
  "jobs": [
    {
      "id": "uuid",
      "short_id": "42",
      "title": "Senior Frontend Developer",
      "department": "Engineering",
      "location": "Remote",
      "job_type": "full_time",
      "status": "open",
      "hiring_manager": "Jane Smith",
      "candidate_count": 12,
      "created_at": "ISO8601",
      "updated_at": "ISO8601",
      "description": "...",
      "responsibilities": "...",
      "what_we_offer": "...",
      "salary_range": "80K-120K",
      "must_have_skills": ["React", "TypeScript"],
      "nice_to_have_skills": ["Node.js"],
      "min_experience": 3,
      "max_experience": 8,
      "selected_org_types": ["startup", "enterprise"],
      "hiring_flow": [
        {
          "id": "uuid",
          "name": "Application review",
          "is_enabled": true,
          "color": "bg-zinc-400",
          "is_custom": false,
          "order": 1,
          "interviewer": null
        }
      ],
      "screening_questions": [
        {
          "id": "uuid",
          "text": "Do you have React experience?",
          "type": "yes_no",
          "expected_answer": null
        }
      ]
    }
  ],
  "total": 1
}
```

### `GET /jobs/:id`

Fetch a single job by ID, including full hiring flow and screening questions.

**Path Parameters:**

- `id`: Job UUID

**Response:** `200 OK` (same shape as a single item from `GET /jobs`)

```json
{
  "id": "uuid",
  "title": "Senior Frontend Developer",
  "department": "Engineering",
  "location": "Remote",
  "job_type": "full_time",
  "status": "open",
  "hiring_manager": "Jane Smith",
  "candidate_count": 12,
  "created_at": "ISO8601",
  "updated_at": "ISO8601",
  "description": "...",
  "responsibilities": "...",
  "what_we_offer": "...",
  "salary_range": "80K-120K",
  "must_have_skills": ["React", "TypeScript"],
  "nice_to_have_skills": ["Node.js"],
  "min_experience": 3,
  "max_experience": 8,
  "selected_org_types": ["startup", "enterprise"],
  "hiring_flow": [
    {
      "id": "uuid",
      "name": "Application review",
      "is_enabled": true,
      "color": "bg-zinc-400",
      "is_custom": false,
      "order": 1,
      "interviewer": null
    }
  ],
  "screening_questions": [
    {
      "id": "uuid",
      "text": "Do you have React experience?",
      "type": "yes_no",
      "expected_answer": null
    }
  ]
}
```

**Errors:**

- `404 Not Found` — job not found or does not belong to tenant

### `POST /jobs`

Create a new job opening.

**Request Body:**

```json
{
  "title": "Senior Frontend Developer",
  "department": "Engineering",
  "location": "Remote",
  "job_type": "full_time",
  "status": "draft",
  "hiring_manager": "Jane Smith",
  "description": "...",
  "responsibilities": "...",
  "what_we_offer": "...",
  "salary_range": "80K-120K",
  "must_have_skills": ["React", "TypeScript"],
  "nice_to_have_skills": ["Node.js"],
  "min_experience": 3,
  "max_experience": 8,
  "selected_org_types": ["startup", "enterprise"],
  "hiring_flow": [
    {
      "id": "temp-client-uuid",
      "name": "Application review",
      "order": 1,
      "color": "bg-zinc-400",
      "is_enabled": true,
      "is_custom": false,
      "interviewer": null
    }
  ],
  "screening_questions": [
    {
      "id": "temp-client-uuid",
      "text": "Do you have React experience?",
      "type": "yes_no",
      "expected_answer": null,
      "order": 1
    }
  ]
}
```

**Notes:**

- `title` is required
- `hiring_flow[].id` and `screening_questions[].id` are optional — used by the client to pass temp UUIDs; ignored by the server
- If `hiring_flow` is omitted or empty, **8** default stages are seeded automatically:
  `Application Review`, `Screening`, `Interview`, `Offer` (enabled) + `Hired`, `Rejected`, `Pending Decision`, `On Hold` (disabled)
- All other fields are optional with sensible defaults
- At least one hiring stage must be enabled (if provided)
- Screening question `type` must be `yes_no` or `text`

**Response:** `201 Created` (returns full job object, same structure as GET /jobs)

**Errors:**

- `400 Bad Request` — validation failed
- `500 Internal Server Error` — server error

### `PUT /jobs/:id`

Update an existing job opening.

**Path Parameters:**

- `id` (required): Job UUID

**Request Body:** Same structure as POST /jobs

**Response:** `200 OK` (returns updated job object)

**Errors:**

- `400 Bad Request` — validation failed
- `404 Not Found` — job not found
- `500 Internal Server Error` — server error

### `DELETE /jobs/:id`

Soft-delete a job (sets status to `closed`).

**Path Parameters:**

- `id` (required): Job UUID

**Response:** `204 No Content`

**Errors:**

- `404 Not Found` — job not found
- `500 Internal Server Error` — server error

### `DELETE /jobs/:id/hard`

Hard-delete a job and all related data (stages, questions, applications, scores).

- Candidates linked to this job will have their `job_id` and `hiring_stage_id` set to `null`.

**Response:** `204 No Content`

### `GET /jobs/list`

Fetch a lightweight list of open jobs (for dropdowns / job selectors).

**Response:** `200 OK`

```json
{
  "jobs": [{ "id": "uuid", "title": "Senior Frontend Developer", "department": "Engineering" }]
}
```

**Notes:**

- Returns only jobs with `status = open`
- `department` may be `null` if not set on the job
- Intended for use in dropdowns and candidate application forms

---

## 3. Applications API

### `GET /applications`

Fetch all active applications with nested candidate data (for Kanban board).

**Response:** `200 OK`

```json
{
  "applications": [
    {
      "id": "uuid",
      "candidate_id": "uuid",
      "job_id": "uuid",
      "stage": "screening",
      "applied_at": "ISO8601",
      "candidate": {
        "id": "uuid",
        "full_name": "John Doe",
        "email": "john@example.com",
        "cv_file_url": "https://...",
        "ai_score": 85
      }
    }
  ]
}
```

---

## 4. Webhooks API

### `POST /webhooks/email`

Postmark inbound webhook for email-based CV intake.

**Authentication:** `PostmarkAuthGuard` (validates Postmark signature in request headers)

**Request Body:** Postmark inbound email payload

**Response:** `200 OK`

```json
{
  "status": "queued"
}
```

**Behavior:**

- Validates Postmark webhook signature
- Idempotent: returns 200 on duplicate MessageID
- Enqueues email processing to BullMQ for async extraction, dedup, and scoring
- Returns 5xx if enqueue fails (Postmark will retry)

**Errors:**

- `401 Unauthorized` — invalid Postmark signature
- `500 Internal Server Error` — failed to enqueue job (Postmark will retry)

### `GET /webhooks/health`

Health check endpoint for monitoring dependencies.

**Response:** `200 OK` or `503 Service Unavailable`

```json
{
  "status": "ok",
  "db": "ok",
  "redis": "ok"
}
```

**Response Status Codes:**

- `200 OK` — all systems healthy
- `503 Service Unavailable` — one or more dependencies degraded

**Degraded Response Example:**

```json
{
  "status": "degraded",
  "db": "error",
  "redis": "ok"
}
```

---

## 5. Configuration API

### `GET /config`

Fetch configuration options for UI dropdowns and templates.

**Response:** `200 OK`

```json
{
  "departments": ["Engineering", "Product", "Design", "Marketing", "HR", "Sales"],
  "hiring_managers": [
    { "id": "mgr-1", "name": "Yuval Bar Or" },
    { "id": "mgr-2", "name": "Asaf Bar Or" },
    { "id": "mgr-3", "name": "Raanan Sucary" }
  ],
  "job_types": [
    { "id": "full_time", "label": "Full Time" },
    { "id": "part_time", "label": "Part Time" },
    { "id": "contract", "label": "Contract" }
  ],
  "organization_types": [
    { "id": "startup", "label": "Startup" },
    { "id": "enterprise", "label": "Corporate / Enterprise" },
    { "id": "agency", "label": "Agency" },
    { "id": "nonprofit", "label": "Non-profit" }
  ],
  "screening_question_types": [
    { "id": "yes_no", "label": "Yes / No" },
    { "id": "text", "label": "Free Text" }
  ],
  "hiring_stages_template": [
    { "name": "Application Review", "is_enabled": true, "color": "bg-zinc-400", "is_custom": false, "order": 1 },
    { "name": "Screening", "is_enabled": true, "color": "bg-blue-500", "is_custom": false, "order": 2 },
    { "name": "Interview", "is_enabled": true, "color": "bg-indigo-400", "is_custom": false, "order": 3 },
    { "name": "Offer", "is_enabled": true, "color": "bg-emerald-500", "is_custom": false, "order": 4 },
    { "name": "Hired", "is_enabled": false, "color": "bg-green-600", "is_custom": false, "order": 5 },
    { "name": "Rejected", "is_enabled": false, "color": "bg-red-500", "is_custom": false, "order": 6 },
    { "name": "Pending Decision", "is_enabled": false, "color": "bg-yellow-400", "is_custom": false, "order": 7 },
    { "name": "On Hold", "is_enabled": false, "color": "bg-gray-500", "is_custom": false, "order": 8 }
  ],
  "candidate_sources": [
    { "id": "linkedin", "label": "LinkedIn" },
    { "id": "website", "label": "Website" },
    { "id": "agency", "label": "Agency" },
    { "id": "referral", "label": "Referral" },
    { "id": "direct", "label": "Direct" },
    { "id": "manual", "label": "Manual" }
  ]
}
```

---

## Data Enums & Values

### Candidate Source

- `linkedin`, `website`, `agency`, `referral`, `direct`, `manual`

### Application Stage

- `new`, `screening`, `interview`, `offer`, `hired`, `rejected`

### Job Status

- `draft`, `open`, `closed`

### Job Type

- `full_time`, `part_time`, `contract`

### Screening Question Type

- `yes_no`, `text`

---

## 6. Health API

### `GET /health`

System health check for monitoring.

**Response:** `200 OK` or `503 Service Unavailable`

```json
{
  "status": "ok",
  "checks": {
    "database": "ok",
    "redis": "ok"
  },
  "uptime": 3600
}
```

**Degraded Response:**

```json
{
  "status": "degraded",
  "checks": {
    "database": "fail",
    "redis": "ok"
  },
  "uptime": 3600
}
```

---

## Error Response Format

All error responses follow this structure:

```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable error message",
    "details": {}
  }
}
```

**Common Error Codes:**

- `VALIDATION_ERROR` — request validation failed. Includes field-level errors in `details`.
  ```json
  {
    "error": {
      "code": "VALIDATION_ERROR",
      "message": "Validation failed",
      "details": {
        "email": ["Must be a valid email"],
        "full_name": ["Full name is required"]
      }
    }
  }
  ```
- `NOT_FOUND` — requested resource not found
- `UNAUTHORIZED` — authentication failed (webhooks only)

---

## Multi-Tenancy

All endpoints operate within a tenant context:

- Tenant ID is determined by the `x-tenant-id` header or environment config
- All data is automatically filtered by tenant
- No cross-tenant data leakage is possible
