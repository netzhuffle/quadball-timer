import { SHARED_LIMITS } from "@/lib/validation-policy";

export type JsonBodyResult =
  | {
      ok: true;
      body: unknown;
    }
  | {
      ok: false;
      status: 400 | 413;
      error: string;
    };

export async function readJsonBodyWithinLimit(
  request: Request,
  maximumBytes = SHARED_LIMITS.transport.httpJsonBodyBytes,
): Promise<JsonBodyResult> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0) {
      return {
        ok: false,
        status: 400,
        error: "Content-Length must be a non-negative safe integer.",
      };
    }

    if (parsedLength > maximumBytes) {
      return {
        ok: false,
        status: 413,
        error: "JSON body exceeds the configured byte limit.",
      };
    }
  }

  const body = request.body;
  if (body === null) {
    return {
      ok: true,
      body: {},
    };
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      const remainingBytes = maximumBytes - byteLength;
      if (value.byteLength > remainingBytes) {
        await reader.cancel("JSON body exceeds the configured byte limit.").catch(() => undefined);
        return {
          ok: false,
          status: 413,
          error: "JSON body exceeds the configured byte limit.",
        };
      }

      if (value.byteLength > 0) {
        chunks.push(value);
        byteLength += value.byteLength;
      }
    }
  } catch {
    return {
      ok: false,
      status: 400,
      error: "JSON body could not be read.",
    };
  } finally {
    reader.releaseLock();
  }

  if (byteLength === 0) {
    return {
      ok: true,
      body: {},
    };
  }

  try {
    const bytes = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return {
      ok: true,
      body: JSON.parse(new TextDecoder().decode(bytes)) as unknown,
    };
  } catch {
    return {
      ok: false,
      status: 400,
      error: "JSON body must be valid JSON.",
    };
  }
}
