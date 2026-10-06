import { DynamicModule, Global, Inject, Injectable, Module, OnModuleInit } from '@nestjs/common';
import { DATABASE, EventBus, HealthRegistry, LOGGER } from '@a5/nest-kit';
import type { Logger } from '@a5/observability';
import type { ObjectStorage } from '@a5/storage';
import { MEDIA_CONFIG, type MediaConfig } from '../config.js';
import type { Db } from '../database/index.js';
import { MediaTokens } from '../playback/media-tokens.js';
import { FfmpegHlsTranscoder } from '../processing/ffmpeg-hls.transcoder.js';
import { MediaProcessor } from '../processing/media-processor.js';
import type { Transcoder } from '../processing/transcoder.js';
import { ClamAvScanner } from '../scanning/clamav.scanner.js';
import type { MalwareScanner } from '../scanning/malware-scanner.js';
import { NoopScanner } from '../scanning/noop.scanner.js';
import { createObjectStorage } from '../storage/storage.factory.js';
import { HmacCdnUrlSigner, StorageUrlSigner, type UrlSigner } from '../storage/url-signer.js';
import {
  CLOCK,
  MALWARE_SCANNER,
  OBJECT_STORAGE,
  TRANSCODER,
  URL_SIGNER,
  systemClock,
  type Clock,
} from './tokens.js';

/** Replaceable infrastructure (tests inject a controllable clock or fake scanner). */
export interface MediaAppOverrides {
  clock?: Clock;
  storage?: ObjectStorage;
  scanner?: MalwareScanner;
  transcoder?: Transcoder;
}

@Injectable()
class MediaInfraLifecycle implements OnModuleInit {
  constructor(
    private readonly health: HealthRegistry,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(MALWARE_SCANNER) private readonly scanner: MalwareScanner,
  ) {}

  onModuleInit() {
    this.health.register('storage', () => this.storage.ping());
    if (this.scanner.name !== 'none')
      this.health.register('malware-scanner', () => this.scanner.ping());
  }
}

@Global()
@Module({})
export class MediaInfraModule {
  static register(config: MediaConfig, overrides: MediaAppOverrides = {}): DynamicModule {
    const settings = config.media;
    return {
      module: MediaInfraModule,
      providers: [
        { provide: MEDIA_CONFIG, useValue: config },
        { provide: CLOCK, useValue: overrides.clock ?? systemClock },
        {
          provide: OBJECT_STORAGE,
          useFactory: () => overrides.storage ?? createObjectStorage(settings.storage),
        },
        {
          provide: URL_SIGNER,
          inject: [OBJECT_STORAGE, CLOCK],
          useFactory: (storage: ObjectStorage, clock: Clock): UrlSigner =>
            settings.cdn
              ? new HmacCdnUrlSigner(settings.cdn.baseUrl, settings.cdn.signingSecret, clock)
              : new StorageUrlSigner(storage),
        },
        {
          provide: MALWARE_SCANNER,
          inject: [LOGGER],
          useFactory: (logger: Logger): MalwareScanner => {
            if (overrides.scanner) return overrides.scanner;
            const s = settings.scanner;
            return s.kind === 'clamav'
              ? new ClamAvScanner({ host: s.host, port: s.port, timeoutMs: s.timeoutMs })
              : new NoopScanner(logger);
          },
        },
        {
          provide: TRANSCODER,
          useFactory: (): Transcoder =>
            overrides.transcoder ??
            new FfmpegHlsTranscoder({
              ffmpegPath: settings.processing.ffmpegPath,
              ffprobePath: settings.processing.ffprobePath,
              timeoutMs: settings.processing.timeoutSeconds * 1000,
            }),
        },
        {
          provide: MediaProcessor,
          inject: [DATABASE, OBJECT_STORAGE, TRANSCODER, MALWARE_SCANNER, EventBus, LOGGER],
          useFactory: (
            db: Db,
            storage: ObjectStorage,
            transcoder: Transcoder,
            scanner: MalwareScanner,
            events: EventBus,
            logger: Logger,
          ) =>
            new MediaProcessor({
              db,
              storage,
              transcoder,
              scanner,
              events,
              logger,
              workDir: settings.processing.workDir,
            }),
        },
        MediaTokens,
        MediaInfraLifecycle,
      ],
      exports: [
        MEDIA_CONFIG,
        CLOCK,
        OBJECT_STORAGE,
        URL_SIGNER,
        MALWARE_SCANNER,
        TRANSCODER,
        MediaProcessor,
        MediaTokens,
      ],
    };
  }
}
