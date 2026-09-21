import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";

export async function streamFileResponse(
  filePath: string,
  headers: Record<string, string>,
): Promise<Response> {
  const info = await stat(filePath);
  const stream = createReadStream(filePath);
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    headers: {
      ...headers,
      "Content-Length": String(info.size),
    },
  });
}
