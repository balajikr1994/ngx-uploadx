import { BackoffRetry } from './backoff_retry';
import { UploaderOptions, UploadItem, UploadState, UploadStatus } from './interfaces';
import { unfunc } from './utils';
const noop = () => {};

// default blocksize of most FSs
const MIN_CHUNK_SIZE = 4096;

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD';

/**
 * Uploader Base Class
 */
export abstract class Uploader {
  /**
   * Upload status
   */
  set status(s: UploadStatus) {
    if (
      s === this._status ||
      this._status === 'cancelled' ||
      (this._status === 'complete' && s !== 'cancelled')
    ) {
      return;
    }

    this._xhr && (s === 'cancelled' || s === 'paused') && this.abort();

    s === 'cancelled' && this.URI && this.onCancel();

    this._status = s;
    this.notifyState();
  }

  get status() {
    return this._status;
  }

  private get isMaxAttemptsReached(): boolean {
    return this.retry.retryAttempts === Uploader.maxRetryAttempts && this.statusType === 400;
  }
  /**
   * Max 4xx errors
   */
  static maxRetryAttempts = 3;
  /**
   * Limits max chunk size
   */
  static maxChunkSize = Number.MAX_SAFE_INTEGER;
  /**
   * Starting adaptive chunk size
   */
  static startingChunkSize = MIN_CHUNK_SIZE * 64;
  /**
   * Original File name
   */
  readonly name: string;
  /**
   * Size in bytes
   */
  readonly size: number;
  /**
   * File MIME type
   */
  readonly mimeType: string;
  readonly uploadId = Math.random()
    .toString(36)
    .substring(2, 15);
  /**
   * HTTP response status code
   */
  responseStatus: number;
  /**
   * Upload start time
   */
  private startTime: number;
  /**
   * Progress percentage
   */
  progress: number;
  /**
   * ETA
   */
  remaining: number;
  /**
   * Upload speed bytes/sec
   */
  speed: number;
  /**
   * File URI
   */
  URI: string;
  /**
   * Custom headers
   */
  headers: { [key: string]: string } | null;
  /**
   * Metadata Object
   */
  metadata: { [key: string]: any };
  /**
   * Upload endpoint
   */
  endpoint = '/upload';

  /**
   * Retries handler
   * @internal
   */
  protected retry = new BackoffRetry();
  /**
   * HTTP response body
   */
  response: any;
  /**
   * HTTP response status category
   * @internal
   */
  protected statusType: 200 | 300 | 400 | 500;
  /**
   * Chunk size in bytes
   */
  chunkSize: number;
  /**
   * Auth Bearer token/tokenGetter
   */
  token: string | (() => string);
  /**
   * Status  of uploader
   * @internal
   */
  private _status: UploadStatus;
  /**
   * Set HttpRequest responseType
   */
  protected responseType: XMLHttpRequestResponseType = '';
  /**
   * UploadState emitter
   */
  private stateChange: (evt: UploadState) => void;
  /**
   * Active HttpRequest
   * @internal
   */
  protected _xhr: XMLHttpRequest;
  /**
   * byte offset within the whole file
   * @internal
   */
  protected offset = 0;

  constructor(readonly file: File, public options: UploaderOptions) {
    this.name = file.name;
    this.size = file.size;
    this.mimeType = file.type || 'application/octet-stream';
    this.stateChange = options.stateChange || noop;
    this.chunkSize = options.chunkSize ? options.chunkSize : Uploader.startingChunkSize;
    this.configure(options);
  }
  /**
   * Configure or reconfigure uploader
   */
  configure(item = {} as UploadItem): void {
    const { metadata, headers, token, endpoint } = item;
    this.metadata = {
      name: this.name,
      mimeType: this.mimeType,
      size: this.size,
      lastModified: this.file.lastModified,
      ...unfunc(metadata || this.metadata, this.file)
    };
    this.endpoint = endpoint || this.endpoint;
    this.headers = { ...this.headers, ...unfunc(headers, this.file) };
    this.token = token || this.token;
  }

  /**
   * Initiate upload
   */
  async upload(item?: UploadItem): Promise<void> {
    if (item) {
      this.configure(item);
    }
    if (this.status === 'cancelled' || this.status === 'complete' || this.status === 'paused') {
      return;
    }
    this.status = 'uploading';
    this.refreshToken();
    try {
      this.URI = await this.getFileURI();
      this.retry.reset();
      this.startTime = new Date().getTime();
      this.start();
    } catch (e) {
      if (this.isMaxAttemptsReached) {
        this.status = 'error';
      } else {
        this.status = 'retry';
        await this.retry.wait(this.responseStatus);
        this.status = 'queue';
      }
    }
  }

  /**
   * Get file URI
   */
  protected abstract getFileURI(): Promise<string>;
  /**
   * Send file content
   */
  protected abstract sendFileContent(): Promise<number>;
  /**
   * Get offset for next request
   */
  protected abstract getOffset(): Promise<number>;

  /**
   * Emit current state
   */
  private notifyState(): void {
    const state: UploadState = {
      file: this.file,
      name: this.name,
      progress: this.progress,
      percentage: this.progress,
      remaining: this.remaining,
      response: this.response,
      responseStatus: this.responseStatus,
      size: this.size,
      speed: this.speed,
      status: this.status,
      uploadId: this.uploadId,
      URI: this.URI
    };

    this.stateChange(state);
  }
  /**
   * increases chunk size if request time is less than 1 sec
   * and decreases if more than 10 secs
   */
  private setChunkSize() {
    const t = this.chunkSize / this.speed;
    if (t < 1 && this.chunkSize < Uploader.maxChunkSize) {
      this.chunkSize *= 2;
      Uploader.startingChunkSize = this.chunkSize / 4;
    }
    if (t > 10 && this.chunkSize > MIN_CHUNK_SIZE) {
      this.chunkSize /= 2;
      Uploader.startingChunkSize = this.chunkSize * 2;
    }
  }

  protected abort() {
    this._xhr.abort();
  }

  protected onCancel() {
    this.request({ method: 'DELETE' });
  }
  /**
   *  Gets the value from response
   */
  protected getValueFromResponse(key: string): string {
    const value = this._xhr.getResponseHeader(key);
    if (!value) {
      throw new Error('Invalid Response');
    }
    return value;
  }

  /**
   * Set auth token
   */
  refreshToken(token?: any): void {
    this.token = token || this.token;
    if (this.token) {
      const _token = unfunc(this.token, this.responseStatus);
      this.headers = { ...this.headers, ...{ Authorization: `Bearer ${_token}` } };
    }
  }

  /**
   * Start uploading
   */
  async start() {
    while (this.status === 'uploading' || this.status === 'retry') {
      try {
        this.offset = isNaN(this.offset) ? await this.getOffset() : await this.sendFileContent();
        this.retry.reset();
        !this.options.chunkSize && this.setChunkSize();
        if (this.offset >= this.size) {
          this.progress = 100;
          this.status = 'complete';
        }
      } catch {
        if (this.responseStatus === 413) {
          this.chunkSize /= 2;
          Uploader.maxChunkSize = this.chunkSize;
        }
        this.offset = this.responseStatus ? undefined : this.offset;
        if (this.isMaxAttemptsReached) {
          this.status = 'error';
          break;
        }
        if (this.responseStatus === 404) {
          this.status = 'queue';
          break;
        }
        this.refreshToken();
        this.status = 'retry';
        const _ = await this.retry.wait(this.responseStatus);
        this.status = 'uploading';
      }
    }
  }

  /**
   * Request method
   */
  protected request({
    method,
    body = null,
    url,
    headers = {},
    progress = false
  }: {
    method: HttpMethod;
    body?: any;
    url?: string;
    headers?: { [key: string]: string };
    progress?: boolean;
  }): Promise<number> {
    return new Promise((resolve, reject) => {
      const xhr: XMLHttpRequest = new XMLHttpRequest();
      xhr.open(method.toUpperCase(), url || this.URI, true);
      if (progress && body) {
        xhr.upload.onprogress = this.onprogress((body as any).size);
      }
      this.setupXhr(xhr, headers);
      xhr.onload = () => {
        this.processResponse(xhr);
        this.statusType > 300 ? reject(this.responseStatus) : resolve(this.responseStatus);
      };
      xhr.onerror = () => {
        this.resetResponse();
        reject();
      };
      xhr.send(body);
    });
  }
  private setupXhr(xhr: XMLHttpRequest, headers?: any) {
    this._xhr = xhr;
    xhr.responseType = this.responseType;
    xhr.withCredentials = this.options.withCredentials;
    const _headers = { ...this.headers, ...headers };
    Object.keys(_headers).forEach(key => xhr.setRequestHeader(key, _headers[key]));
  }

  private resetResponse() {
    this.responseStatus = undefined;
    this.response = undefined;
    this.statusType = undefined;
  }

  private parseXhrResponse(xhr: XMLHttpRequest) {
    let body = 'response' in (xhr as any) ? xhr.response : xhr.responseText;
    if (this.responseType === 'json' && body && typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {}
    }
    return body;
  }

  private processResponse(xhr: XMLHttpRequest): void {
    this.response = this.parseXhrResponse(xhr);
    this.responseStatus = xhr.status === 0 && this.response ? 200 : xhr.status;
    this.statusType = (xhr.status - (this.responseStatus % 100)) as any;
  }

  private onprogress(chunkSize: number) {
    return (pEvent: ProgressEvent) => {
      const uploaded = pEvent.lengthComputable
        ? this.offset + chunkSize * (pEvent.loaded / pEvent.total)
        : this.offset;
      this.progress = +((uploaded / this.size) * 100).toFixed(2);
      const now = new Date().getTime();
      this.speed = Math.round((uploaded / (now - this.startTime)) * 1000);
      this.remaining = Math.ceil((this.size - uploaded) / this.speed);
      this.notifyState();
    };
  }
}
