/** Dependency-injection tokens for media-service infrastructure. */
export const OBJECT_STORAGE = Symbol('OBJECT_STORAGE');
export const URL_SIGNER = Symbol('URL_SIGNER');
export const MALWARE_SCANNER = Symbol('MALWARE_SCANNER');
export const TRANSCODER = Symbol('TRANSCODER');
export const CLOCK = Symbol('CLOCK');

/** Time source. Injected so telemetry crediting and token expiry can be tested deterministically. */
export interface Clock {
  /** Milliseconds since the Unix epoch. */
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };
