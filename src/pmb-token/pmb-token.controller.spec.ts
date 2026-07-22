import { ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';
import { PmbTokenController } from './pmb-token.controller';
import { PmbTokenService } from './pmb-token.service';
import { PrismaService } from '../prisma/prisma.service';

describe('PmbTokenController', () => {
  const mint = jest.fn();
  const findUnique = jest.fn();
  const controller = new PmbTokenController(
    { user: { findUnique } } as unknown as PrismaService,
    { mint } as unknown as PmbTokenService,
  );
  const req = { session: { sub: 'user-1', org: 'org-1', role: 'admin' } } as unknown as Request;

  beforeEach(() => jest.clearAllMocks());

  it('returns { token } for an active user, minting with the lowercased email', async () => {
    findUnique.mockResolvedValue({ id: 'user-1', email: 'PM@Triolla.io', isActive: true });
    mint.mockResolvedValue('signed.jwt.here');

    await expect(controller.mintToken(req)).resolves.toEqual({ token: 'signed.jwt.here' });
    expect(findUnique).toHaveBeenCalledWith({ where: { id: 'user-1' } });
    expect(mint).toHaveBeenCalledWith('pm@triolla.io');
  });

  it('403s when the user is missing', async () => {
    findUnique.mockResolvedValue(null);
    await expect(controller.mintToken(req)).rejects.toThrow(ForbiddenException);
  });

  it('403s when the user is inactive', async () => {
    findUnique.mockResolvedValue({ id: 'user-1', email: 'pm@triolla.io', isActive: false });
    await expect(controller.mintToken(req)).rejects.toThrow(ForbiddenException);
  });
});
