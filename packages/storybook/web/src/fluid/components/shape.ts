export type Radius = 'rounded' | 'pill' | 'sharp';
export function radiusFromPreference(value: string | undefined): Radius {
  return value === 'Sharp' || value === 'sharp'
    ? 'sharp'
    : value === 'Pill' || value === 'pill'
      ? 'pill'
      : 'rounded';
}
/** Source shape-context metrics: Sharp surfaces stay 1px, with a 2px focus outset. */
export function shapeRadius(radius: string | undefined, rounded = 8, pill = 20, sharp = 1): number {
  return radius === 'sharp' ? sharp : radius === 'pill' ? pill : rounded;
}
export function shapeClass(
  radius: string | undefined,
  rounded = 'rounded-lg',
  pill = 'rounded-[20px]',
): string {
  return radius === 'sharp' ? 'rounded-[1px]' : radius === 'pill' ? pill : rounded;
}
