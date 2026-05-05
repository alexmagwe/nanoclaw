/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the API.
 * The proxy injects real credentials so containers never see them.
 *
 * Auth modes:
 *   API key:  Proxy injects x-api-key on every request.
 *   OAuth:    Container CLI exchanges its placeholder token for a temp
 *             API key via /api/oauth/claude_cli/create_api_key.
 *             Proxy injects real OAuth token on that exchange request;
 *             subsequent requests carry the temp key which is valid as-is.
 *             On 401, the proxy refreshes the token from the macOS keychain
 *             and retries the request once.
 *   DeepSeek: When DEEPSEEK_MODE is true, proxies to DeepSeek's
 *             Anthropic-compatible API (api.deepseek.com/anthropic).
 *             Injects DEEPSEEK_API_KEY and strips unsupported content
 *             block types (redacted_thinking, image, etc.).
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';

import { readEnvFile } from './env.js';
import { DEEPSEEK_MODE } from './config.js';
import { logger } from './logger.js';

export type AuthMode = 'api-key' | 'oauth' | 'passthrough';

export interface ProxyConfig {
  authMode: AuthMode;
}

/**
 * Refresh the OAuth token from the macOS keychain and update .env.
 * Returns the new token, or null if unavailable.
 */
function readKeychainToken(): { accessToken: string; expiresAt: number } | null {
  try {
    const raw = execSync("security find-generic-password -s 'Claude Code-credentials' -w", {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const oauth = JSON.parse(raw)?.claudeAiOauth;
    if (!oauth?.accessToken) return null;
    return { accessToken: oauth.accessToken, expiresAt: oauth.expiresAt || 0 };
  } catch {
    return null;
  }
}

function updateEnvToken(token: string): void {
  const envPath = path.join(process.cwd(), '.env');
  const current = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';
  const updated = current.includes('CLAUDE_CODE_OAUTH_TOKEN=')
    ? current.replace(/^CLAUDE_CODE_OAUTH_TOKEN=.*/m, `CLAUDE_CODE_OAUTH_TOKEN=${token}`)
    : current + `\nCLAUDE_CODE_OAUTH_TOKEN=${token}\n`;
  fs.writeFileSync(envPath, updated);
}

export function refreshOAuthTokenFromKeychain(): string | null {
  try {
    const keychain = readKeychainToken();
    if (!keychain) return null;

    const isExpired = keychain.expiresAt < Date.now();

    if (isExpired) {
      // Token is expired — trigger claude CLI to refresh it via OAuth refresh token
      logger.info('Keychain token expired, triggering claude CLI refresh');
      try {
        execSync('claude -p "." --output-format json', {
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 30000,
        });
      } catch {
        logger.warn('claude CLI refresh failed');
      }
      // Re-read the (hopefully refreshed) token
      const refreshed = readKeychainToken();
      if (!refreshed) return null;
      updateEnvToken(refreshed.accessToken);
      logger.info('OAuth token refreshed via claude CLI');
      return refreshed.accessToken;
    }

    updateEnvToken(keychain.accessToken);
    logger.info('OAuth token refreshed from keychain');
    return keychain.accessToken;
  } catch {
    logger.debug('Keychain token refresh skipped (not macOS or not available)');
    return null;
  }
}

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'DEEPSEEK_API_KEY',
  ]);

  const authMode: AuthMode = DEEPSEEK_MODE
    ? 'api-key'
    : secrets.ANTHROPIC_API_KEY
      ? 'api-key'
      : 'oauth';
  let oauthToken: string | undefined =
    secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;

  const defaultUpstream = DEEPSEEK_MODE
    ? 'https://api.deepseek.com/anthropic'
    : 'https://api.anthropic.com';
  const upstreamUrl = new URL(
    secrets.ANTHROPIC_BASE_URL || defaultUpstream,
  );
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  /**
   * Strip content blocks that DeepSeek's Anthropic API doesn't support.
   * - redacted_thinking: DeepSeek requires real reasoning_content, not placeholders
   * - image, document, search_result: unsupported content types
   * Also strips cache_control from content blocks and tools.
   */
  function cleanRequestForDeepseek(body: Buffer): Buffer {
    try {
      const parsed = JSON.parse(body.toString());

      if (parsed.messages && Array.isArray(parsed.messages)) {
        for (const msg of parsed.messages) {
          if (Array.isArray(msg.content)) {
            msg.content = msg.content.filter(
              (block: { type: string }) =>
                !['redacted_thinking', 'image', 'document', 'search_result'].includes(
                  block.type,
                ),
            );
            for (const block of msg.content) {
              delete block.cache_control;
            }
          }
        }
      }

      if (parsed.tools && Array.isArray(parsed.tools)) {
        for (const tool of parsed.tools) {
          delete tool.cache_control;
        }
      }

      return Buffer.from(JSON.stringify(parsed));
    } catch {
      return body;
    }
  }

  function injectAuth(
    headers: Record<string, string | number | string[] | undefined>,
    token: string | undefined,
  ): void {
    if (authMode === 'api-key') {
      delete headers['x-api-key'];
      headers['x-api-key'] = DEEPSEEK_MODE
        ? secrets.DEEPSEEK_API_KEY
        : secrets.ANTHROPIC_API_KEY;
    } else {
      if (headers['authorization']) {
        delete headers['authorization'];
        if (token) {
          headers['authorization'] = `Bearer ${token}`;
          // Ensure the oauth beta flag is present so Anthropic accepts Bearer tokens directly
          const existingBeta = (headers['anthropic-beta'] as string) || '';
          if (!existingBeta.includes('oauth-2025-04-20')) {
            headers['anthropic-beta'] = existingBeta
              ? `${existingBeta},oauth-2025-04-20`
              : 'oauth-2025-04-20';
          }
        }
      }
    }
  }

  function proxyRequest(
    body: Buffer,
    headers: Record<string, string | number | string[] | undefined>,
    req: import('http').IncomingMessage,
    res: import('http').ServerResponse,
    token: string | undefined,
    retry: boolean,
  ): void {
    injectAuth(headers, token);

    const upstream = makeRequest(
      {
        hostname: upstreamUrl.hostname,
        port: upstreamUrl.port || (isHttps ? 443 : 80),
        path: upstreamUrl.pathname.replace(/\/$/, '') + (req.url || '/'),
        method: req.method,
        headers,
      } as RequestOptions,
      (upRes) => {
        logger.info({ status: upRes.statusCode, path: req.url, method: req.method }, 'Proxy response');

        // On 401 in OAuth mode, refresh token and retry once
        if (upRes.statusCode === 401 && authMode === 'oauth' && retry) {
          // Drain the response body before retrying
          upRes.resume();
          logger.warn('OAuth 401 received, refreshing token and retrying');
          const newToken = refreshOAuthTokenFromKeychain();
          if (newToken) {
            oauthToken = newToken;
            // Re-build headers (injectAuth mutates them)
            const retryHeaders: Record<string, string | number | string[] | undefined> = {
              ...(req.headers as Record<string, string>),
              host: upstreamUrl.host,
              'content-length': body.length,
            };
            delete retryHeaders['connection'];
            delete retryHeaders['keep-alive'];
            delete retryHeaders['transfer-encoding'];
            proxyRequest(body, retryHeaders, req, res, newToken, false);
          } else {
            // Can't refresh — pass 401 through
            res.writeHead(upRes.statusCode!, upRes.headers);
            upRes.pipe(res);
          }
          return;
        }

        res.writeHead(upRes.statusCode!, upRes.headers);
        upRes.pipe(res);
      },
    );

    upstream.on('error', (err) => {
      logger.error({ err, url: req.url }, 'Credential proxy upstream error');
      if (!res.headersSent) {
        res.writeHead(502);
        res.end('Bad Gateway');
      }
    });

    upstream.write(body);
    upstream.end();
  }

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        let body: Buffer = Buffer.concat(chunks);
        logger.info({ method: req.method, path: req.url, bodyLen: body.length }, 'Proxy request');
        if (DEEPSEEK_MODE) {
          const beforeLen = body.length;
          body = cleanRequestForDeepseek(body);
          if (body.length !== beforeLen) {
            logger.info({ before: beforeLen, after: body.length }, 'Cleaned DeepSeek request');
          }
        }
        const headers: Record<string, string | number | string[] | undefined> = {
          ...(req.headers as Record<string, string>),
          host: upstreamUrl.host,
          'content-length': body.length,
        };

        delete headers['connection'];
        delete headers['keep-alive'];
        delete headers['transfer-encoding'];

        proxyRequest(body, headers, req, res, oauthToken, true);
      });
    });

    server.listen(port, host, () => {
      logger.info({ port, host, authMode }, 'Credential proxy started');
      resolve(server);
    });

    server.on('error', reject);
  });
}

/** Detect which auth mode the host is configured for. */
export function detectAuthMode(): AuthMode {
  // DeepSeek mode: use api-key placeholder so the SDK sends x-api-key
  // headers, which the proxy replaces with DEEPSEEK_API_KEY.
  if (DEEPSEEK_MODE) return 'api-key';
  const secrets = readEnvFile(['ANTHROPIC_API_KEY']);
  return secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
}
