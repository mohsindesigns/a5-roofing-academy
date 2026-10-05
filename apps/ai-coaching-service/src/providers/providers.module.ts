import { Global, Module } from '@nestjs/common';
import { AI_CONFIG, type AiConfig } from '../config.js';
import { ProviderRegistry } from './registry.js';
import { DevSimulatorProvider } from './simulator/simulator.provider.js';

@Global()
@Module({
  providers: [
    {
      provide: DevSimulatorProvider,
      inject: [AI_CONFIG],
      useFactory: (config: AiConfig) => new DevSimulatorProvider(config.ai.providers.simulatorStreamDelayMs),
    },
    ProviderRegistry,
  ],
  exports: [ProviderRegistry, DevSimulatorProvider],
})
export class ProvidersModule {}
