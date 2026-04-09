import { PrismaService } from '../../prisma/prisma.service';

/**
 * Generates a unique short ID for an organization in the format: "{prefix}-{NN}"
 * where prefix = first 5 alphanumeric chars of name (lowercase), padded with 'x' if shorter.
 * Counter starts at 1 and increments until unique (max 10 attempts).
 * Example: "Triolla" → "triol-01", "Triolla" (conflict) → "triol-02"
 */
export async function generateOrgShortId(name: string, prisma: PrismaService): Promise<string> {
  const prefix = name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 5)
    .padEnd(5, 'x'); // pad with 'x' if org name has < 5 alphanumeric chars

  for (let i = 1; i <= 10; i++) {
    const shortId = `${prefix}-${String(i).padStart(2, '0')}`;
    const existing = await prisma.organization.findUnique({
      where: { shortId },
      select: { id: true },
    });
    if (!existing) return shortId;
  }

  throw new Error(`Could not generate unique shortId for organization: "${name}" (exceeded 10 attempts)`);
}
