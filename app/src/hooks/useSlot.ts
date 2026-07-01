import { useConnection } from "@solana/wallet-adapter-react";
import { useQuery } from "@tanstack/react-query";

/// Polls the cluster slot every 5s. Used as a live-network indicator in
/// the header chip.
export function useSlot(): number | undefined {
  const { connection } = useConnection();
  const { data } = useQuery({
    queryKey: ["slot", connection.rpcEndpoint],
    queryFn: () => connection.getSlot("confirmed"),
    refetchInterval: 5_000,
    staleTime: 5_000,
  });
  return data;
}
