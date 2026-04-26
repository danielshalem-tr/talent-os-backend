-- Add R2 storage keys to email_intake_log
-- raw_payload_key: R2 path to full payload JSON (with base64 attachments)
-- cv_file_key:     R2 path to uploaded CV file (null if email has no CV attachment)
ALTER TABLE "email_intake_log" ADD COLUMN "raw_payload_key" TEXT;
ALTER TABLE "email_intake_log" ADD COLUMN "cv_file_key" TEXT;
