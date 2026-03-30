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
      "job_id": "uuid",
      "hiring_stage_id": "uuid",
      "hiring_stage_name": "Screening",
      "job_title": "Senior Frontend Developer"
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
  "job_id": "uuid",
  "hiring_stage_id": "uuid",
  "hiring_stage_name": "Screening",
  "job_title": "Senior Frontend Developer"
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
  "cv_url": "https://..."
}
```

### `PATCH /candidates/:id/stage`

Update a candidate's hiring stage (used for Kanban board drag-and-drop).

**Request Body:**

```json
{
  "stage_id": "uuid"
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
  "departments": ["Engineering", "Product", "Design", "Marketing", "HR"],
  "hiring_managers": [
    { "id": "mgr-1", "name": "Jane Smith" },
    { "id": "mgr-2", "name": "Admin Cohen" }
  ],
  "job_types": [
    { "id": "full_time", "label": "Full Time" },
    { "id": "part_time", "label": "Part Time" },
    { "id": "contract", "label": "Contract" }
  ],
  "organization_types": [
    { "id": "startup", "label": "Startup" },
    { "id": "enterprise", "label": "Enterprise" },
    { "id": "nonprofit", "label": "Nonprofit" }
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
