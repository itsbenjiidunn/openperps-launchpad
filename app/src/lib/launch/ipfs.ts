/// Pluggable off-chain metadata upload for the launch aggregator. External launchpads
/// (Pump.fun, LetsBonk) need the token's metadata JSON pinned to IPFS BEFORE the create
/// transaction; the JSON's URI is what goes on-chain. This wraps that upload behind an
/// interface so an operator can swap the pinning backend.

export interface TokenMetadataContent {
  name: string;
  symbol: string;
  description?: string;
  /// The token image. Uploaded first; its IPFS URL is embedded into the JSON.
  image?: Blob;
  twitter?: string;
  telegram?: string;
  website?: string;
}

export interface MetadataUploader {
  /// Upload the image (if any) + the metadata JSON, returning the JSON's IPFS URI.
  uploadMetadata(content: TokenMetadataContent): Promise<string>;
}

const PINATA_FILES = "https://uploads.pinata.cloud/v3/files";
const INDEXER_URL =
  (import.meta.env.VITE_OPENPERPS_INDEXER as string | undefined) ??
  "https://openperps-indexer.denath1707.workers.dev";

/// Build an uploader from a single `putFile` primitive: pin the image first (if any),
/// then a metadata JSON that references it. Shared by the Pinata and Worker backends.
function makeUploader(
  putFile: (file: Blob, name: string) => Promise<string>,
): MetadataUploader {
  return {
    async uploadMetadata(content: TokenMetadataContent): Promise<string> {
      let imageUri = "";
      if (content.image) {
        imageUri = await putFile(content.image, `${content.symbol}-image`);
      }
      const json = {
        name: content.name,
        symbol: content.symbol,
        description: content.description ?? "",
        image: imageUri,
        showName: true,
        ...(content.twitter ? { twitter: content.twitter } : {}),
        ...(content.telegram ? { telegram: content.telegram } : {}),
        ...(content.website ? { website: content.website } : {}),
      };
      const blob = new Blob([JSON.stringify(json)], { type: "application/json" });
      return putFile(blob, `${content.symbol}-metadata.json`);
    },
  };
}

function cidToUri(json: { data?: { cid?: string }; cid?: string }): string {
  const cid = json.data?.cid ?? json.cid;
  if (!cid) throw new Error("pin returned no CID");
  return `https://ipfs.io/ipfs/${cid}`;
}

/// Worker-proxied uploader (the production default): the client POSTs the file to the
/// indexer Worker's `/pin` endpoint, which forwards it to Pinata with the operator JWT
/// kept as a Worker SECRET. The JWT never reaches the client bundle.
export function workerUploader(indexerBase: string = INDEXER_URL): MetadataUploader {
  return makeUploader(async (file, name) => {
    const form = new FormData();
    form.append("file", file, name);
    const res = await fetch(`${indexerBase}/pin`, { method: "POST", body: form });
    if (!res.ok) throw new Error(`pin failed (${res.status}): ${await res.text()}`);
    return cidToUri((await res.json()) as { data?: { cid?: string }; cid?: string });
  });
}

/// Direct Pinata uploader. `jwt` is a Pinata API JWT (the OPERATOR's secret). Only safe
/// where the JWT is not shipped to users (local dev, or a server). Prefer `workerUploader`
/// for anything that runs in the browser of a public site.
export function pinataUploader(jwt: string): MetadataUploader {
  if (!jwt) throw new Error("pinataUploader: a Pinata JWT is required");
  return makeUploader(async (file, name) => {
    const form = new FormData();
    form.append("network", "public");
    form.append("file", file, name);
    const res = await fetch(PINATA_FILES, {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}` },
      body: form,
    });
    if (!res.ok) throw new Error(`Pinata upload failed (${res.status}): ${await res.text()}`);
    return cidToUri((await res.json()) as { data?: { cid?: string } });
  });
}

/// The default uploader. In the browser this is the Worker proxy (JWT stays server-side).
/// A `VITE_PINATA_JWT` is honored only as a local-dev override (it would be exposed in a
/// production bundle, so set it ONLY for local work, never on a deployed site).
export function defaultUploader(): MetadataUploader | null {
  const jwt = import.meta.env.VITE_PINATA_JWT as string | undefined;
  if (jwt) return pinataUploader(jwt);
  return workerUploader(INDEXER_URL);
}
