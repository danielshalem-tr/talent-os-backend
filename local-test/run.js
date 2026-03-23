#!/usr/bin/env node
/**
 * Local manual test runner for the Telent-OS email intake flow.
 *
 * Usage:
 *   node local-test/run.js                     # send all files in local-test/files/
 *   node local-test/run.js cv.pdf              # send a specific file from local-test/files/
 *   node local-test/run.js --health            # just check health endpoint
 *
 * Prerequisites:
 *   - docker compose up --build (API on port 3000)
 *   - docker compose exec api npx prisma db seed  (tenant + job must exist)
 *
 * After running, open Prisma Studio (http://localhost:5555 or whatever port) and check:
 *   1. email_intake_log  → processing_status should go pending → success
 *   2. candidates        → extracted fields from the CV
 *   3. applications      → linked to the job
 *   4. candidate_job_scores → AI score + reasoning
 */

const fs = require('fs');
const path = require('path');

// ─── Config (mirrors .env for the dev stack) ──────────────────────────────────
const API_BASE_URL = 'http://localhost:3000';
const POSTMARK_TOKEN = 'my-super-secret-123'; // same as .env POSTMARK_WEBHOOK_TOKEN
const SENDER_EMAIL = 'agency@test-recruiter.com';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildAuthHeader(token) {
  // Postmark HTTP Basic Auth: username is anything, password is the token
  return 'Basic ' + Buffer.from(`postmark:${token}`).toString('base64');
}

function getContentType(filename) {
  const ext = path.extname(filename).toLowerCase();
  const map = {
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  };
  return map[ext] ?? 'application/octet-stream';
}

function buildPayload(filename, fileBuffer) {
  const contentType = getContentType(filename);
  const base64Content = fileBuffer.toString('base64');
  const candidateName = path.basename(filename, path.extname(filename)).replace(/[-_]/g, ' ');

  return {
    // Postmark sends just the email address in 'From' (name goes in 'FromFull' which we don't use)
    MessageID: `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    From: SENDER_EMAIL,
    Subject: `CV - ${candidateName}`,
    Date: new Date().toISOString(),
    TextBody: `Hi,\n\nPlease find my CV attached.\n\nBest regards,\n${candidateName}`,
    HtmlBody: `<p>Please find my CV attached.</p>`,
    Attachments: [
      {
        Name: filename,
        ContentType: contentType,
        ContentLength: fileBuffer.length,
        Content: base64Content,
      },
    ],
  };
}

async function checkHealth() {
  console.log('\n🏥  Checking system health...');
  const res = await fetch(`${API_BASE_URL}/webhooks/health`);
  const body = await res.json();
  if (res.ok) {
    console.log(`✅  Health OK →`, body);
  } else {
    console.error(`❌  Health DEGRADED [${res.status}] →`, body);
  }
  return res.ok;
}

async function sendWebhook(filename, fileBuffer) {
  const payload = buildPayload(filename, fileBuffer);

  console.log(`\n📤  Sending: ${filename}`);
  console.log(`    MessageID : ${payload.MessageID}`);
  console.log(`    From      : ${payload.From}`);
  console.log(`    Size      : ${(fileBuffer.length / 1024).toFixed(1)} KB`);

  const res = await fetch(`${API_BASE_URL}/webhooks/email`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: buildAuthHeader(POSTMARK_TOKEN),
    },
    body: JSON.stringify(payload),
  });

  const responseText = await res.text();

  if (res.ok) {
    console.log(`✅  Accepted [${res.status}] → ${responseText}`);
    console.log(`\n    👉 Now watch docker compose logs -f worker for processing.`);
    console.log(`    👉 Then refresh Prisma Studio → email_intake_log to see the result.`);
    console.log(`    👉 MessageID to search for: ${payload.MessageID}`);
  } else {
    console.error(`❌  Rejected [${res.status}] → ${responseText}`);
  }

  return { ok: res.ok, messageId: payload.MessageID };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const filesDir = path.join(__dirname, 'files');

  // Health-only mode
  if (args.includes('--health')) {
    await checkHealth();
    return;
  }

  // Always run health check first
  const healthy = await checkHealth();
  if (!healthy) {
    console.error('\n⛔  Service degraded — fix health issues before running tests.');
    process.exit(1);
  }

  // Determine which files to send
  let filesToSend = [];

  if (args.length > 0 && !args[0].startsWith('--')) {
    // Specific file passed as argument
    const targetFile = path.join(filesDir, args[0]);
    if (!fs.existsSync(targetFile)) {
      console.error(`❌  File not found: ${targetFile}`);
      process.exit(1);
    }
    filesToSend = [args[0]];
  } else {
    // Scan local-test/files/ for all CV files
    if (!fs.existsSync(filesDir)) {
      console.error(`❌  Directory not found: ${filesDir}`);
      console.error(`    Create it and place CV files inside (PDF, DOC, DOCX).`);
      process.exit(1);
    }
    const supported = ['.pdf', '.doc', '.docx'];
    filesToSend = fs.readdirSync(filesDir).filter((f) => {
      const ext = path.extname(f).toLowerCase();
      return supported.includes(ext) && !f.startsWith('.');
    });

    if (filesToSend.length === 0) {
      console.error(`❌  No CV files found in ${filesDir}`);
      console.error(`    Drop some PDF / DOC / DOCX files there and try again.`);
      process.exit(1);
    }
  }

  console.log(`\n📂  Files to send: ${filesToSend.join(', ')}`);

  const results = [];
  for (const filename of filesToSend) {
    const filePath = path.join(filesDir, filename);
    const fileBuffer = fs.readFileSync(filePath);
    const result = await sendWebhook(filename, fileBuffer);
    results.push({ filename, ...result });
    // Small delay between sends to keep logs readable
    if (filesToSend.indexOf(filename) < filesToSend.length - 1) {
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  // Summary
  console.log('\n─────────────────────────────────────────────');
  console.log('📊 Summary:');
  results.forEach(({ filename, ok, messageId }) => {
    const icon = ok ? '✅' : '❌';
    console.log(`  ${icon}  ${filename.padEnd(40)} MessageID: ${messageId}`);
  });
  console.log('─────────────────────────────────────────────');
  console.log('');
}

main().catch((err) => {
  console.error('💥 Unexpected error:', err.message);
  process.exit(1);
});
