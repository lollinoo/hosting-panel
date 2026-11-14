import http from "node:http";
import { Readable } from "node:stream";

// Sends an upstream HTTP request with no headers/body timeouts and streamed bodies.
export function fetchPhpMyAdminUpstream(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
  if (signal?.aborted) {
    return Promise.reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
  }

  const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch (err) {
    return Promise.reject(err);
  }
  if (url.protocol !== "http:") {
    return Promise.reject(new TypeError(`Unsupported upstream protocol: ${url.protocol}`));
  }

  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const headers: Record<string, string> = {};
  const sourceHeaders = init?.headers ?? (input instanceof Request ? input.headers : undefined);
  if (sourceHeaders) {
    new Headers(sourceHeaders).forEach((value, key) => {
      headers[key] = value;
    });
  }

  const body = init?.body !== undefined ? init.body : input instanceof Request ? input.body : null;

  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    let stopUpstreamWrite = false;
    let bodyReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let bodyFinished = false;
    let wakeDrainWaiter: (() => void) | null = null;

    const stopWritingToUpstream = () => {
      if (stopUpstreamWrite) return;
      stopUpstreamWrite = true;
      wakeDrainWaiter?.();
    };

    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      reject(signal?.aborted ? (signal.reason ?? err) : err);
    };

    const req = http.request(
      url,
      { method, headers, agent: false, ...(signal ? { signal } : {}) },
      (res) => {
        if (settled) {
          res.resume();
          return;
        }
        settled = true;
        const finishUpstream = () => {
          stopWritingToUpstream();
          if (!req.destroyed) req.destroy();
        };
        try {
          const status = res.statusCode ?? 502;
          const resHeaders = new Headers();
          for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) {
            resHeaders.append(res.rawHeaders[i]!, res.rawHeaders[i + 1]!);
          }

          if (method === "HEAD" || status === 204 || status === 205 || status === 304) {
            res.on("error", () => {});
            res.once("end", () => {
              res.destroy();
              finishUpstream();
            });
            res.once("close", finishUpstream);
            res.resume();
            resolve(new Response(null, { status, statusText: res.statusMessage, headers: resHeaders }));
            return;
          }

          const stream = Readable.toWeb(res) as ReadableStream<Uint8Array>;
          res.once("close", finishUpstream);
          resolve(new Response(stream, { status, statusText: res.statusMessage, headers: resHeaders }));
        } catch (err) {
          res.on("error", () => {});
          res.resume();
          finishUpstream();
          reject(signal?.aborted ? (signal.reason ?? err) : err);
        }
      },
    );

    req.on("error", (err) => {
      stopWritingToUpstream();
      fail(err);
    });
    req.on("close", () => {
      stopWritingToUpstream();
      if (signal?.aborted && !bodyFinished && bodyReader) {
        void bodyReader.cancel().catch(() => {});
      }
      fail(new Error("Upstream connection closed before response headers"));
    });

    if (body === null || body === undefined) {
      bodyFinished = true;
      req.end();
      return;
    }

    if (typeof body === "string" || body instanceof Uint8Array) {
      bodyFinished = true;
      req.end(body);
      return;
    }

    if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
      bodyFinished = true;
      const view =
        body instanceof ArrayBuffer
          ? new Uint8Array(body)
          : new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
      req.end(view);
      return;
    }

    const webStream = body instanceof Blob ? body.stream() : (body as ReadableStream<Uint8Array>);
    if (typeof webStream.getReader !== "function") {
      bodyFinished = true;
      req.destroy(new TypeError("Unsupported upstream request body"));
      return;
    }

    void pumpRequestStream(
      webStream,
      req,
      () => stopUpstreamWrite,
      () => Boolean(signal?.aborted),
      (wake) => {
        wakeDrainWaiter = wake;
      },
      (reader) => {
        bodyReader = reader;
      },
      () => {
        bodyFinished = true;
        bodyReader = null;
      },
      fail,
    );
  });
}

// Forwards a request stream to upstream, discarding any tail after upstream ends unless aborted.
async function pumpRequestStream(
  stream: ReadableStream<Uint8Array>,
  req: http.ClientRequest,
  shouldStopWriting: () => boolean,
  isAborted: () => boolean,
  onWakeSetter: (wake: (() => void) | null) => void,
  onReader: (reader: ReadableStreamDefaultReader<Uint8Array>) => void,
  onFinish: () => void,
  onError: (err: unknown) => void,
): Promise<void> {
  const reader = stream.getReader();
  onReader(reader);
  try {
    let drainingOnly = false;
    while (true) {
      const { done, value } = await reader.read();
      if (isAborted()) {
        if (!done) await reader.cancel().catch(() => {});
        return;
      }
      if (done) {
        if (!drainingOnly && !shouldStopWriting() && !req.destroyed && !req.closed && !req.writableEnded) {
          req.end();
        }
        return;
      }
      if (drainingOnly || shouldStopWriting() || req.destroyed || req.closed) {
        drainingOnly = true;
        continue;
      }
      if (value.byteLength === 0) continue;
      if (!req.write(value) && !shouldStopWriting() && !req.destroyed && !req.closed) {
        await new Promise<void>((onDrain) => {
          const doneWaiting = () => {
            onWakeSetter(null);
            req.off("drain", doneWaiting);
            req.off("close", doneWaiting);
            req.off("error", doneWaiting);
            onDrain();
          };
          onWakeSetter(doneWaiting);
          req.once("drain", doneWaiting);
          req.once("close", doneWaiting);
          req.once("error", doneWaiting);
        });
      }
    }
  } catch (err) {
    onError(err);
    if (!req.destroyed) {
      req.destroy(err instanceof Error ? err : new Error(String(err)));
    }
  } finally {
    onWakeSetter(null);
    onFinish();
    reader.releaseLock();
  }
}
