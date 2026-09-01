import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SessionGuard } from './session.guard';
import { JwtService } from './jwt.service';

describe('SessionGuard', () => {
  let guard: SessionGuard;
  let jwtService: { verify: jest.Mock };
  let reflector: Pick<Reflector, 'getAllAndOverride'>;
  let prisma: { user: { findUnique: jest.Mock } };
  let request: any;
  let ctx: ExecutionContext;

  const makeContext = (cookies: Record<string, string> = {}): ExecutionContext => {
    const req: any = { cookies };
    return {
      switchToHttp: () => ({ getRequest: () => req }),
      getHandler: () => () => undefined,
      getClass: () => class {},
    } as unknown as ExecutionContext;
  };

  beforeEach(() => {
    jwtService = { verify: jest.fn() };
    reflector = { getAllAndOverride: jest.fn().mockReturnValue(false) };
    prisma = { user: { findUnique: jest.fn() } };
    guard = new SessionGuard(jwtService as unknown as JwtService, reflector as Reflector, prisma as any);
    request = { cookies: { talent_os_session: 'good-token' } };
    ctx = {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => () => undefined,
      getClass: () => class {},
    } as unknown as ExecutionContext;
  });

  it('returns true without verifying a session when the route is @Public()', async () => {
    (reflector.getAllAndOverride as jest.Mock).mockReturnValue(true);
    await expect(guard.canActivate(makeContext())).resolves.toBe(true);
    expect(jwtService.verify).not.toHaveBeenCalled();
  });

  it('throws UnauthorizedException when no cookie present on a protected route', async () => {
    await expect(guard.canActivate(makeContext())).rejects.toThrow(UnauthorizedException);
  });

  it('attaches a DB-fresh session to request.session when the JWT is valid', async () => {
    jwtService.verify.mockResolvedValue({ sub: 'u1', org: 'o1', role: 'admin' });
    prisma.user.findUnique.mockResolvedValue({ isActive: true, role: 'admin', organizationId: 'o1' });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'u1' },
      select: { isActive: true, role: true, organizationId: true },
    });
    expect(request.session).toEqual({ sub: 'u1', org: 'o1', role: 'admin' });
  });

  it('rejects a valid token whose user is deactivated', async () => {
    jwtService.verify.mockResolvedValue({ sub: 'u1', org: 'o1', role: 'admin' });
    prisma.user.findUnique.mockResolvedValue({ isActive: false, role: 'admin', organizationId: 'o1' });
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a valid token whose user no longer exists', async () => {
    jwtService.verify.mockResolvedValue({ sub: 'u1', org: 'o1', role: 'admin' });
    prisma.user.findUnique.mockResolvedValue(null);
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it('uses the DB role, not the JWT role (demotion takes effect immediately)', async () => {
    jwtService.verify.mockResolvedValue({ sub: 'u1', org: 'o1', role: 'admin' });
    prisma.user.findUnique.mockResolvedValue({ isActive: true, role: 'viewer', organizationId: 'o1' });
    await guard.canActivate(ctx);
    expect(request.session).toEqual({ sub: 'u1', org: 'o1', role: 'viewer' });
  });
});
