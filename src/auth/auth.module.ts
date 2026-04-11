import { Module } from '@nestjs/common';
import { JwtService } from './jwt.service';
import { SessionGuard } from './session.guard';
import { EmailService } from './email.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { InvitationService } from './invitation.service';
import { StorageModule } from '../storage/storage.module';

@Module({
  // PrismaModule is @Global() — no need to import it here
  imports: [StorageModule],
  controllers: [AuthController],
  providers: [JwtService, SessionGuard, EmailService, AuthService, InvitationService],
  exports: [JwtService, SessionGuard, EmailService],
})
export class AuthModule {}
