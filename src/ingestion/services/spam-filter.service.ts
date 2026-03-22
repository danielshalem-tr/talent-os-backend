import { Injectable } from '@nestjs/common';
import { PostmarkPayloadDto } from '../../webhooks/dto/postmark-payload.dto';

export interface SpamFilterResult {
  isSpam: boolean;
  suspicious: boolean;
}

const SPAM_KEYWORDS = ['unsubscribe', 'newsletter', 'promotion', 'deal', 'offer'] as const;

@Injectable()
export class SpamFilterService {
  check(payload: PostmarkPayloadDto): SpamFilterResult {
    // D-07: "no attachment" means NO attachment of ANY type (even unsupported ones)
    const hasAttachment = (payload.Attachments ?? []).length > 0;
    const bodyLength = (payload.TextBody ?? '').trim().length;
    const subject = (payload.Subject ?? '').toLowerCase();
    const body = (payload.TextBody ?? '').toLowerCase();

    // Hard discard: no attachment AND very short body (D-07)
    if (!hasAttachment && bodyLength < 100) {
      return { isSpam: true, suspicious: false };
    }

    // Keyword scan: BOTH Subject AND Body (D-08), case-insensitive
    const hasKeyword = SPAM_KEYWORDS.some(
      (k) => subject.includes(k) || body.includes(k),
    );

    if (hasKeyword) {
      if (!hasAttachment) {
        // D-10: keyword + no attachment = hard reject
        return { isSpam: true, suspicious: false };
      }
      // D-09: keyword + attachment = suspicious, pass to Phase 4
      return { isSpam: false, suspicious: true };
    }

    // Clean email
    return { isSpam: false, suspicious: false };
  }
}
