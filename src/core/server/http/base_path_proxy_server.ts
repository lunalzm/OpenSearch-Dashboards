/*
 * SPDX-License-Identifier: Apache-2.0
 *
 * The OpenSearch Contributors require contributions made to
 * this file be licensed under the Apache-2.0 license or a
 * compatible open source license.
 *
 * Any modifications Copyright OpenSearch Contributors. See
 * GitHub history for details.
 */

/*
 * Licensed to Elasticsearch B.V. under one or more contributor
 * license agreements. See the NOTICE file distributed with
 * this work for additional information regarding copyright
 * ownership. Elasticsearch B.V. licenses this file to you under
 * the Apache License, Version 2.0 (the "License"); you may
 * not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { Agent as HttpsAgent, ServerOptions as TlsOptions } from 'https';

import apm from 'elastic-apm-node';
import { ByteSizeValue } from '@osd/config-schema';
import { Server, Request } from '@hapi/hapi';
import HapiProxy from '@hapi/h2o2';
import { sampleSize } from 'lodash';
import * as Rx from 'rxjs';
import { take } from 'rxjs/operators';

import { DevConfig } from '../dev';
import { Logger } from '../logging';
import { HttpConfig } from './http_config';
import { createServer, getListenerOptions, getServerOptions } from './http_tools';

const alphabet = 'abcdefghijklmnopqrztuvwxyz'.split('');

export interface BasePathProxyServerOptions {
  shouldRedirectFromOldBasePath: (path: string) => boolean;
  delayUntil: () => Rx.Observable<void>;
}

export class BasePathProxyServer {
  private server?: Server;
  private httpsAgent?: HttpsAgent;

  public get basePath() {
    return this.httpConfig.basePath;
  }

  public get targetPort() {
    return this.devConfig.basePathProxyTargetPort;
  }

  constructor(
    private readonly log: Logger,
    private readonly httpConfig: HttpConfig,
    private readonly devConfig: DevConfig
  ) {
    const ONE_GIGABYTE = 1024 * 1024 * 1024;
    httpConfig.maxPayload = new ByteSizeValue(ONE_GIGABYTE);

    if (!httpConfig.basePath) {
      httpConfig.basePath = `/${sampleSize(alphabet, 3).join('')}`;
    }
  }

  public async start(options: Readonly<BasePathProxyServerOptions>) {
    this.log.debug('starting basepath proxy server');

    const serverOptions = getServerOptions(this.httpConfig);
    const listenerOptions = getListenerOptions(this.httpConfig);
    this.server = createServer(serverOptions, listenerOptions);

    // Register hapi plugin that adds proxying functionality. It can be configured
    // through the route configuration object (see { handler: { proxy: ... } }).
    await this.server.register([HapiProxy as any]);

    if (this.httpConfig.ssl.enabled) {
      const tlsOptions = serverOptions.tls as TlsOptions;
      this.httpsAgent = new HttpsAgent({
        ca: tlsOptions.ca,
        cert: tlsOptions.cert,
        key: tlsOptions.key,
        passphrase: tlsOptions.passphrase,
        rejectUnauthorized: false,
      });
    }

    this.setupRoutes(options);

    await this.server.start();

    this.log.info(
      `basepath proxy server running at ${this.server.info.uri}${this.httpConfig.basePath}`
    );
  }

  public async stop() {
    if (this.server === undefined) {
      return;
    }

    this.log.debug('stopping basepath proxy server');
    await this.server.stop();
    this.server = undefined;

    if (this.httpsAgent !== undefined) {
      this.httpsAgent.destroy();
      this.httpsAgent = undefined;
    }
  }

  private setupRoutes({
    delayUntil,
    shouldRedirectFromOldBasePath,
  }: Readonly<BasePathProxyServerOptions>) {
    if (this.server === undefined) {
      throw new Error(`Routes cannot be set up since server is not initialized.`);
    }

    // Always redirect from root URL to the URL with basepath.
    this.server.route({
      handler: (request, responseToolkit) => {
        return responseToolkit.redirect(this.httpConfig.basePath);
      },
      method: 'GET',
      path: '/',
    });

    this.server.route({
      handler: {
        proxy: {
          agent: this.httpsAgent,
          host: this.server.info.host,
          passThrough: true,
          port: this.devConfig.basePathProxyTargetPort,
          // typings mismatch. h2o2 doesn't support "socket"
          protocol: this.server.info.protocol as HapiProxy.ProxyHandlerOptions['protocol'],
          xforward: true,
        },
      },
      method: '*',
      options: {
        pre: [
          // Before we proxy request to a target port we may want to wait until some
          // condition is met (e.g. until target listener is ready).
          async (request, responseToolkit) => {
            apm.setTransactionName(`${request.method.toUpperCase()} /{basePath}/{osdPath*}`);
            await delayUntil().pipe(take(1)).toPromise();
            return responseToolkit.continue;
          },
        ],
        validate: { payload: true },
      },
      path: `${this.httpConfig.basePath}/{osdPath*}`,
    });

    this.server.route({
      handler: {
        proxy: {
          agent: this.httpsAgent,
          passThrough: true,
          xforward: true,
          mapUri: async (request: Request) => {
            const uri = new URL(
              `${this.httpConfig.basePath}/${request.params.osdPath}`,
              `${request.server.info.protocol}://${request.server.info.host}:${this.devConfig.basePathProxyTargetPort}`
            );
            uri.search = new URLSearchParams(request.query).toString();

            return {
              uri: uri.toString(),
              headers: request.headers,
            };
          },
        },
      },
      method: '*',
      options: {
        pre: [
          // Before we proxy request to a target port we may want to wait until some
          // condition is met (e.g. until target listener is ready).
          async (request, responseToolkit) => {
            await delayUntil().pipe(take(1)).toPromise();
            return responseToolkit.continue;
          },
        ],
        validate: { payload: true },
      },
      path: `/__UNSAFE_bypassBasePath/{osdPath*}`,
    });

    // It may happen that basepath has changed, but user still uses the old one,
    // so we can try to check if that's the case and just redirect user to the
    // same URL, but with valid basepath.
    this.server.route({
      handler: (request, responseToolkit) => {
        const { oldBasePath, osdPath = '' } = request.params;

        const isGet = request.method === 'get';
        const isBasepathLike = oldBasePath.length === 3;

        return isGet && isBasepathLike && shouldRedirectFromOldBasePath(osdPath)
          ? responseToolkit.redirect(`${this.httpConfig.basePath}/${osdPath}`)
          : responseToolkit.response('Not Found').code(404);
      },
      method: '*',
      path: `/{oldBasePath}/{osdPath*}`,
    });
  }
}
