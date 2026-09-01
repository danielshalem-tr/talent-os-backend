import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Request } from 'express';
import { SessionGuard } from './session.guard';
import { TeamService } from './team.service';
import type { JwtPayload } from './jwt.service';

// D-17: All team endpoints require authentication — apply guard at controller level
@Controller('auth/team')
@UseGuards(SessionGuard, ThrottlerGuard)
export class TeamController {
  constructor(private readonly teamService: TeamService) {}

  // GET /auth/team/members
  @Get('members')
  getMembers(@Req() req: Request) {
    return this.teamService.getMembers(req.session as JwtPayload);
  }

  // GET /auth/team/invitations
  @Get('invitations')
  getInvitations(@Req() req: Request) {
    return this.teamService.getInvitations(req.session as JwtPayload);
  }

  // POST /auth/team/invitations — 201 Created
  @Post('invitations')
  @HttpCode(201)
  createInvitation(@Req() req: Request, @Body('email') email: string, @Body('role') role: string) {
    if (!email || !role) {
      return { error: { code: 'VALIDATION_ERROR', message: 'email and role are required' } };
    }
    return this.teamService.createInvitation(req.session as JwtPayload, email, role);
  }

  // DELETE /auth/team/invitations/:id — 204 No Content
  @Delete('invitations/:id')
  @HttpCode(204)
  async cancelInvitation(@Req() req: Request, @Param('id') id: string) {
    await this.teamService.cancelInvitation(req.session as JwtPayload, id);
  }

  // PATCH /auth/team/members/:id/role — 200
  @Patch('members/:id/role')
  changeRole(@Req() req: Request, @Param('id') id: string, @Body('role') role: string) {
    return this.teamService.changeRole(req.session as JwtPayload, id, role);
  }

  // DELETE /auth/team/members/:id — 204 No Content
  @Delete('members/:id')
  @HttpCode(204)
  async removeMember(@Req() req: Request, @Param('id') id: string) {
    await this.teamService.removeMember(req.session as JwtPayload, id);
  }
}
