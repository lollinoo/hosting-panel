export function getApiInternalUrl(): string {
  return process.env.API_INTERNAL_URL || "http://127.0.0.1:4000";
}

export interface UpstreamRequestOptions {
  method?: string;
  accessToken?: string;
  idempotencyKey?: string | null;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface UpstreamResponse<T = unknown> {
  status: number;
  ok: boolean;
  data?: T;
  error?: unknown;
}

export async function fetchUpstream<T = unknown>(
  path: string,
  options: UpstreamRequestOptions = {}
): Promise<UpstreamResponse<T>> {
  const baseUrl = getApiInternalUrl();
  const url = `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;

  const headers: Record<string, string> = {
    Accept: "application/json",
    ...(options.headers || {}),
  };

  if (options.accessToken) {
    headers["Authorization"] = `Bearer ${options.accessToken}`;
  }

  if (options.idempotencyKey) {
    headers["Idempotency-Key"] = options.idempotencyKey;
  }

  let requestBody: string | undefined;
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    requestBody = JSON.stringify(options.body);
  }

  const signal = AbortSignal.timeout(8000);

  try {
    const res = await fetch(url, {
      method: options.method || "GET",
      headers,
      body: requestBody,
      cache: "no-store",
      redirect: "error",
      signal,
    });

    const contentType = res.headers.get("content-type") || "";
    let parsed: unknown = null;

    if (contentType.includes("application/json")) {
      parsed = await res.json();
    } else {
      const text = await res.text();
      parsed = text ? { raw: text } : null;
    }

    if (!res.ok) {
      return {
        status: res.status,
        ok: false,
        error: parsed,
      };
    }

    return {
      status: res.status,
      ok: true,
      data: parsed as T,
    };
  } catch (err: unknown) {
    const isTimeout = (err as Error)?.name === "TimeoutError";
    return {
      status: isTimeout ? 504 : 502,
      ok: false,
      error: {
        error: {
          code: isTimeout ? "INTERNAL_ERROR" : "OPERATION_AMBIGUOUS",
          message: isTimeout
            ? "Timeout di connessione con il servizio di controllo upstream"
            : "Impossibile comunicare con il piano di controllo upstream",
          requestId: "err-upstream-call",
          retryable: true,
          details: [],
        },
      },
    };
  }
}
