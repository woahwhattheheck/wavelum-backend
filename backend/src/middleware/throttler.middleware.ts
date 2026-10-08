import { Inject, Injectable, NestMiddleware } from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';
import { Request, Response, NextFunction } from 'express';

@Injectable()
export class ThrottlerMiddleware implements NestMiddleware {
  constructor(@Inject(ThrottlerStorage) private readonly throttlerStorage: ThrottlerStorage) {}

  async use(req: Request, res: Response, next: NextFunction) {
    const ip = req.ip || req.get('x-forwarded-for') || req.socket.remoteAddress;
    
    // Determine which throttler to use based on path
    const isAuth = req.path.includes('/auth/');
    const throttlerName = isAuth ? 'auth' : 'global';
    
    try {
      const ttl = 60000;
      const limit = isAuth ? 10 : 100;
      const { isBlocked } = await this.throttlerStorage.increment(
        `${throttlerName}:${ip || 'unknown'}`, ttl, limit, ttl, throttlerName,
      );
      if (isBlocked) {
        return res.status(429).json({
          success: false,
          error: 'Too many requests. Please try again later.',
        });
      }
      next();
    } catch (error) {
      console.error('Throttler error:', error);
      next(); // Fallback to allowing request if throttler fails
    }
  }
}
