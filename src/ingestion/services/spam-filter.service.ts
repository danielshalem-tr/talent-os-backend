import { Injectable } from '@nestjs/common';
import { PostmarkPayloadDto } from '../../webhooks/dto/postmark-payload.dto';

export interface SpamFilterResult {
  isSpam: boolean;
  suspicious: boolean;
}

/**
 * Multi-word phrases matched via `.includes()` on lowercased text.
 * Each phrase is specific enough that substring collision is negligible.
 */
const SPAM_PHRASES = [
  // Sales / commercial outreach
  'free trial',
  'limited time',
  'act now',
  'click here',
  'opt out',
  'opt-out',
  // Real estate (multi-word — safe for substring match)
  'sq ft',
  'square feet',
  'office space',
  'floor plan',
  'floorplan',
  'commercial space',
  'retail space',
  'asking price',
  // Finance / insurance
  'pre-approved',
  'pre approved',
  'loan offer',
  'insurance quote',
] as const;

/**
 * Single-word or high-collision keywords matched with `\b` word boundaries.
 * FIX #2: 'promotion', 'deal', 'offer' removed from flat list —
 *   - 'promotion' → moved to CONTEXTUAL_PATTERNS (requires commercial co-signal)
 *   - 'deal'      → moved to CONTEXTUAL_PATTERNS (requires commercial co-signal)
 *   - 'offer'     → moved to CONTEXTUAL_PATTERNS (requires commercial co-signal)
 */
const SPAM_WORD_PATTERNS: RegExp[] = [
  /\bunsubscribe\b/i,
  /\bnewsletter\b/i,
  /\bpricing\b/i,
  /\bdiscount\b/i,
  /\bmortgage\b/i,
  /\brefinance\b/i,
];

/**
 * FIX #2: Contextual patterns for ambiguous keywords.
 * These words are legitimate in CV contexts ("earned a promotion",
 * "closed a deal", "received an offer") so they only trigger when
 * combined with commercial co-signals that wouldn't appear in a resume.
 */
const CONTEXTUAL_PATTERNS: RegExp[] = [
  // 'promotion' only when paired with commercial context
  /\bpromotion\b.*(?:%\s*off|\bdiscount\b|\blimited\b|\bsale\b)/i,
  /(?:%\s*off|\bdiscount\b|\blimited\b|\bsale\b).*\bpromotion\b/i,
  // 'deal' only in commercial framing
  /\bdeal\b.*(?:%\s*off|\bexpir(?:es?|ing)\b|\blimited\b|\bexclusive\b)/i,
  /(?:%\s*off|\bexpir(?:es?|ing)\b|\blimited\b|\bexclusive\b).*\bdeal\b/i,
  // 'offer' only in commercial framing (not "offer letter", "job offer", etc.)
  /\boffer\b.*(?:%\s*off|\bexpir(?:es?|ing)\b|\blimited\b|\bexclusive\b|\bpric(?:e|ing)\b)/i,
  /(?:%\s*off|\bexpir(?:es?|ing)\b|\blimited\b|\bexclusive\b|\bpric(?:e|ing)\b).*\boffer\b/i,
];

// ─────────────────────────────────────────────────────────────
// FIX #3: Hebrew spam keywords for Israeli market.
// Hebrew has attached prepositions (ב/ל/מ) and no ASCII \b
// support, so we use Unicode-aware whitespace/start/end anchors.
// ─────────────────────────────────────────────────────────────

/** Hebrew spam phrases matched via `.includes()` (multi-word, safe) */
const HEBREW_SPAM_PHRASES = [
  'לחץ כאן', // "click here"
  'נדל"ן', // "real estate"
  'נדל״ן', // "real estate" (alternate gershayim)
  'שטחי מסחר', // "commercial spaces"
  'שטחי משרדים', // "office spaces"
  'תקופה מוגבלת', // "limited time"
] as const;

const HEBREW_SPAM_PATTERNS: RegExp[] = [
  /(?:^|[^\p{L}])הסרה(?:[^\p{L}]|$)/u, // "removal" / "unsubscribe"
  /(?:^|[^\p{L}])להסרה(?:[^\p{L}]|$)/u, // "to unsubscribe"
  /(?:^|[^\p{L}])מבצע(?:[^\p{L}]|$)/u, // "sale" / "promotion"
  /(?:^|[^\p{L}])מבצעים(?:[^\p{L}]|$)/u, // "sales" (plural)
  /(?:^|[^\p{L}])הנחה(?:[^\p{L}]|$)/u, // "discount"
  /(?:^|[^\p{L}])הלוואה(?:[^\p{L}]|$)/u, // "loan"
  /(?:^|[^\p{L}])משכנתא(?:[^\p{L}]|$)/u, // "mortgage"
  /(?:^|[^\p{L}])דירה(?:[^\p{L}]|$)/u, // "apartment"
  /(?:^|[^\p{L}])להשכרה(?:[^\p{L}]|$)/u, // "for rent"
  /(?:^|[^\p{L}])למכירה(?:[^\p{L}]|$)/u, // "for sale"
];

/**
 * Subject-line patterns that indicate non-CV emails.
 * Matched case-insensitively against the full subject string.
 * A match with no attachment → hard spam reject.
 * A match with attachment → suspicious.
 */
const NON_CV_SUBJECT_PATTERNS: RegExp[] = [
  // Real estate
  /\boffice\s+space\b/i,
  /\bsq\.?\s*ft\b/i,
  /\bsquare\s+feet\b/i,
  /\bfloor\s*plan\b/i,
  /\blease\b/i,
  /\bfor\s+rent\b/i,
  /\bfor\s+sale\b/i,
  /\bcommercial\s+(space|property|real\s+estate)\b/i,
  // Generic sales follow-ups with no CV context
  /\bjust\s+bumping\b/i,
  /^re:\s*(fw:|fwd:)?\s*[^a-z]*(sale|rental|lease|space|property)/i,
  // Hebrew subject patterns (real estate / commercial)
  /(?:^|[^\p{L}])נדל"?״?ן(?:[^\p{L}]|$)/u, // real estate (both gershayim forms)
  /(?:^|[^\p{L}])להשכרה(?:[^\p{L}]|$)/u, // for rent
  /(?:^|[^\p{L}])למכירה(?:[^\p{L}]|$)/u, // for sale
  /(?:^|[^\p{L}])שטחי\s+מסחר(?:[^\p{L}]|$)/u, // commercial spaces
];

// ─────────────────────────────────────────────────────────────
// FIX #1: Inline attachment detection uses Postmark's ContentID
// field. See hasMeaningfulAttachment() below.
// ─────────────────────────────────────────────────────────────

@Injectable()
export class SpamFilterService {
  /**
   * Postmark attachment schema (per inbound webhook docs):
   *   - Name: string          (filename)
   *   - Content: string       (base64-encoded data)
   *   - ContentType: string   (MIME type)
   *   - ContentLength: number (size in bytes)
   *   - ContentID: string     (CID reference — "" for real attachments,
   *                            populated e.g. "logo.png@01CE7342.75E71F80" for inline)
   *
   * NOTE: Postmark does NOT provide ContentDisposition.
   * ContentID is the only signal for distinguishing inline vs. attached.
   * As a defense-in-depth measure, we only treat inline entries as meaningless
   * if they are also images. Any documents with a ContentID are still considered attached.
   */
  private hasMeaningfulAttachment(attachments: PostmarkPayloadDto['Attachments']): boolean {
    if (!attachments || attachments.length === 0) return false;

    return attachments.some((att) => {
      // Only ignore inline images — non-image attachments with ContentID 
      // are still treated as meaningful (defense-in-depth)
      if (att.ContentID && att.ContentType?.startsWith('image/')) return false;

      // Everything else is meaningful (PDF, DOCX, unknown, etc.)
      return true;
    });
  }

  /**
   * Check whether the lowercased text matches any spam signal.
   * Consolidates all keyword/pattern checks into a single pass.
   */
  private matchesSpamSignal(subject: string, body: string): boolean {
    const combined = `${subject} ${body}`;

    // 1. Multi-word phrases (English) — .includes() is safe here
    if (SPAM_PHRASES.some((p) => subject.includes(p) || body.includes(p))) {
      return true;
    }

    // 2. Single-word patterns (English) — regex with \b
    if (SPAM_WORD_PATTERNS.some((re) => re.test(subject) || re.test(body))) {
      return true;
    }

    // 3. Contextual patterns (ambiguous words + commercial co-signal)
    if (CONTEXTUAL_PATTERNS.some((re) => re.test(combined))) {
      return true;
    }

    // 4. Hebrew phrases — .includes() on combined text
    if (HEBREW_SPAM_PHRASES.some((p) => combined.includes(p))) {
      return true;
    }

    // 5. Hebrew single-word patterns
    if (HEBREW_SPAM_PATTERNS.some((re) => re.test(combined))) {
      return true;
    }

    return false;
  }

  check(payload: PostmarkPayloadDto): SpamFilterResult {
    // FIX #1: Use meaningful-attachment check instead of raw length > 0
    const hasAttachment = this.hasMeaningfulAttachment(payload.Attachments);

    const bodyLength = (payload.TextBody ?? '').trim().length;
    const subject = (payload.Subject ?? '').toLowerCase();
    const body = (payload.TextBody ?? '').toLowerCase();
    const rawSubject = payload.Subject ?? '';

    // Hard discard: no meaningful attachment AND very short body (D-07)
    if (!hasAttachment && bodyLength < 100) {
      return { isSpam: true, suspicious: false };
    }

    // Subject pattern check: non-CV subject patterns (real estate, sales, etc.)
    // Now includes Hebrew subject patterns (FIX #3)
    const matchesNonCvSubject = NON_CV_SUBJECT_PATTERNS.some((re) => re.test(rawSubject));
    if (matchesNonCvSubject) {
      if (!hasAttachment) {
        return { isSpam: true, suspicious: false };
      }
      return { isSpam: false, suspicious: true };
    }

    // Keyword/pattern scan: BOTH Subject AND Body (D-08), case-insensitive
    // FIX #2 + #3 + #4: consolidated into matchesSpamSignal()
    const hasSpamSignal = this.matchesSpamSignal(subject, body);

    if (hasSpamSignal) {
      if (!hasAttachment) {
        // D-10: spam signal + no meaningful attachment = hard reject
        return { isSpam: true, suspicious: false };
      }
      // D-09: spam signal + meaningful attachment = suspicious, pass to Phase 4
      return { isSpam: false, suspicious: true };
    }

    // Clean email
    return { isSpam: false, suspicious: false };
  }
}
