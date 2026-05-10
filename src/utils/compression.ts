const PREFIX = "cmp1:";

/** Compress a string using deflate-raw and encode as base64. */
export async function compress(str: string): Promise<string> {
  const bytes = new TextEncoder().encode(str);
  const stream = new CompressionStream("deflate-raw");
  const writer = stream.writable.getWriter();
  void writer.write(bytes);
  void writer.close();
  const buffer = await new Response(stream.readable).arrayBuffer();
  const arr = new Uint8Array(buffer);
  // Build binary string in chunks to avoid call-stack limits on large payloads.
  const CHUNK = 8192;
  let binary = "";
  for (let i = 0; i < arr.length; i += CHUNK) {
    binary += String.fromCharCode(...arr.subarray(i, i + CHUNK));
  }
  return PREFIX + btoa(binary);
}

/** Decompress a string produced by `compress`. Returns the original JSON string. */
export async function decompress(stored: string): Promise<string> {
  const b64 = stored.slice(PREFIX.length);
  const binary = atob(b64);
  const arr = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);
  const stream = new DecompressionStream("deflate-raw");
  const writer = stream.writable.getWriter();
  void writer.write(arr);
  void writer.close();
  const buffer = await new Response(stream.readable).arrayBuffer();
  return new TextDecoder().decode(buffer);
}

/** Whether a stored string was produced by `compress`. */
export function isCompressed(stored: string): boolean {
  return stored.startsWith(PREFIX);
}
