# Talent OS - API Protocol (MVP)

This document is the single source of truth for all API endpoints supported by the Talent OS backend.

## General Configuration

- **Base URL**: `http://localhost:3000/api` (or as configured via `VITE_API_URL`)
- **Required Headers** (for all endpoints except webhooks):
  - `Content-Type: application/json`
  - `x-tenant-id`: `phase1-default-tenant` (Targeting multi-tenancy foundation)

---

## 1. Candidates API

### `GET /candidates/counts`

Retrieve lightweight counts for dashboard alerts.

**Response:** `200 OK`

```json
{
  "total": 42,
  "duplicates": 3,
  "unassigned": 7
}
```

**Notes:**

- `total` — count of active (non-rejected, non-deleted) candidates
- `duplicates` — count of active candidates with at least one unreviewed duplicate flag. Includes candidates flagged as `phone_missing` (see `is_duplicate` note below)
- `unassigned` — count of active candidates not yet linked to any job

---

### `GET /candidates`

Fetch candidates with optional search and filtering.

**Query Parameters:**

- `q` (optional): Search query matching name, role, or email (case-insensitive substring match)
- `filter` (optional): Filter type
  - `all` — all candidates (default)
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
      "cv_readable": true,
      "is_score_overridden": false,
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
      "years_experience": 5,
      "salary_expectation_min": 10000,
      "salary_expectation_max": 15000
    }
  ],
  "total": 1
}
```

**Notes on `is_duplicate`:**

`is_duplicate: true` means the candidate has at least one unreviewed `duplicate_flag`. There are two distinct cases:

- **Phone match** (`fields: ["phone"]`): Another candidate with the same phone number already exists. Both submissions are stored as separate rows — the existing candidate is not updated. The flag links the new row to the existing one. HR should review and merge manually.
- **Phone missing** (`fields: ["phone_missing"]`): No phone number could be extracted from the CV. This is a data quality flag, not a real duplicate signal. The candidate is flagged for HR review but is not linked to another person.

Do not treat `is_duplicate: true` as a guarantee that two candidate rows represent the same person — always check the flag type.

**Notes on `full_name`:**

For email-ingested CVs, if a candidate name cannot be detected, `full_name` will be `"Unknown Candidate"` (never an empty string).

**Notes on `cv_readable` and `is_score_overridden`:**

- `cv_readable` — derived boolean: `true` when the candidate has non-empty extracted CV text, else `false`. The raw `cv_text` is never returned by the API.
- `is_score_overridden` — `true` when a recruiter has manually set `ai_score`. Auto-scoring (intake + reassignment) will not overwrite the denormalized score while this is `true`.

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
  "cv_readable": true,
  "is_score_overridden": false,
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
  "years_experience": 5,
  "salary_expectation_min": 10000,
  "salary_expectation_max": 15000,
  "latest_call": null
}
```

**Fields:**

- `latest_call` (object | null) — most recent voice screening call, or null:
  `{ "id": "uuid", "status": "scheduled", "attempt": 1, "scheduled_for": "2026-08-30T06:00:00.000Z", "summary": null }`
  Full history: `GET /candidates/:id/calls` (§9).

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
  "salary_expectation_min": 10000,
  "salary_expectation_max": 15000,
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
- `ai_summary` is newline-separated bullet lines — one short fact per line, no leading bullet glyph. May be empty/null when no summary exists. Legacy candidates may still hold a single paragraph; clients must render both forms (no migration).
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

### `GET /candidates/:id/cv-file`

Stream the candidate's CV file bytes **same-origin** (proxied from R2). The client uses this to
render Word (`.docx`) CVs in-browser (docx-preview) and PDF/DOCX thumbnails without a cross-origin
(CORS) fetch of the R2 object. Tenant-scoped; requires an authenticated session.

**Response:** `200 OK` — raw file bytes

- `Content-Type`: the stored file's MIME type (e.g. `application/pdf`, `application/vnd.openxmlformats-officedocument.wordprocessingml.document`)
- `Content-Disposition`: `inline; filename="<candidate>.<ext>"`

**Errors:**

- `404 Not Found` — candidate not found (`NOT_FOUND`) or no CV on file (`NO_CV`)

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
  "years_experience": 7,
  "salary_expectation_min": 10000,
  "salary_expectation_max": 15000,
  "ai_score": 82
}
```

**Behavior:**

- If `job_id` is provided and candidate has no job: atomically creates Application and sets `hiringStageId` to first enabled stage.
- If `job_id` matches existing assignment: no-op for that field.
- If `job_id` differs from existing assignment: throws 400 ALREADY_ASSIGNED.
- If `ai_score` is provided (integer `0–100`): sets the denormalized score and marks `is_score_overridden = true`. Out-of-range or non-integer values return `400 VALIDATION_ERROR`. The override is sticky until reverted.
- All other fields are optional and updated independently.

**Response:** `200 OK` (returns full CandidateResponse)

**Errors:**

- `400 Bad Request` — validation failed or ALREADY_ASSIGNED
- `400 No Stages` — job has no enabled hiring stages
- `404 Not Found` — candidate not found

### `POST /candidates/:id/cv`

Upload a replacement CV. Re-extracts text, regenerates the AI summary, and re-scores the assigned job.

**Content-Type:** `multipart/form-data`

**Form Fields:**

- `cv_file` (required): CV file (binary upload). PDF / DOC / DOCX, ≤ 10 MB.

**Behavior:**

- Stores the file in R2 and updates `cv_file_url`.
- Extracts text into `cv_text` (this flips `cv_readable` to `true`).
- Regenerates `ai_summary`.
- If the candidate has an assigned job and `is_score_overridden` is `false`: re-scores that job and updates `ai_score`. If no job is assigned, the summary is regenerated but no score is written. If overridden, `ai_score` is left untouched.

**Response:** `200 OK` (returns the full candidate object).

**Errors:**

- `400 Bad Request` — missing `cv_file`, file over 10 MB, or invalid file type.
- `404 Not Found` — candidate not found.

### `POST /candidates/:id/score/revert`

Clear a manual score override and return to an AI score.

**Behavior:**

- Sets `is_score_overridden = false`.
- If the candidate has an assigned job and CV text: re-scores immediately and updates `ai_score`.
- If no job is assigned or no CV text exists: sets `ai_score = null`.

**Response:** `200 OK` (returns the full candidate object).

**Errors:**

- `404 Not Found` — candidate not found.

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
      "short_id": "100",
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
      "voice_screening_enabled": false,
      "voice_min_score": 70,
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
  "short_id": "100",
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
  "voice_screening_enabled": false,
  "voice_min_score": 70,
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
  "voice_screening_enabled": false,
  "voice_min_score": 70,
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
- `screening_questions[].order` is optional — defaults to the question's index position (1-based) if omitted
- If `hiring_flow` is omitted or empty, **8** default stages are seeded automatically:
  `Application Review`, `Screening`, `Interview`, `Offer` (enabled) + `Hired`, `Rejected`, `Pending Decision`, `On Hold` (disabled)
- All other fields are optional with sensible defaults
- At least one hiring stage must be enabled (if provided)
- Screening question `type` must be `yes_no` or `text`
- `short_id` in the response is a numeric string auto-assigned by the server, starting at `"100"` and incrementing. Never below 100.

**Response:** `201 Created` (returns full job object, same structure as GET /jobs)

**Errors:**

- `400 Bad Request` — validation failed
- `500 Internal Server Error` — server error

### `PUT /jobs/:id`

Update an existing job opening.

**Path Parameters:**

- `id` (required): Job UUID

**Request Body:** Same structure as POST /jobs

**Behavior:**

- `voice_screening_enabled` / `voice_min_score` are optional and presence-guarded: omitting
  them leaves the stored values unchanged (unlike most job fields, which reset to null).
  `voice_min_score` must be an integer 0–100.

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

Mailgun inbound webhook for email-based CV intake.

**Authentication:** `MailgunAuthGuard` (verifies the HMAC-SHA256 signature in the form fields against `MAILGUN_WEBHOOK_SIGNING_KEY`)

**Request Body:** Mailgun inbound `multipart/form-data` (fields + attachment files), normalized internally to `EmailPayloadDto`

**Response:** `200 OK`

```json
{
  "status": "queued"
}
```

**Behavior:**

- Verifies the Mailgun webhook signature
- Idempotent: returns 200 on duplicate MessageID
- Enqueues email processing to BullMQ for async extraction, dedup, and scoring
- Returns 5xx if enqueue fails (Mailgun will retry)

**Errors:**

- `401 Unauthorized` — invalid Mailgun signature
- `500 Internal Server Error` — failed to enqueue job (Mailgun will retry)

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

## 7. Auth API

All auth endpoints share the base URL `http://localhost:3000/api`.
Session is maintained via an **HTTP-only cookie** (`talent_os_session`) set by the backend.
_(Note for Backend: You must configure CORS with `Access-Control-Allow-Credentials: true` and specify the exact frontend origin, otherwise the browser will reject the cookie)._

---

### `GET /auth/me`

Return the currently authenticated user's session.

**Response:** `200 OK`

```json
{
  "id": "uuid",
  "name": "Sarah Johnson",
  "email": "sarah@company.com",
  "role": "owner",
  "org_id": "uuid",
  "org_name": "Triolla",
  "org_logo_url": "https://cdn.example.com/logos/uuid.png",
  "auth_provider": "google",
  "has_completed_onboarding": true
}
```

**Errors:**

- `401 Unauthorized` — no active session

---

### `POST /auth/google/verify`

Verify a Google OAuth `access_token` obtained from the SPA (via `useGoogleLogin` implicit flow). Backend must use this token to fetch the user's profile from the Google UserInfo endpoint (`https://www.googleapis.com/oauth2/v3/userinfo`), validate the email, and then create/update the session.

**Request Body:**

```json
{ "access_token": "<Google Access Token>" }
```

**Behavior:**

- Backend fetches user info (email, name, picture) using the provided token.
- On new user (sign-up path): creates Tenant + User with `role = 'owner'`
- On returning user: updates session
- If email already exists with a different provider: returns `409 Conflict` with `code: "EMAIL_EXISTS"`

**Response:** `200 OK` — same shape as `GET /auth/me`

**Errors:**

- `400 Bad Request` — missing or malformed `credential`
- `401 Unauthorized` — Google token verification failed
- `409 Conflict` — email exists with a different auth provider (`code: "EMAIL_EXISTS"`)

**Notes:**

- The frontend does NOT redirect. It receives the session and the `RequireGuest` route guard handles in-app navigation.
- The backend sets the `talent_os_session` HttpOnly cookie in the response. All subsequent requests include this cookie automatically because the Axios instance is configured with `withCredentials: true`.

---

### `POST /auth/logout`

Destroy the current session cookie.

**Response:** `200 OK`

```json
{ "success": true }
```

---

### `POST /auth/onboarding`

Complete onboarding for a newly signed-up owner. Sets org name and optional logo.

**Content-Type:** `multipart/form-data`

**Form Fields:**

- `org_name` (required): string
- `logo` (optional): image file — PNG, JPG, or SVG, max 2 MB

**Response:** `200 OK`

```json
{ "success": true }
```

**Errors:**

- `400 Bad Request` — `org_name` missing or invalid
- `401 Unauthorized` — no session
- `409 Conflict` — onboarding already completed

---

### `GET /auth/invite/:token`

Validate an invitation token and return its details. Called before the user clicks "Join".

**Path Parameters:**

- `token`: The one-time invitation token from the magic link

**Response:** `200 OK`

```json
{
  "org_name": "Triolla",
  "role": "member",
  "email": "invitee@company.com"
}
```

**Errors:**

- `404 Not Found` — token does not exist (`NOT_FOUND`)
- `409 Conflict` — token already used (`INVITE_USED`)
- `410 Gone` — token expired (`INVITE_EXPIRED`)

---

### `POST /auth/invite/:token/accept`

Accept an invitation. Creates the user in the DB, marks invitation as accepted, and sets a session cookie.

**Path Parameters:**

- `token`: The one-time invitation token

**Response:** `200 OK` — same shape as `GET /auth/me`

**Errors:**

- `404 Not Found` — token does not exist
- `409 Conflict` — already used
- `410 Gone` — expired

---

### `POST /auth/magic-link`

Send a magic link login email to a returning user who joined via invitation.

**Request Body:**

```json
{ "email": "user@company.com" }
```

**Response:** `200 OK`

```json
{ "success": true }
```

**Notes:**

- Always returns 200 (does not reveal whether email exists, for security)
- If the email belongs to a Google-auth user, the backend sends an email telling them to use Google login instead

---

### `GET /auth/magic-link/verify`

Verify a magic-link login token (the link emailed to the user for returning logins).

**Query Parameters:**

- `token`: magic link token

**Behavior:** Sets session cookie, redirects to `/`

**Errors:**

- `404 Not Found` — invalid token
- `410 Gone` — expired token (redirect to `/login?error=link_expired`)

---

### `GET /auth/team/members`

Fetch all active members of the current tenant.

**Response:** `200 OK`

```json
{
  "members": [
    {
      "id": "uuid",
      "name": "Sarah Johnson",
      "email": "sarah@triolla.io",
      "role": "owner",
      "joined_at": "2025-01-10T00:00:00.000Z",
      "auth_provider": "google"
    }
  ]
}
```

---

### `GET /auth/team/invitations`

Fetch all pending (not yet accepted, not expired) invitations for the current tenant.

**Response:** `200 OK`

```json
{
  "invitations": [
    {
      "id": "uuid",
      "email": "jana@example.com",
      "role": "admin",
      "expires_at": "2026-04-18T00:00:00.000Z"
    }
  ]
}
```

---

### `POST /auth/team/invitations`

Send an invitation email and create an `invitations` record.

**Request Body:**

```json
{
  "email": "colleague@company.com",
  "role": "admin"
}
```

**Response:** `201 Created`

```json
{
  "id": "uuid",
  "email": "colleague@company.com",
  "role": "admin",
  "expires_at": "2026-04-18T00:00:00.000Z"
}
```

**Errors:**

- `409 Conflict` with `code: "ALREADY_MEMBER"` — email is already an active member
- `409 Conflict` with `code: "PENDING_INVITATION"` — pending invitation already exists for this email

---

### `DELETE /auth/team/invitations/:id`

Cancel a pending invitation.

**Response:** `204 No Content`

**Errors:**

- `404 Not Found` — invitation not found

---

### `PATCH /auth/team/members/:id/role`

Change the role of an active member. Owner role cannot be set via this endpoint.

**Request Body:**

```json
{ "role": "admin" }
```

**Response:** `200 OK`

```json
{ "success": true }
```

**Errors:**

- `403 Forbidden` — caller is not Owner, or target is Owner
- `404 Not Found` — member not found

---

### `DELETE /auth/team/members/:id`

Remove an active member from the tenant. Immediately revokes access.

**Response:** `204 No Content`

**Errors:**

- `403 Forbidden` — caller is not Owner, or target is themselves or another Owner
- `404 Not Found` — member not found

## 8. Ingest Control API

Per-tenant kill-switch for AI calls in the email ingest pipeline. While disabled, incoming
emails pass the spam filter and are stored with `processing_status='held'` (no AI calls, no
data loss). Replay re-enqueues all held emails through the normal pipeline.

Roles: `GET` endpoints — any authenticated member. `PATCH` / `POST /replay` — `owner` or `admin` only (403 otherwise).

### `GET /ingest-control`

Response `200`:

```json
{ "ai_ingest_enabled": true, "held_count": 0 }
```

### `PATCH /ingest-control`

Request:

```json
{ "ai_ingest_enabled": false }
```

Response `200`: same shape as `GET /ingest-control`.

### `GET /ingest-control/held`

Held emails, newest first. No pagination (expected volume: dozens).

Response `200`:

```json
{
  "held": [
    { "id": "uuid", "from_email": "agent@agency.co.il", "subject": "CV — Frontend dev", "received_at": "2026-08-11T10:00:00.000Z" }
  ]
}
```

### `POST /ingest-control/replay`

Re-enqueues every held email (`held` → `pending` + queue job). Idempotent — safe to call again after partial failure.

Response `200`:

```json
{ "replayed": 12 }
```

---

## 9. Voice Screening API

AI voice screening calls (ElevenLabs agent over Twilio or a SIP-trunk number). A call is scheduled automatically
after CV scoring when the tenant switch (`voice_calls_enabled`), the job toggle
(`voice_screening_enabled`) and the score threshold (`voice_min_score`) all pass — or manually
from the candidate page. Calls run Sun–Thu 09:00–19:00 Asia/Jerusalem; up to 3 attempts,
4 hours apart. In `test` mode only allowlisted numbers are ever dialed; everything else is
recorded as `blocked` with no outbound call.

After a completed call, a worker job writes an AI screening-call assessment into the
candidate's current stage summary (create-only — an existing recruiter note is never
overwritten) and advances the candidate to the next enabled stage. Failed, unanswered
and blocked calls are never assessed.

Call `status` values: `scheduled | calling | in_progress | completed | no_answer | blocked | canceled | failed`.
Roles: `GET` endpoints — any authenticated member. `POST` call/cancel — any role except `viewer`.
`PUT /voice-control/enabled` — `owner` or `admin` only (403 otherwise).

### `GET /candidates/:id/calls`

All calls for the candidate, newest first.

Response `200`:

```json
{
  "calls": [
    {
      "id": "uuid",
      "job_id": "uuid",
      "job_title": "Frontend Engineer",
      "status": "completed",
      "trigger": "auto",
      "attempt": 1,
      "scheduled_for": "2026-08-30T06:00:00.000Z",
      "started_at": "2026-08-30T06:00:12.000Z",
      "duration_secs": 241,
      "summary": "Candidate confirmed 5 years of React experience...",
      "transcript": [{ "role": "agent", "message": "Hi, is this Dana?", "time_in_call_secs": 0 }],
      "qa_results": {
        "data_collection_results": { "answers": { "value": "1. Yes\n2. 5 years" } },
        "evaluation_criteria_results": { "call_completed": { "result": "success" } },
        "call_successful": "success"
      },
      "audio_available": true,
      "cost": 830,
      "error": null,
      "created_at": "2026-08-27T14:03:00.000Z"
    }
  ]
}
```

### `POST /candidates/:id/call`

Manual "Call now". Skips the job toggle and score threshold; the tenant switch, mode gate and
test-mode allowlist still apply.

Request:

```json
{ "job_id": "uuid" }
```

Response `201`: the created call object (same shape as the list items).

**Errors:**

- `403 FORBIDDEN` — viewer role
- `404 NOT_FOUND` — candidate or job not found
- `409 VOICE_DISABLED` — tenant kill switch is off
- `409 CALL_ACTIVE` — a scheduled/calling/in_progress call already exists for this candidate+job
- `422 NO_PHONE` — candidate has no phone number

### `POST /candidates/:id/calls/:call_id/cancel`

Cancel a `scheduled` call (claim-based: only `scheduled` → `canceled`).

Response `200`: `{ "success": true }`
Errors: `403 FORBIDDEN` (viewer), `409 NOT_CANCELABLE` (already dialing/finished).

### `GET /candidates/:id/calls/:call_id/audio`

Stream the call recording **same-origin** (proxied from R2, `audio/mpeg`), mirroring
`GET /candidates/:id/cv-file`. Tenant-scoped; requires an authenticated session.

**Response:** `200 OK` — raw MP3 bytes (`Content-Disposition: inline`)
**Errors:** `404 NOT_FOUND` (no such call) / `404 NO_AUDIO` (call has no stored recording)

### `GET /voice-control/status`

Response `200`:

```json
{ "voice_calls_enabled": false, "mode": "test", "allowlist_size": 2, "configured": true, "scheduled_count": 0 }
```

`mode` reflects `VOICE_CALL_MODE`; `configured` is true when the ElevenLabs API key, agent id
and phone-number id are all set.

### `PUT /voice-control/enabled`

Tenant kill switch (safety layer 3).

Request:

```json
{ "voice_calls_enabled": true }
```

Response `200`: same shape as `GET /voice-control/status`.

### `POST /webhooks/elevenlabs`

ElevenLabs post-call webhook (no session; HMAC-verified via the `ElevenLabs-Signature` header,
30-minute tolerance). Handled events: `post_call_transcription` (finalizes the call),
`call_initiation_failure` (busy / no-answer retry logic). `post_call_audio` is acknowledged and
ignored — recordings are pulled server-side from the ElevenLabs API. Unknown conversation ids
are acknowledged with `200` and ignored.

Response `200`: `{ "status": "ok" }`
Errors: `401` invalid/missing/stale signature.

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

## PM Bridge Plugin Token (standalone Box)

Used by the standalone PM Bridge widget (`@triolla-io/pmbridge-react`) when
`VITE_PM_BRIDGE_MODE=plugin`. The embedded `/pm-bridge/*` endpoints below remain the
contract while the mode is `embedded`.

### GET /pmb-token

Session-guarded. Mints a 5-minute host-vouch JWT for the logged-in user
(`iss` = `PMB_API_KEY`, `aud` = `pm-bridge-box`, `email` claim, HS256 with
`PMB_SIGNING_SECRET`). The widget sends it as `Authorization: Bearer` to the Box,
which enforces the PM allowlist per tenant.

Response `200`:

```json
{ "token": "eyJhbGciOiJIUzI1NiJ9..." }
```

Errors: `401` no/invalid session · `403` user missing or inactive ·
`503 NOT_CONFIGURED` when `PMB_API_KEY`/`PMB_SIGNING_SECRET` are unset.

## PM Bridge

All routes are under `/api/pm-bridge`. `/converse`, `/commit`, `/decisions`, and `/tracker`
require a session cookie and PM-Bridge allowlist membership. `/holds/:id/{approve,reject}` are public,
gated by a signed token from the notification email. The PM-facing payloads never contain
Jira concepts (issue type, key, epic, acceptance criteria). The tracker endpoints are the
deliberate exception: they surface issue keys and links so the PM can review finished work.

### POST /pm-bridge/converse
Request: `{ "messages": [{ "role": "pm"|"assistant", "content": string }], "page": { "name": string, "route": string } }`
Response (one of):
- `{ "type": "clarify", "questions": [{ "id": string, "prompt": string, "chips": string[], "allowFreeText": boolean }] }`
- `{ "type": "ready", "goal": string, "brief": InternalBrief }`  ← echo `brief` back to /commit unchanged
- `{ "type": "held" }`

### POST /pm-bridge/commit
Request: `{ "brief": InternalBrief, "page": { "name": string, "route": string } }`
Response: `{ "type": "filed" | "merged" | "held" }`

`InternalBrief = { goal, problem, desiredOutcomes: string[], constraints: string[],
affectedArea: { name, route }, sizeHint: "tiny"|"medium"|"large", devNotes: string[],
rawText, conversationDigest }` — opaque to the client; pass through verbatim.

### GET|POST /pm-bridge/holds/:id/approve  · GET|POST /pm-bridge/holds/:id/reject
Public. Query `?t=<signed token>`. GET returns an HTML confirm page; POST performs the action
and returns an HTML result page.

### GET/POST /pm-bridge/decisions · PATCH /pm-bridge/decisions/:id
Unchanged from the existing decisions contract.

### GET /pm-bridge/tracker
Done-review queue: board tickets whose status category became Done in the last 14 days,
minus tickets whose latest review is a `verified` newer than the ticket's Done transition
(a verify older than the latest Done means the ticket was reopened and redone — it reappears).
Response: `{ "tickets": [{ "key": string, "type": string, "summary": string, "doneAt": string (ISO), "url": string }] }`

### POST /pm-bridge/tracker/:key/verify
Marks the ticket verified in the app DB only — Jira is untouched. Append-only, idempotent.
`:key` must match `^[A-Z][A-Z0-9]*-\d+$` → 400 `VALIDATION_ERROR` otherwise.
Response: `{ "status": "verified" }`

### POST /pm-bridge/tracker/:key/reopen
Request: `{ "comment": string }` — required, trimmed, min 3 chars → 400 `VALIDATION_ERROR`.
Posts the comment to the Jira issue ("Reopened via PM Bridge by <email>: …"), transitions it
back to To Do, and records the verdict.
Response: `{ "status": "reopened" }`
Partial failure (comment posted, transition failed): the verdict row is still recorded and the
response is 502 `JIRA_ERROR` with
`message: "Comment posted, but moving the ticket back failed — move it in Jira manually."`

---

## MCP Server (talent-os-mcp)

A third deployable app (entry point `src/mcp.ts`, `Dockerfile.mcp`) that lets a Talent OS
user connect Claude (or any MCP client) as a recruiter copilot over **their own org's data**.
It reuses the backend's services in-process — no HTTP hop — and is scoped per-tenant and
per-role on every call.

- **Base URL**: `https://mcp.talentos.triolla.io` (local dev: `http://localhost:3100`)
- **Transport**: MCP Streamable HTTP (stateless) at `POST /mcp`. `GET`/`DELETE /mcp` → `405`.
- **Health**: `GET /healthz` → `{ "status": "ok" }`.

### Authentication — OAuth 2.1 (DCR + PKCE), federated to Google

The server is its own OAuth 2.1 authorization server (via the MCP SDK's `mcpAuthRouter`) and
federates the actual login to Talent OS's existing Google sign-in.

- **Discovery**:
  - `GET /.well-known/oauth-authorization-server` — AS metadata (`authorization_endpoint`,
    `token_endpoint`, `registration_endpoint`, …).
  - `GET /.well-known/oauth-protected-resource/mcp` — protected-resource metadata.
- **Dynamic Client Registration**: `POST /register` (clients stored in Redis, 90-day TTL).
- **Authorize**: `GET /authorize` (PKCE `code_challenge` required) → renders a Google login
  page. The browser obtains a Google access token and `POST`s it to `/mcp-oauth/complete`,
  which resolves the user, mints a one-time authorization code (Redis, 60s TTL), and redirects
  back to the client with `?code=…&state=…`.
- **Token**: `POST /token` — exchanges the code (PKCE `code_verifier` verified by the SDK) for
  an access token (15 min) + refresh token (30 days, stored in Redis). `grant_type=refresh_token`
  is supported.
- **Bearer**: `POST /mcp` requires `Authorization: Bearer <access_token>`. Missing/invalid →
  `401` with a `WWW-Authenticate` challenge pointing at the protected-resource metadata.

**Token isolation**: MCP access/refresh tokens are JWTs signed with a **dedicated
`MCP_JWT_SECRET`** (distinct from the SPA's `JWT_SECRET`) and carry `scope: "mcp"` plus an
`aud` equal to `MCP_PUBLIC_URL`. Because the secret is separate, an MCP token can never be
replayed against the SPA's `SessionGuard`, and an SPA session token can never be used at `/mcp`.
Token claims: `{ sub, org, role, scope: "mcp", aud }`. Every tool call runs with
`tenantId = token.org`.

### Roles

`viewer` = read-only (read tools only). `member` / `admin` / `owner` = read + write + AI.
Write and AI tools return a tool error for `viewer` callers.

### Tools

| Tool | Kind | Role | What it does |
|------|------|------|--------------|
| `search_candidates` | read | any | Search candidates in the org (`q`, `filter`, `job_id`, `unassigned`) + total. No CV text. |
| `get_candidate` | read | any | Fetch one candidate by id (no CV text). |
| `get_candidate_cv` | read | any | Short-lived presigned URL to the original CV file (never raw text). |
| `list_jobs` | read | any | List jobs (optional `status`) + total. |
| `get_job` | read | any | Fetch one job by id. |
| `get_pipeline` | read | any | Candidates in a job's hiring pipeline (by stage). |
| `dashboard_counts` | read | any | Org summary counts: total, duplicates, unassigned. |
| `move_candidate_stage` | write | member+ | Move a candidate to a hiring stage. |
| `reject_candidate` | write | member+ | Reject a candidate with a reason + optional note. |
| `update_candidate` | write | member+ | Update candidate fields (or reassign job → auto-rescore). |
| `add_stage_summary` | write | member+ | Save a recruiter summary note at a hiring stage. |
| `create_job` | write | member+ | Create a job (`title` required). |
| `update_job` | write | member+ | Update a job by id. |
| `rescore_candidate` | AI | member+ | Re-run AI scoring vs the assigned job; returns score/reasoning/strengths/gaps (inline). |
| `summarize_candidate` | AI | member+ | Generate an AI summary of a candidate (inline). |

Write tools carry MCP annotations (`readOnlyHint`/`destructiveHint`/`idempotentHint`) so MCP
clients can prompt for per-call approval. Tool failures are returned as structured MCP tool
errors (`isError: true`), not thrown transport errors.

### Security hardening

- **Google token audience check**: the federated login verifies the Google token's `aud`
  matches `GOOGLE_CLIENT_ID` (via `tokeninfo`) before trusting the identity — a token minted
  for another OAuth app cannot be replayed to sign in.
- **Rate limits** (also enforce a Cloudflare WAF rate rule at the edge): `/register`, `/token`,
  `/authorize` → 60 / 15 min per IP; `/mcp-oauth/complete` → 20 / min; `/mcp` → 120 / min.
  Over-limit requests receive `429`.
- **DNS-rebinding protection**: `/mcp` validates the `Host` header against the `MCP_PUBLIC_URL`
  host (extendable via `MCP_ALLOWED_HOSTS`); mismatches receive `403`.
- **Transport hardening**: `helmet` security headers, `x-powered-by` disabled, JSON body capped
  at 1 MB.
