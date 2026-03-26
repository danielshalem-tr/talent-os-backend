# Phase 12 UAT - Support add candidate from UI

## Success Criteria

- [ ] POST /candidates accepts multipart/form-data (with CV file)
- [ ] POST /candidates creates Candidate + Application atomically
- [ ] CV files validated (PDF, DOCX) and uploaded to R2
- [ ] POST /candidates rejects duplicate emails with 409
- [ ] POST /candidates rejects invalid job_id with 404
- [ ] GET /jobs/list returns open jobs with minimal fields

## Automated Test Results

- [x] Unit Tests: 8+ tests passed (CandidatesService)
- [x] Integration Tests: 8+ tests passed (POST /candidates, GET /jobs/list)
- [x] Full Project Tests: 217 passed, 217 total

## Manual Verification (Curl)

- [ ] Test 1: Create candidate WITH CV file
- [ ] Test 2: Create candidate WITHOUT CV file
- [ ] Test 3: Duplicate email (409)
- [ ] Test 4: Missing job_id (404)
- [ ] Test 5: GET /jobs/list
