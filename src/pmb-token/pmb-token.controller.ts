import { Controller, ForbiddenException, Get, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { SessionGuard } from '../auth/session.guard';
import { PrismaService } from '../prisma/prisma.service';
import { PmbTokenService } from './pmb-token.service';

// Identity vouch only: any active logged-in user can mint. Authorization (the PM
// allowlist) is enforced server-side by the Box per tenant — mirroring how the
// embedded PmBridgeGuard treated its client-side gate as cosmetic.
@UseGuards(SessionGuard)
@Controller('pmb-token')
export class PmbTokenController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly service: PmbTokenService,
  ) {}

  @Get()
  async mintToken(@Req() req: Request): Promise<{ token: string }> {
    const user = await this.prisma.user.findUnique({ where: { id: req.session!.sub } });
    if (!user || !user.isActive) {
      throw new ForbiddenException({ error: { code: 'FORBIDDEN', message: 'Not authorized' } });
    }
    return { token: await this.service.mint(user.email.toLowerCase()) };
  }
}
