# Talent OS - API Protocol (MVP)

This document outlines the API contract between the Talent OS Client and Backend for the MVP stage.

## General Configuration
- **Base URL**: `http://localhost:3000/api` (or as configured via `VITE_API_URL`)
- **Required Headers**:
  - `Content-Type: application/json`
  - `x-tenant-id`: `phase1-default-tenant` (Targeting multi-tenancy foundation)

---

## 1. Talent Pool
### `GET /candidates`
Fetch the list of all candidates with support for searching and filtering.

**Query Parameters:**
- `q`: (string) Search query matching name, role, or email.
- `filter`: (enum) `all` | `high-score` | `available` | `referred` | `duplicates`

**Response Body:**
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
      "created_at": "ISO8601",
      "ai_score": 85,
      "is_duplicate": false,
      "skills": ["React", "TypeScript"]
    }
  ],
  "total": 1
}
```

---

## 2. Job Openings
### `GET /jobs`
Fetch the list of all job positions.

**Response Body:**
```json
{
  "jobs": [
    {
      "id": "uuid",
      "title": "Senior Frontend Developer",
      "department": "Engineering",
      "location": "Remote",
      "job_type": "full_time",
      "status": "active",
      "hiring_manager": "Jane Smith",
      "candidate_count": 12,
      "created_at": "ISO8601"
    }
  ],
  "total": 1
}
```

---

## 3. Pipeline (Kanban)
### `GET /applications`
Fetch all active applications, including nested candidate data for the board.

**Response Body:**
```json
{
  "applications": [
    {
      "id": "uuid",
      "candidate_id": "uuid",
      "job_id": "uuid",
      "stage": "screening", // enum: new | screening | interview | offer | hired | rejected
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

## Data Enums & Values

### Candidate Source
- `linkedin`, `website`, `agency`, `referral`, `direct`

### Pipeline Stages
- `new`, `screening`, `interview`, `offer`, `hired`, `rejected`

### Job Status
- `active`, `draft`, `paused`, `closed`

### Job Type
- `full_time`, `part_time`, `contract`
