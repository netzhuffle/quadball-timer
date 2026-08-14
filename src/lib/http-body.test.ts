import { describe, expect, test } from "bun:test";
import { readJsonBodyWithinLimit } from "@/lib/http-body";

describe("http-body", () => {
  test("accepts an exact byte boundary before decoding JSON", async () => {
    const result = await readJsonBodyWithinLimit(
      new Request("http://localhost", {
        method: "POST",
        body: '{"a":""}',
      }),
      8,
    );

    expect(result).toEqual({ ok: true, body: { a: "" } });
  });

  test("rejects one byte over the configured body boundary", async () => {
    const result = await readJsonBodyWithinLimit(
      new Request("http://localhost", {
        method: "POST",
        body: '{"a":"x"}',
      }),
      8,
    );

    expect(result).toEqual({
      ok: false,
      status: 413,
      error: "JSON body exceeds the configured byte limit.",
    });
  });

  test("rejects malformed JSON after the byte boundary check", async () => {
    const result = await readJsonBodyWithinLimit(
      new Request("http://localhost", {
        method: "POST",
        body: "not-json",
      }),
      64,
    );

    expect(result).toEqual({
      ok: false,
      status: 400,
      error: "JSON body must be valid JSON.",
    });
  });

  test("rejects an oversized declared content length before consuming the body", async () => {
    const result = await readJsonBodyWithinLimit(
      new Request("http://localhost", {
        method: "POST",
        headers: { "content-length": "65" },
        body: "{}",
      }),
      64,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(413);
    }
  });

  test("accepts a chunked body exactly at the byte boundary without a content length", async () => {
    const stream = trackedBodyStream([new Uint8Array([123, 125]), new Uint8Array([])]);
    const request = new Request("http://localhost", {
      method: "POST",
      body: stream.body,
    });

    expect(request.headers.get("content-length")).toBeNull();
    const result = await readJsonBodyWithinLimit(request, 2);

    expect(result).toEqual({ ok: true, body: {} });
    expect(stream.cancelled).toBe(false);
    expect(stream.pulled).toBe(2);
  });

  test("cancels a chunked body immediately after max plus one byte", async () => {
    const stream = trackedBodyStream([
      new Uint8Array([123]),
      new Uint8Array([125, 32]),
      ...Array.from({ length: 20 }, () => new Uint8Array([32])),
    ]);
    const request = new Request("http://localhost", {
      method: "POST",
      body: stream.body,
    });

    expect(request.headers.get("content-length")).toBeNull();
    const result = await readJsonBodyWithinLimit(request, 2);

    expect(result).toEqual({
      ok: false,
      status: 413,
      error: "JSON body exceeds the configured byte limit.",
    });
    expect(stream.cancelled).toBe(true);
    expect(stream.pulled).toBeLessThan(stream.totalChunks);
  });
});

function trackedBodyStream(chunks: Uint8Array[]): {
  body: ReadableStream<Uint8Array>;
  totalChunks: number;
  get pulled(): number;
  get cancelled(): boolean;
} {
  let nextChunk = 0;
  let pullCount = 0;
  let wasCancelled = false;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pullCount += 1;
        const chunk = chunks[nextChunk];
        nextChunk += 1;
        if (chunk === undefined) {
          controller.close();
          return;
        }
        controller.enqueue(chunk);
        if (nextChunk === chunks.length) {
          controller.close();
        }
      },
      cancel() {
        wasCancelled = true;
      },
    },
    { highWaterMark: 0 },
  );

  return {
    body,
    totalChunks: chunks.length,
    get pulled() {
      return pullCount;
    },
    get cancelled() {
      return wasCancelled;
    },
  };
}
