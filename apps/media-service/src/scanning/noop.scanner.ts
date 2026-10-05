import type { Logger } from '@a5/observability';
import type { MalwareScanner, ScanVerdict } from './malware-scanner.js';

/** Development scanner: records that scanning was skipped. Refused by configuration in production. */
export class NoopScanner implements MalwareScanner {
  readonly name = 'none';

  constructor(private readonly logger: Logger) {}

  async scanFile(path: string): Promise<ScanVerdict> {
    this.logger.info({ path }, 'malware scanning is disabled (MALWARE_SCANNER=none); marking file as not scanned');
    return { status: 'skipped', engine: 'none' };
  }

  async ping(): Promise<void> {
    // Nothing to check.
  }
}
