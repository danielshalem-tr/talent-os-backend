import { z } from 'zod';

export const PostmarkAttachmentSchema = z.object({
  Name: z.string(),
  Content: z.string().optional(), // Base64-encoded binary — will be stripped before DB insert
  ContentType: z.string(),
  ContentLength: z.number(),
  ContentID: z.string().optional(), // "" for real attachments, populated for inline CID images (e.g. "logo.png@01CE7342.75E71F80")
});

export const PostmarkPayloadSchema = z.object({
  MessageID: z.string().min(1),
  From: z.email(),
  Subject: z.string().default(''),
  TextBody: z.string().optional(),
  HtmlBody: z.string().optional(),
  Date: z.string(), // ISO date string from Postmark
  Attachments: z.array(PostmarkAttachmentSchema).default([]),
});

export type PostmarkAttachmentDto = z.infer<typeof PostmarkAttachmentSchema>;
export type PostmarkPayloadDto = z.infer<typeof PostmarkPayloadSchema>;
