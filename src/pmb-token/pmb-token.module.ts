import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { PmbTokenController } from './pmb-token.controller';
import { PmbTokenService } from './pmb-token.service';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [PmbTokenController],
  providers: [PmbTokenService],
})
export class PmbTokenModule {}
