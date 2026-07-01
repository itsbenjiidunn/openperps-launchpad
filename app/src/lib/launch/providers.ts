/// Registry of launch providers. OpenPerps mints the token natively; the flow adds the
/// coin-margin perp (and an optional spot pool).

import type { LaunchProvider, LaunchProviderId } from "./types";
import { nativeProvider } from "./native";

export const LAUNCH_PROVIDERS: LaunchProvider[] = [nativeProvider];

export function getLaunchProvider(id: LaunchProviderId): LaunchProvider {
  const provider = LAUNCH_PROVIDERS.find((p) => p.id === id);
  if (!provider) throw new Error(`Unknown launch provider: ${id}`);
  return provider;
}
