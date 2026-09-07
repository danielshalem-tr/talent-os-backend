import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from './../src/app.module';

// Regression guard for the SessionGuard DI crash: when AuthModule stopped exporting
// JwtService, every module that uses @UseGuards(SessionGuard) (candidates, jobs,
// applications, config, pmb-token) failed to resolve the guard's JwtService dependency,
// so the whole API failed to boot. This compiles the full DI graph WITHOUT app.init(),
// so it needs no DB/Redis — it fails exactly where production failed (InstanceLoader).
describe('AppModule DI graph (boot)', () => {
  it('resolves every provider — SessionGuard can inject JwtService in consuming modules', async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    expect(moduleRef).toBeDefined();
    await moduleRef.close();
  });
});
