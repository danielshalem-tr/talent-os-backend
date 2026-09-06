/**
 * Wraps a phase failure with the phase name so the processor's single status writer can log
 * where it came from and judge retryability on the ORIGINAL error (`cause`). The message is the
 * cause's message — logs, tests and `error_message` read it unchanged.
 */
export class IntakePhaseError extends Error {
  constructor(
    public readonly phase: string,
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'IntakePhaseError';
  }
}
