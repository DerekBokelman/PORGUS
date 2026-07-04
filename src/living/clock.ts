export type Clock = () => Date;

export const systemClock: Clock = () => new Date();

export function isoFrom(clock: Clock): string {
  return clock().toISOString();
}
