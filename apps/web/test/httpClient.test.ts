import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiRequestError } from '../src/api/apiError';
import { createHttpClient } from '../src/api/httpClient';
import { isGraph } from '../src/api/responseSchemas';
import { etag, graphFixture, jsonResponse } from './fixtures';

test('общий transport готовит JSON, method, headers, signal и возвращает ресурс с metadata', async () => {
  const graph = graphFixture();
  const controller = new AbortController();
  const fetcher: typeof fetch = async (url, init) => {
    assert.equal(url, 'http://api.local/api/example');
    assert.equal(init?.method, 'PUT');
    assert.equal(init?.body, JSON.stringify(graph));
    assert.equal(init?.signal, controller.signal);
    assert.equal(init?.credentials, 'omit');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('Accept'), 'application/json');
    assert.equal(headers.get('Content-Type'), 'application/json');
    assert.equal(headers.get('If-Match'), etag);
    assert.equal(headers.get('X-Example'), 'extra');
    return jsonResponse(graph, 200, {
      ETag: etag,
      Location: '/api/example',
      'Retry-After': '1',
      'X-Request-Id': 'req-123',
    });
  };
  const result = await createHttpClient('http://api.local/', fetcher).request('/api/example', {
    method: 'PUT',
    body: graph,
    headers: { 'If-Match': etag, 'X-Example': 'extra' },
    signal: controller.signal,
    validateData: isGraph,
  });
  assert.deepEqual(result.data, graph);
  assert.deepEqual(result.meta, {
    status: 200,
    etag,
    location: '/api/example',
    retryAfter: '1',
    requestId: 'req-123',
  });
  assert.equal('headers' in result, false);
});

test('204, HEAD, 304 и пустой 200 не вызывают JSON parsing в режиме empty', async () => {
  for (const [status, method] of [
    [204, 'OPTIONS'],
    [200, 'HEAD'],
    [304, 'GET'],
    [200, 'GET'],
  ] as const) {
    const client = createHttpClient(
      '',
      async () => new Response(null, { status, headers: { ETag: etag } }),
    );
    const result = await client.request('/api/example', { method, responseType: 'empty' });
    assert.equal(result.data, undefined);
    assert.equal(result.meta.status, status);
    assert.equal(result.meta.etag, etag);
  }
});

test('ошибки HTTP сохраняют code/message/status/requestId даже при HTML или пустом ответе', async () => {
  const client = createHttpClient('', async () =>
    jsonResponse({ error: { code: 'SPACE_NOT_FOUND', message: 'Нет пространства.' } }, 404, {
      'X-Request-Id': 'req-404',
    }),
  );
  await assert.rejects(
    client.request('/api/example', { validateData: isGraph }),
    (error: unknown) => {
      assert.ok(error instanceof ApiRequestError);
      assert.equal(error.kind, 'http');
      assert.equal(error.code, 'SPACE_NOT_FOUND');
      assert.equal(error.message, 'Нет пространства.');
      assert.equal(error.meta?.status, 404);
      assert.equal(error.meta?.requestId, 'req-404');
      return true;
    },
  );
  for (const body of ['<html>bad gateway</html>', '']) {
    const fallback = createHttpClient('', async () => new Response(body, { status: 502 }));
    await assert.rejects(
      fallback.request('/api/example', { validateData: isGraph }),
      (error: unknown) => {
        assert.ok(error instanceof ApiRequestError);
        assert.equal(error.kind, 'http');
        assert.equal(error.code, 'HTTP_ERROR');
        assert.equal(error.meta?.status, 502);
        return true;
      },
    );
  }
});

test('невалидный JSON, неверная схема, пустой ресурс и отсутствующий ETag нормализованы', async () => {
  for (const response of [
    new Response('{', { status: 200 }),
    jsonResponse({ data: graphFixture() }),
    new Response(null, { status: 204 }),
    jsonResponse({ nodes: [], edges: [] }),
  ]) {
    const client = createHttpClient('', async () => response);
    await assert.rejects(client.request('/api/example', { validateData: isGraph }), {
      kind: 'invalid-response',
      code: 'INVALID_RESPONSE',
    });
  }
  const client = createHttpClient('', async () => jsonResponse(graphFixture()));
  await assert.rejects(
    client.request('/api/example', { validateData: isGraph, requiredHeaders: ['etag'] }),
    { kind: 'invalid-response' },
  );
  await assert.rejects(client.request('/api/example', { responseType: 'empty' }), {
    kind: 'invalid-response',
  });
});

test('сбой fetch, чтения тела и cancellation имеют разные нормализованные исходы', async () => {
  const offline = createHttpClient('', async () => {
    throw new TypeError('offline');
  });
  await assert.rejects(offline.request('/api/example', { validateData: isGraph }), {
    kind: 'network',
    code: 'NETWORK_ERROR',
  });
  const brokenStream = createHttpClient(
    '',
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new TypeError('connection lost'));
          },
        }),
      ),
  );
  await assert.rejects(brokenStream.request('/api/example', { validateData: isGraph }), {
    kind: 'network',
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    offline.request('/api/example', { signal: controller.signal, validateData: isGraph }),
    { kind: 'aborted', code: 'ABORTED' },
  );
});

test('неподготовленный JSON не отправляется в сеть и не считается network error', async () => {
  let calls = 0;
  const client = createHttpClient('', async () => {
    calls++;
    return jsonResponse(graphFixture());
  });
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  await assert.rejects(
    client.request('/api/example', { method: 'POST', body: circular, validateData: isGraph }),
    { kind: 'request', code: 'INVALID_REQUEST' },
  );
  assert.equal(calls, 0);
});
