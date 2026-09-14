import {
  ApiRequestError,
  httpError,
  invalidResponse,
  normalizeError,
  type ResponseMeta,
} from './apiError';

type RequestOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';
  body?: unknown;
  headers?: HeadersInit;
  signal?: AbortSignal;
  requiredHeaders?: Exclude<keyof ResponseMeta, 'status'>[];
};
type JsonOptions<T> = RequestOptions & { validateData: (data: unknown) => data is T };
export type ApiResponse<T> = { data: T; meta: ResponseMeta };

export function createHttpClient(baseUrl: string, fetcher: typeof fetch = globalThis.fetch) {
  const base = baseUrl.replace(/\/+$/, '');

  function request<T>(path: string, options: JsonOptions<T>): Promise<ApiResponse<T>>;
  function request(
    path: string,
    options: RequestOptions & { responseType: 'empty' },
  ): Promise<ApiResponse<undefined>>;
  async function request<T>(
    path: string,
    options: RequestOptions & {
      validateData?: (data: unknown) => data is T;
      responseType?: 'empty';
    },
  ): Promise<ApiResponse<T | undefined>> {
    let headers: Headers;
    let json: string | undefined;
    try {
      headers = new Headers({ Accept: 'application/json' });
      new Headers(options.headers).forEach((value, name) => headers.set(name, value));
      if (options.body !== undefined) {
        headers.set('Content-Type', 'application/json');
        json = JSON.stringify(options.body);
        if (json === undefined) throw new Error('JSON body is undefined');
      }
    } catch (error) {
      throw new ApiRequestError(
        'Не удалось подготовить запрос.',
        'request',
        'INVALID_REQUEST',
        undefined,
        error,
      );
    }

    try {
      const method = options.method ?? 'GET';
      const response = await fetcher(`${base}${path}`, {
        method,
        headers,
        body: json,
        signal: options.signal,
        credentials: 'omit',
        cache: 'no-store',
      });
      const meta: ResponseMeta = {
        status: response.status,
        etag: response.headers.get('ETag'),
        location: response.headers.get('Location'),
        retryAfter: response.headers.get('Retry-After'),
        requestId: response.headers.get('X-Request-Id'),
      };
      // У HEAD, 204 и 304 нет тела; они не требуют JSON parsing.
      const noBody = method === 'HEAD' || response.status === 204 || response.status === 304;
      const text = noBody ? '' : await response.text();
      let body: unknown;
      let malformed = false;
      if (text.trim()) {
        try {
          body = JSON.parse(text);
        } catch {
          malformed = true;
        }
      }

      if (!response.ok && response.status !== 304) throw httpError(meta, body);
      if (malformed || options.requiredHeaders?.some((header) => !meta[header])) {
        throw invalidResponse(meta);
      }
      if (options.responseType === 'empty') {
        if (text.trim()) throw invalidResponse(meta);
        return { data: undefined, meta };
      }
      if (!options.validateData?.(body)) throw invalidResponse(meta);
      return { data: body, meta };
    } catch (error) {
      throw normalizeError(error, options.signal);
    }
  }

  // И запросы, и относительные адреса assets используют один API base URL.
  return { request, resolveUrl: (path: string) => `${base}${path}` };
}

export type HttpClient = ReturnType<typeof createHttpClient>;
