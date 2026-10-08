import { Module } from '@nestjs/common';
import { MetricsModule } from './metrics/metrics.module';
import { WorkersModule } from './workers/workers.module';
import { ThrottlerModule } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import Redis from 'ioredis';

@Module({
  imports: [
    MetricsModule,
    WorkersModule,
    ThrottlerModule.forRoot({
      throttlers: [
        {
          name: 'global',
          ttl: 60000,
          limit: 100,
        },
        {
          name: 'auth',
          ttl: 60000,
          limit: 10,
        }
      ],
      storage: new ThrottlerStorageRedisService(new Redis(process.env.REDIS_URL || 'redis://localhost:6379')),
    }),
  ],
})
export class AppModule {}
