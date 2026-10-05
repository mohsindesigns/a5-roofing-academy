/**
 * Source of "now" for deadline, cooldown and grading timestamps. Production uses the system clock;
 * tests inject a controllable subclass so server-side time limits can be exercised deterministically.
 */
export class Clock {
  now(): Date {
    return new Date();
  }
}
