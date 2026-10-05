import { Injectable } from '@nestjs/common';

/**
 * Source of "now" for analytics calculations (overdue, pace, expiry windows). Tests pin it to a
 * fixed instant so results are deterministic.
 */
@Injectable()
export class AnalyticsClock {
  private fixed: Date | null = null;

  now(): Date {
    return this.fixed ? new Date(this.fixed.getTime()) : new Date();
  }

  /** Pin the clock (tests and seeded demos). Pass null to follow wall-clock time again. */
  pin(at: Date | null): void {
    this.fixed = at ? new Date(at.getTime()) : null;
  }
}
