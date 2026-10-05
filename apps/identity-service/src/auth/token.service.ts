import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { importAccessKeys, signAccessToken } from '@a5/auth';
import { IDENTITY_CONFIG, type IdentityConfig } from '../config.js';

type Keys = Awaited<ReturnType<typeof importAccessKeys>>;

@Injectable()
export class TokenService implements OnModuleInit {
  private keys: Keys | null = null;

  constructor(@Inject(IDENTITY_CONFIG) private readonly config: IdentityConfig) {}

  async onModuleInit() {
    this.keys = await importAccessKeys(this.config.auth.privateKeyPem, this.config.auth.publicKeyPem, this.config.auth.kid);
  }

  get ttlSeconds(): number {
    return this.config.auth.accessTokenTtlSeconds;
  }

  async accessToken(claims: { userId: string; sessionId: string; organizationId: string }): Promise<string> {
    if (!this.keys?.privateKey) throw new Error('Access token signing key not loaded');
    return signAccessToken(
      { sub: claims.userId, sid: claims.sessionId, org: claims.organizationId },
      { privateKey: this.keys.privateKey, kid: this.keys.kid },
      this.ttlSeconds,
    );
  }
}
