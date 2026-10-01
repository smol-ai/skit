declare module "virtual:nimbus/icons" {
  import type { IconifyJSON } from "@iconify/types";
  export type Icon = string;
  export const config: { include: Record<string, string[]> };
  const icons: Record<string, IconifyJSON>;
  export default icons;
}
