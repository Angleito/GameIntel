export function utcDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export async function dailyShuffleSeed(
  secret: string,
  date: string,
  catalogVersion: string,
  gameId: string,
): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${date}\n${catalogVersion}\n${gameId}`),
  );

  return new Uint8Array(signature);
}

function seededRandom(seed: Uint8Array): () => number {
  if (seed.byteLength < 16) throw new Error("Daily shuffle seed must be at least 16 bytes");

  const view = new DataView(seed.buffer, seed.byteOffset, seed.byteLength);
  let a = view.getUint32(0);
  let b = view.getUint32(4);
  let c = view.getUint32(8);
  let d = view.getUint32(12);

  return () => {
    const result = (a + b + d) >>> 0;
    d = (d + 1) >>> 0;
    a = (b ^ (b >>> 9)) >>> 0;
    b = (c + (c << 3)) >>> 0;
    c = ((c << 21) | (c >>> 11)) >>> 0;
    c = (c + result) >>> 0;
    return result / 0x1_0000_0000;
  };
}

export function shuffleWithSeed<T>(items: readonly T[], seed: Uint8Array): T[] {
  const shuffled = [...items];
  const random = seededRandom(seed);

  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }

  return shuffled;
}
